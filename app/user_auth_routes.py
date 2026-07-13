"""User account auth router: register, login, logout, me.

Account sessions live in a 30-day `opm_session` cookie. Env-var encryption salt
is returned at login/register so the client can derive the AES-GCM key from the
password (server never sees plaintext env values).
"""
import base64
import os

from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import JSONResponse

from .auth import (
    hash_password, verify_password,
    issue_user_session, invalidate_user_session, validate_user_session,
)
from .db import create_account, get_account_by_username, get_user_env_salt
from .models import UserRegisterRequest, UserLoginRequest

router = APIRouter()

_SESSION_MAX_AGE = 30 * 24 * 3600


def _set_session_cookie(resp, token):
    resp.set_cookie(
        "opm_session", token, path="/", httponly=True,
        samesite="lax", max_age=_SESSION_MAX_AGE,
    )


@router.post("/api/user/register")
async def register(body: UserRegisterRequest):
    username = body.username.strip()
    if len(username) < 3:
        raise HTTPException(400, "Username must be at least 3 characters")
    if not username.replace("_", "").replace("-", "").isalnum():
        raise HTTPException(400, "Username can only contain letters, numbers, underscores, hyphens")
    if len(body.password) < 6:
        raise HTTPException(400, "Password must be at least 6 characters")
    if get_account_by_username(username):
        raise HTTPException(409, "Username already taken")

    env_salt = base64.b64encode(os.urandom(16)).decode()
    pw_hash = hash_password(body.password)
    user_id = create_account(username, pw_hash, env_salt)
    token = issue_user_session(user_id, username)
    resp = JSONResponse({"ok": True, "user_id": user_id, "username": username, "env_salt": env_salt})
    _set_session_cookie(resp, token)
    return resp


@router.post("/api/user/login")
async def login(body: UserLoginRequest):
    username = body.username.strip()
    acct = get_account_by_username(username)
    if not acct or not acct.get("password_hash") or not verify_password(acct["password_hash"], body.password):
        raise HTTPException(401, "Invalid credentials")
    token = issue_user_session(acct["id"], acct["username"])
    resp = JSONResponse({
        "ok": True,
        "user_id": acct["id"],
        "username": acct["username"],
        "env_salt": acct.get("env_salt") or "",
    })
    _set_session_cookie(resp, token)
    return resp


@router.post("/api/user/logout")
async def logout(request: Request):
    token = request.cookies.get("opm_session")
    if token:
        invalidate_user_session(token)
    resp = JSONResponse({"ok": True})
    resp.delete_cookie("opm_session", path="/")
    return resp


@router.get("/api/user/me")
async def me(request: Request):
    token = request.cookies.get("opm_session")
    session = validate_user_session(token) if token else None
    if not session:
        raise HTTPException(401, "Not logged in")
    salt = get_user_env_salt(session["user_id"])
    return {"user_id": session["user_id"], "username": session["username"], "env_salt": salt or ""}
