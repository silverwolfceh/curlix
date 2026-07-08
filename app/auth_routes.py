"""Auth router: login, logout, admin check."""
from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import JSONResponse

from .db import get_settings
from .auth import verify_password, issue_token, invalidate_token
from .models import LoginRequest

router = APIRouter()


@router.post("/api/login")
async def login(body: LoginRequest):
    """Login as admin. Returns session token (set as cookie)."""
    username = body.username.strip().lower()
    password = body.password

    settings = get_settings()
    admin = settings.get("admin", {})
    if admin.get("username") == username and verify_password(admin.get("password_hash", ""), password):
        token = issue_token(username)
        resp = JSONResponse({"ok": True, "username": username, "token": token})
        resp.set_cookie("opm_admin_token", token, path="/", httponly=True, samesite="lax")
        return resp
    raise HTTPException(401, "Invalid credentials")


@router.post("/api/logout")
async def logout(request: Request):
    """Logout admin."""
    token = request.cookies.get("opm_admin_token")
    if token:
        invalidate_token(token)
    resp = JSONResponse({"ok": True})
    resp.delete_cookie("opm_admin_token", path="/")
    return resp


@router.get("/api/admin/check")
async def admin_check(request: Request):
    """Check if current session is admin."""
    from .auth import get_admin_from_request
    admin = get_admin_from_request(request)
    if admin:
        return {"admin": True, "username": admin["username"]}
    return {"admin": False}
