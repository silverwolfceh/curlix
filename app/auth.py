"""Authentication helpers: password hashing, session tokens, admin/user resolution."""
import hashlib
import secrets
import uuid
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import Request, HTTPException

from .db import get_settings, save_settings, ensure_user, ensure_user_sync


# ── Password hashing ─────────────────────────────────────────────────────────

def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    h = hashlib.sha256((salt + password).encode()).hexdigest()
    return f"{salt}${h}"


def verify_password(stored: str, password: str) -> bool:
    try:
        salt, h = stored.split("$", 1)
        return hashlib.sha256((salt + password).encode()).hexdigest() == h
    except Exception:
        return False


# ── Session tokens (stored in settings under "admin_tokens") ──────────────────

def _get_active_tokens():
    return get_settings().get("admin_tokens", {})


def get_active_tokens():
    """Public accessor for the active admin-token map."""
    return _get_active_tokens()


def _save_active_tokens(tokens):
    settings = get_settings()
    settings["admin_tokens"] = tokens
    save_settings(settings)


def issue_token(username):
    """Issue a session token for an admin user. Returns token string."""
    token = secrets.token_hex(32)
    tokens = _get_active_tokens()
    tokens[token] = {
        "username": username,
        "created": _now_iso(),
        "expires": _now_iso_add_hours(24),
    }
    _save_active_tokens(tokens)
    return token


def invalidate_token(token):
    tokens = _get_active_tokens()
    tokens.pop(token, None)
    _save_active_tokens(tokens)


def validate_token(token):
    tokens = _get_active_tokens()
    if token in tokens:
        entry = tokens[token]
        if is_expired(entry.get("expires", "")):
            invalidate_token(token)
            return None
        return entry
    return None


# ── User account sessions (stored in settings under "user_sessions") ───────────

def _get_user_sessions():
    return get_settings().get("user_sessions", {})


def _save_user_sessions(sessions):
    settings = get_settings()
    settings["user_sessions"] = sessions
    save_settings(settings)


def issue_user_session(user_id, username):
    token = secrets.token_hex(32)
    sessions = _get_user_sessions()
    sessions[token] = {
        "user_id": user_id,
        "username": username,
        "created": _now_iso(),
        "expires": _now_iso_add_hours(24 * 30),
    }
    _save_user_sessions(sessions)
    return token


def validate_user_session(token):
    sessions = _get_user_sessions()
    if token in sessions:
        entry = sessions[token]
        if is_expired(entry.get("expires", "")):
            invalidate_user_session(token)
            return None
        return entry
    return None


def invalidate_user_session(token):
    sessions = _get_user_sessions()
    sessions.pop(token, None)
    _save_user_sessions(sessions)


# ── Time helpers ──────────────────────────────────────────────────────────────

def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _now_iso_add_hours(n):
    return (datetime.now(timezone.utc) + timedelta(hours=n)).isoformat()


def is_expired(iso_str):
    try:
        exp = datetime.fromisoformat(iso_str)
        return datetime.now(timezone.utc) > exp
    except Exception:
        return False


# ── Request-bound resolution ─────────────────────────────────────────────────

def get_admin_from_request(request: Request) -> Optional[dict]:
    """Extract admin session from cookie or Authorization header."""
    token = request.cookies.get("opm_admin_token")
    if not token:
        auth = request.headers.get("authorization", "")
        if auth.startswith("Bearer "):
            token = auth[7:]
    if token:
        return validate_token(token)
    return None


async def get_user_id(request: Request) -> str:
    """Resolve user_id for user-scoped routes (opm_session cookie or Bearer).
    Requires a valid user-account session. Raises 401 if not logged in.
    """
    token = request.cookies.get("opm_session")
    if not token:
        auth = request.headers.get("authorization", "")
        if auth.startswith("Bearer "):
            token = auth[7:]
    session = validate_user_session(token) if token else None
    if not session:
        raise HTTPException(status_code=401, detail="Login required")
    request.state.user_id = session["user_id"]
    return session["user_id"]
