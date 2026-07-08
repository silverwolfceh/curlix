"""Admin authentication and admin-only endpoints for Curlix v2."""

import json
import hashlib
import secrets
from fastapi import APIRouter, Request, HTTPException
from pydantic import BaseModel
from typing import Optional

from db import (
    get_settings, save_settings, get_all_users, update_user_role,
    delete_user, create_user, ensure_user, rename_user, ensure_user_sync,
    list_requests, get_request, create_request, update_request, delete_request,
    list_history, delete_history_entry, clear_history, add_history,
    list_env_vars, save_env_vars, delete_env_var,
    list_collections, create_collection, update_collection, delete_collection,
)
import uuid

async def _get_user_id(request: Request) -> str:
    """Resolve user_id for admin-protected routes."""
    user_id = request.cookies.get("opm_uid")
    if not user_id:
        header = request.headers.get("x-user-id", "")
        if header:
            user_id = header
    if not user_id:
        user_id = str(uuid.uuid4())
    resolved = ensure_user_sync(user_id)
    if resolved:
        user_id = resolved
    ensure_user(user_id)
    request.state.user_id = user_id
    return user_id

router = APIRouter()

# ── Auth helpers ───────────────────────────────────────────────────────────────

def _hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    h = hashlib.sha256((salt + password).encode()).hexdigest()
    return f"{salt}${h}"


def _verify_password(stored: str, password: str) -> bool:
    try:
        salt, h = stored.split("$", 1)
        return hashlib.sha256((salt + password).encode()).hexdigest() == h
    except Exception:
        return False


# Simple token system — stored in settings under "admin_tokens"
def _get_active_tokens():
    settings = get_settings()
    return settings.get("admin_tokens", {})


def _save_active_tokens(tokens):
    settings = get_settings()
    settings["admin_tokens"] = tokens
    save_settings(settings)


def _issue_token(username):
    """Issue a session token for an admin user. Returns (token, expires_in)."""
    token = secrets.token_hex(32)
    tokens = _get_active_tokens()
    tokens[token] = {
        "username": username,
        "created": _now_iso(),
        "expires": _now_iso_add_hours(24),
    }
    _save_active_tokens(tokens)
    return token


def _invalidate_token(token):
    tokens = _get_active_tokens()
    tokens.pop(token, None)
    _save_active_tokens(tokens)


def _validate_token(token):
    tokens = _get_active_tokens()
    if token in tokens:
        entry = tokens[token]
        if _is_expired(entry.get("expires", "")):
            _invalidate_token(token)
            return None
        return entry
    return None


def _now_iso():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def _now_iso_add_hours(n):
    from datetime import datetime, timezone, timedelta
    return (datetime.now(timezone.utc) + timedelta(hours=n)).isoformat()


def _is_expired(iso_str):
    try:
        from datetime import datetime, timezone
        exp = datetime.fromisoformat(iso_str)
        return datetime.now(timezone.utc) > exp
    except Exception:
        return False


def _get_admin_from_request(request: Request) -> Optional[dict]:
    """Extract admin session from cookie or Authorization header."""
    token = request.cookies.get("opm_admin_token")
    if not token:
        auth = request.headers.get("authorization", "")
        if auth.startswith("Bearer "):
            token = auth[7:]
    if token:
        return _validate_token(token)
    return None


# ── Models ─────────────────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    username: str
    password: str


class RenameRequest(BaseModel):
    handle: str


class SwitchDeviceRequest(BaseModel):
    identity: str


class UserCreateRequest(BaseModel):
    username: str
    password: str
    role: str = "user"


class UserUpdateRequest(BaseModel):
    role: Optional[str] = None
    password: Optional[str] = None


class AdminUserUpdateRequest(BaseModel):
    role: str


class EnvVarsRequest(BaseModel):
    vars: list


class HistoryRequest(BaseModel):
    user_id: str
    name: Optional[str] = None
    method: str = "GET"
    url: str
    request_headers: dict = {}
    request_body: str = ""
    response_status: int = 0
    response_headers: dict = {}
    response_body: str = ""


# ── Non-admin endpoints (need user_id only) ────────────────────────────────────

