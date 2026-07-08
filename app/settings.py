"""Settings router: GET/POST /api/settings.

Admin sees the full settings object (minus tokens). Non-admin gets a safe
subset — AI config + boolean key-present flag + proxy config, never the key
value itself — so the homepage can render the AI hint without exposing the
admin-configured key.
"""
from fastapi import APIRouter, Request, HTTPException

from .db import get_settings, save_settings
from .auth import get_admin_from_request, hash_password, get_active_tokens

router = APIRouter()


@router.get("/api/settings")
async def get_settings_api(request: Request):
    settings = get_settings()
    admin = get_admin_from_request(request)
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
async def save_settings_api(request: Request, data: dict):
    admin = get_admin_from_request(request)
    if not admin:
        raise HTTPException(403, "Admin access required")

    # Special: saving admin credentials
    if "admin_username" in data or "admin_password" in data:
        current = get_settings().get("admin", {}) or {}
        new_username = data.get("admin_username") or current.get("username") or "admin"
        new_password = data.get("admin_password") or ""
        pw_hash = hash_password(new_password) if new_password else current.get("password_hash", "")
        settings = get_settings()
        settings["admin"] = {"username": new_username, "password_hash": pw_hash}
        settings["admin_tokens"] = get_active_tokens()
        settings.pop("admin_username", None)
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
