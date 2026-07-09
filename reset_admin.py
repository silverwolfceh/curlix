"""Reset admin password.

Usage (with Turso env vars set):
    TURSO_URL=... TURSO_TOKEN=... uv run python reset_admin.py [new_password]

If new_password omitted, resets to "admin".
"""
import sys
import hashlib
import secrets
from app.db import get_settings, save_settings


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    h = hashlib.sha256((salt + password).encode()).hexdigest()
    return f"{salt}${h}"


def main():
    new_pw = sys.argv[1] if len(sys.argv) > 1 else "admin"
    settings = get_settings()
    current = settings.get("admin", {}) or {}
    username = current.get("username") or "admin"
    settings["admin"] = {
        "username": username,
        "password_hash": hash_password(new_pw),
    }
    # Wipe active admin tokens so old sessions don't linger.
    settings["admin_tokens"] = {}
    save_settings(settings)
    print(f"Admin password reset.")
    print(f"  Username: {username}")
    print(f"  Password: {new_pw}")
    print("Log in at /admin, then change it.")


if __name__ == "__main__":
    main()