@router.post("/api/user/rename")
async def user_rename(request: Request, body: RenameRequest):
    """User renames their identity handle."""
    handle = body.handle.strip()
    if len(handle) < 3:
        raise HTTPException(400, "Handle must be at least 3 characters")
    if not handle.replace("_", "").replace("-", "").isalnum():
        raise HTTPException(400, "Handle can only contain letters, numbers, underscores, hyphens")

    user_id = request.state.user_id
    ensure_user(user_id)
    try:
        rename_user(user_id, handle)
        return {"ok": True, "handle": handle}
    except Exception as e:
        if "UNIQUE constraint" in str(e):
            raise HTTPException(409, "Handle already taken")
        raise HTTPException(500, str(e))


@router.post("/api/switch-device")
async def switch_device(request: Request, body: SwitchDeviceRequest):
    """Switch to a different device by UUID or alias."""
    identity = body.identity.strip()
    resolved = ensure_user_sync(identity)
    if not resolved:
        raise HTTPException(404, "Identity not found. Creating new user instead.")

    # Auto-create if doesn't exist
    ensure_user(resolved)

    from fastapi.responses import JSONResponse
    resp = JSONResponse({"ok": True, "user_id": resolved})
    resp.set_cookie(
        key="opm_uid",
        value=resolved,
        path="/",
        httponly=True,
        samesite="lax",
        max_age=365 * 24 * 3600,
    )
    return resp


@router.get("/api/user/info")
async def user_info(request: Request):
    """Get current user info (id + alias)."""
    await _get_user_id(request)
    user_id = request.state.user_id
    from db import get_db
    conn = get_db()
    alias = conn.execute(
        "SELECT handle FROM user_aliases WHERE user_id = ?", (user_id,)
    ).fetchone()
    conn.close()
    return {"user_id": user_id, "handle": alias["handle"] if alias else user_id}


@router.get("/api/saved-requests")
async def get_saved_requests(request: Request):
    await _get_user_id(request)
    return list_requests(request.state.user_id)


@router.post("/api/saved-requests")
async def create_saved_request(request: Request, data: dict):
    await _get_user_id(request)
    rid = create_request(
        request.state.user_id,
        name=data.get("name", ""),
        method=data.get("method", "GET"),
        url=data.get("url", ""),
        headers=data.get("headers", {}),
        body=data.get("body", ""),
        tags=data.get("tags"),
        cookies=data.get("cookies", {}),
        ai_desc=data.get("ai_desc", ""),
    )
    return {"id": rid}


@router.get("/api/saved-requests/{req_id}")
async def get_saved_request(request: Request, req_id: int):
    await _get_user_id(request)
    return get_request(request.state.user_id, req_id)


@router.put("/api/saved-requests/{req_id}")
async def update_saved_request(request: Request, req_id: int, data: dict):
    await _get_user_id(request)
    update_request(
        request.state.user_id, req_id,
        name=data.get("name", ""),
        method=data.get("method", "GET"),
        url=data.get("url", ""),
        headers=data.get("headers", {}),
        body=data.get("body", ""),
        tags=data.get("tags"),
        cookies=data.get("cookies", {}),
        ai_desc=data.get("ai_desc", ""),
    )
    return {"ok": True}


@router.delete("/api/saved-requests/{req_id}")
async def delete_saved_request(request: Request, req_id: int):
    await _get_user_id(request)
    delete_request(request.state.user_id, req_id)
    return {"ok": True}


@router.get("/api/history")
async def get_history(request: Request, limit: int = 100, offset: int = 0):
    await _get_user_id(request)
    return list_history(request.state.user_id, limit, offset)


@router.post("/api/history")
async def add_history_api(request: Request, data: dict):
    await _get_user_id(request)
    add_history(
        request.state.user_id,
        data.get("name") or "",
        data.get("method") or "GET",
        data.get("url") or "",
        data.get("request_headers") or "{}",
        data.get("request_body") or "",
        data.get("response_status") or 0,
        data.get("response_headers") or "{}",
        data.get("response_body") or "",
        data.get("request_cookies") or "{}",
    )
    return {"ok": True}


@router.delete("/api/history")
async def clear_user_history(request: Request):
    await _get_user_id(request)
    clear_history(request.state.user_id)
    return {"ok": True}


@router.delete("/api/history/{h_id}")
async def delete_history_entry_api(request: Request, h_id: int):
    await _get_user_id(request)
    delete_history_entry(request.state.user_id, h_id)
    return {"ok": True}


@router.get("/api/env-vars")
async def get_env_vars(request: Request):
    await _get_user_id(request)
    return list_env_vars(request.state.user_id)


