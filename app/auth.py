"""Authentication helpers: password hashing, session tokens, admin/user resolution."""
import hashlib
import secrets
import uuid
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import Request

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
    """Resolve user_id for user-scoped routes (cookie or X-User-ID header)."""
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
