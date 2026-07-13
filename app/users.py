"""Users router: admin user management and localStorage migration
(/api/import-localstorage — account session required; settings write admin-only).
"""
import json
import hashlib

from fastapi import APIRouter, Request, HTTPException

from .db import (
    get_settings, save_settings, get_all_users, update_user_role,
    delete_user, create_user, create_request, save_env_vars,
)
from .auth import get_user_id, get_admin_from_request, hash_password
from .models import UserCreateRequest, UserUpdateRequest

router = APIRouter()


# ── Admin user management ────────────────────────────────────────────────────

@router.get("/api/admin/users")
async def list_users_admin(request: Request):
    if not get_admin_from_request(request):
        raise HTTPException(403, "Admin access required")
    return get_all_users()


@router.post("/api/admin/users")
async def create_user_admin(request: Request, data: UserCreateRequest):
    if not get_admin_from_request(request):
        raise HTTPException(403, "Admin access required")

    user_id = hashlib.sha256(data.username.encode()).hexdigest()[:16]
    pw_hash = hash_password(data.password)

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
    if not get_admin_from_request(request):
        raise HTTPException(403, "Admin access required")

    settings = get_settings()
    admins = settings.get("admin_users", {})
    if user_id not in admins:
        raise HTTPException(404, "Admin user not found")

    if data.role:
        admins[user_id]["role"] = data.role
        update_user_role(user_id, data.role)
    if data.password:
        admins[user_id]["password_hash"] = hash_password(data.password)

    settings["admin_users"] = admins
    save_settings(settings)
    return {"ok": True}


@router.delete("/api/admin/users/{user_id}")
async def delete_user_admin(request: Request, user_id: str):
    if not get_admin_from_request(request):
        raise HTTPException(403, "Admin access required")
    delete_user(user_id)
    return {"ok": True}


# ── Migration ─────────────────────────────────────────────────────────────────

@router.post("/api/import-localstorage")
async def import_localstorage(request: Request, data: dict):
    """Import data from browser localStorage dump."""
    await get_user_id(request)
    user_id = request.state.user_id

    import_data = data.get("data", {})
    is_admin = bool(get_admin_from_request(request))

    # Migrate settings (admin-only — these are global settings)
    if is_admin and "curlix:ai-base" in import_data:
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

    # Migrate proxy settings (admin-only — global settings)
    proxy_settings = {}
    if is_admin:
        for key_suffix in ("proxy-url", "proxy-user", "proxy-pass"):
            val = import_data.get(f"curlix:{key_suffix}")
            if val:
                key = key_suffix.replace("-", "_")
                proxy_settings[key] = val
    if proxy_settings and is_admin:
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