@router.put("/api/env-vars")
async def save_env_vars_api(request: Request, body: EnvVarsRequest):
    await _get_user_id(request)
    save_env_vars(request.state.user_id, body.vars)
    return {"ok": True}


@router.delete("/api/env-vars/{env_id}")
async def delete_env_var_api(request: Request, env_id: int):
    await _get_user_id(request)
    delete_env_var(request.state.user_id, env_id)
    return {"ok": True}


@router.get("/api/collections")
async def get_collections(request: Request):
    await _get_user_id(request)
    return list_collections(request.state.user_id)


@router.post("/api/collections")
async def create_collection_api(request: Request, data: dict):
    await _get_user_id(request)
    cid = create_collection(
        request.state.user_id,
        name=data.get("name", ""),
        request_ids=data.get("request_ids"),
    )
    return {"id": cid}


@router.put("/api/collections/{c_id}")
async def update_collection_api(request: Request, c_id: int, data: dict):
    await _get_user_id(request)
    update_collection(
        request.state.user_id, c_id,
        name=data.get("name", ""),
        request_ids=data.get("request_ids"),
    )
    return {"ok": True}


@router.delete("/api/collections/{c_id}")
async def delete_collection_api(request: Request, c_id: int):
    await _get_user_id(request)
    delete_collection(request.state.user_id, c_id)
    return {"ok": True}


# ── Admin endpoints (require auth) ────────────────────────────────────────────

@router.post("/api/login")
async def login(request: LoginRequest):
    """Login as admin. Returns JWT-like token."""
    username = request.username.strip().lower()
    password = request.password

    # Check admin credentials from settings
    settings = get_settings()
    admin = settings.get("admin", {})
    if admin.get("username") == username and _verify_password(admin.get("password_hash", ""), password):
        token = _issue_token(username)
        from fastapi.responses import JSONResponse
        resp = JSONResponse({"ok": True, "username": username, "token": token})
        resp.set_cookie("opm_admin_token", token, path="/", httponly=True, samesite="lax")
        return resp
    raise HTTPException(401, "Invalid credentials")


@router.post("/api/logout")
async def logout(request: Request):
    """Logout admin."""
    token = request.cookies.get("opm_admin_token")
    if token:
        _invalidate_token(token)
    from fastapi.responses import JSONResponse
    resp = JSONResponse({"ok": True})
    resp.delete_cookie("opm_admin_token", path="/")
    return resp


@router.get("/api/admin/check")
async def admin_check(request: Request):
    """Check if current session is admin."""
    admin = _get_admin_from_request(request)
    if admin:
        return {"admin": True, "username": admin["username"]}
    return {"admin": False}


@router.get("/api/settings")
async def get_settings_admin(request: Request):
    """Get settings.

    Admin: full settings (minus tokens). Non-admin: safe subset only —
    AI config + boolean key-present flag, never the key value itself.
    Lets homepage render AI hint without exposing the admin-configured key.
    """
    settings = get_settings()
    admin = _get_admin_from_request(request)
    if admin:
        settings.pop("admin_tokens", None)
        return settings

    ai_key = settings.get("ai_key") or settings.get("ai-key") or ""
    return {
        "ai_base": settings.get("ai_base") or settings.get("ai-base") or "",
        "ai_key_set": bool(ai_key),
        "ai_model": settings.get("ai_model") or settings.get("ai-model") or "gpt-4o-mini",
        "ai_call": settings.get("ai_call") or settings.get("ai-call") or "responses",
        "ai_response_style": settings.get("ai_response_style") or settings.get("ai-response-style") or "strict_json",
        "proxy_url": settings.get("proxy_url") or "",
        "proxy_user": settings.get("proxy_user") or "",
        "proxy_pass": settings.get("proxy_pass") or "",
    }


@router.post("/api/settings")
async def save_settings_admin(request: Request, data: dict):
    """Save settings (admin only)."""
    admin = _get_admin_from_request(request)
    if not admin:
        raise HTTPException(403, "Admin access required")

    # Special: saving admin credentials
    if "admin_username" in data or "admin_password" in data:
        current = get_settings().get("admin", {}) or {}
        new_username = data.get("admin_username") or current.get("username") or "admin"
        new_password = data.get("admin_password") or ""
        pw_hash = _hash_password(new_password) if new_password else current.get("password_hash", "")
        settings = get_settings()
        settings["admin"] = {"username": new_username, "password_hash": pw_hash}
        settings["admin_tokens"] = _get_active_tokens()
        if "admin_username" in data:
            settings.pop("admin_username", None)
        if "admin_password" in data:
            settings.pop("admin_password", None)
        save_settings(settings)
        return {"ok": True}

    # Normal settings
    settings = get_settings()
    for k, v in data.items():
        if k in ("admin_username", "admin_password"):
            continue
        if isinstance(v, (dict, list)):
            import json as _json
            settings[k] = _json.dumps(v)
        else:
            settings[k] = v
    save_settings(settings)
    return {"ok": True}


@router.get("/api/admin/users")
async def list_users_admin(request: Request):
    admin = _get_admin_from_request(request)
    if not admin:
        raise HTTPException(403, "Admin access required")
    return get_all_users()


@router.post("/api/admin/users")
async def create_user_admin(request: Request, data: UserCreateRequest):
    admin = _get_admin_from_request(request)
    if not admin:
        raise HTTPException(403, "Admin access required")

    user_id = f"user_{data.username}"  # Simple hash-based ID
    import hashlib
    user_id = hashlib.sha256(data.username.encode()).hexdigest()[:16]

    pw_hash = _hash_password(data.password)
    settings = get_settings()
    settings.setdefault("admin_users", {})
    settings["admin_users"][user_id] = {
        "username": data.username,
        "password_hash": pw_hash,
        "role": data.role,
    }
    save_settings(settings)

    create_user(user_id, data.role)
    return {"ok": True, "user_id": user_id}


@router.put("/api/admin/users/{user_id}")
async def update_user_admin(request: Request, user_id: str, data: UserUpdateRequest):
    admin = _get_admin_from_request(request)
    if not admin:
        raise HTTPException(403, "Admin access required")

    settings = get_settings()
    admins = settings.get("admin_users", {})
    if user_id not in admins:
        raise HTTPException(404, "Admin user not found")

    if data.role:
        admins[user_id]["role"] = data.role
        update_user_role(user_id, data.role)
    if data.password:
        admins[user_id]["password_hash"] = _hash_password(data.password)

    settings["admin_users"] = admins
    save_settings(settings)
    return {"ok": True}


@router.delete("/api/admin/users/{user_id}")
async def delete_user_admin(request: Request, user_id: str):
    admin = _get_admin_from_request(request)
    if not admin:
        raise HTTPException(403, "Admin access required")
    delete_user(user_id)
    return {"ok": True}


# ── Migration ─────────────────────────────────────────────────────────────────

@router.post("/api/import-localstorage")
async def import_localstorage(request: Request, data: dict):
    """Import data from browser localStorage dump."""
    await _get_user_id(request)
    user_id = request.state.user_id
    ensure_user(user_id)

    import_data = data.get("data", {})

    # Migrate settings
    if "curlix:ai-base" in import_data:
        settings = get_settings()
        ai_settings = {}
        for prefix in ("ai-base", "ai-key", "ai-model", "ai-call", "ai-style"):
            val = import_data.get(f"curlix:{prefix}")
            if val:
                key = prefix.replace("-", "_")
                ai_settings[key] = val
        if ai_settings:
            settings["ai"] = ai_settings
            save_settings(settings)

    # Migrate proxy settings
    proxy_settings = {}
    for key_suffix in ("proxy-url", "proxy-user", "proxy-pass"):
        val = import_data.get(f"curlix:{key_suffix}")
        if val:
            key = key_suffix.replace("-", "_")
            proxy_settings[key] = val
    if proxy_settings:
        settings = get_settings()
        settings["proxy"] = proxy_settings
        save_settings(settings)

    # Migrate env vars
    raw_env = import_data.get("curlix:env")
    if raw_env:
        try:
            env_list = json.loads(raw_env) if isinstance(raw_env, str) else raw_env
            save_env_vars(user_id, env_list)
        except (json.JSONDecodeError, TypeError):
            pass

    # Migrate saved requests
    raw_requests = import_data.get("curlix:saved")
    if raw_requests:
        try:
            req_list = json.loads(raw_requests) if isinstance(raw_requests, str) else raw_requests
            for req in req_list:
                create_request(
                    user_id,
                    name=req.get("name", ""),
                    method=req.get("method", "GET"),
                    url=req.get("url", ""),
                    headers=req.get("headers", {}),
                    body=req.get("body", ""),
                )
        except (json.JSONDecodeError, TypeError):
            pass

    return {"ok": True, "migrated": True}