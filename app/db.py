"""Database layer for Curlix (Turso/libSQL over HTTP)."""
import os
import json

from . import turso
from .turso import execute, execute_many  # re-export for callers

_schema_ready = False


def init_db():
    """Create tables if they don't exist. Idempotent.
    On serverless, runs once per warm instance (module-level flag).
    """
    global _schema_ready
    if _schema_ready:
        return
    # DDL is safe to send as a batch of execute requests.
    ddl = [
        """CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            role TEXT DEFAULT 'user',
            created_at TEXT DEFAULT (datetime('now'))
        )""",
        """CREATE TABLE IF NOT EXISTS user_aliases (
            user_id TEXT PRIMARY KEY,
            handle TEXT UNIQUE NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )""",
        """CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        )""",
        """CREATE TABLE IF NOT EXISTS saved_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            name TEXT,
            method TEXT,
            url TEXT,
            headers TEXT,
            body TEXT,
            tags TEXT,
            cookies TEXT,
            ai_desc TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (user_id) REFERENCES users(id)
        )""",
        """CREATE TABLE IF NOT EXISTS history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            name TEXT,
            method TEXT,
            url TEXT,
            request_headers TEXT,
            request_body TEXT,
            request_cookies TEXT,
            response_status INTEGER,
            response_headers TEXT,
            response_body TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (user_id) REFERENCES users(id)
        )""",
        """CREATE TABLE IF NOT EXISTS env_vars (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            key TEXT,
            value TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )""",
        """CREATE TABLE IF NOT EXISTS collections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            name TEXT,
            request_ids TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (user_id) REFERENCES users(id)
        )""",
        "CREATE INDEX IF NOT EXISTS idx_aliases_handle ON user_aliases(handle)",
    ]
    turso.execute_many([(s, None) for s in ddl])
    _schema_ready = True


def ensure_user(user_id):
    """Create user and alias record if not exists. Returns created bool."""
    row = turso.execute(
        "SELECT id FROM users WHERE id = ?",
        [user_id],
    ).first()
    if not row:
        turso.execute_many([
            ("INSERT INTO users (id, role) VALUES (?, 'user')", [user_id]),
            ("INSERT INTO user_aliases (user_id, handle) VALUES (?, ?)", [user_id, user_id]),
        ])
        return True
    return False


def ensure_user_sync(user_id):
    """Lookup user by UUID or handle. Returns user_id if found, else None."""
    row = turso.execute(
        "SELECT u.id FROM users u JOIN user_aliases ua ON u.id = ua.user_id WHERE u.id = ? OR ua.handle = ?",
        [user_id, user_id],
    ).first()
    return str(row["id"]) if row else None


def rename_user(user_id, new_handle):
    turso.execute(
        "UPDATE user_aliases SET handle = ? WHERE user_id = ?",
        [new_handle, user_id],
    )
    return True


def create_user(user_id, role="user"):
    turso.execute_many([
        ("INSERT OR IGNORE INTO users (id, role) VALUES (?, ?)", [user_id, role]),
        ("INSERT OR IGNORE INTO user_aliases (user_id, handle) VALUES (?, ?)", [user_id, user_id]),
    ])


def get_all_users():
    rows = turso.execute("""
        SELECT u.id, u.role, u.created_at, ua.handle
        FROM users u
        LEFT JOIN user_aliases ua ON u.id = ua.user_id
        ORDER BY u.created_at
    """).rows
    return rows


def update_user_role(user_id, role):
    turso.execute(
        "UPDATE users SET role = ? WHERE id = ?",
        [role, user_id],
    )


def delete_user(user_id):
    turso.execute_many([
        ("DELETE FROM env_vars WHERE user_id = ?", [user_id]),
        ("DELETE FROM saved_requests WHERE user_id = ?", [user_id]),
        ("DELETE FROM history WHERE user_id = ?", [user_id]),
        ("DELETE FROM collections WHERE user_id = ?", [user_id]),
        ("DELETE FROM user_aliases WHERE user_id = ?", [user_id]),
        ("DELETE FROM users WHERE id = ?", [user_id]),
    ])


# ── Settings (shared) ─────────────────────────────────────────────────────────

def get_settings():
    rows = turso.execute("SELECT key, value FROM settings").rows
    result = {}
    for r in rows:
        try:
            result[r["key"]] = json.loads(r["value"])
        except (json.JSONDecodeError, TypeError):
            result[r["key"]] = r["value"]
    return result


def save_settings(data):
    stmts = []
    for key, value in data.items():
        s = json.dumps(value) if not isinstance(value, str) else value
        stmts.append(("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [key, s]))
    turso.execute_many(stmts)


# ── Saved Requests (per user) ─────────────────────────────────────────────────

def list_requests(user_id):
    return turso.execute(
        "SELECT id, name, method, url, headers, body, tags, cookies, ai_desc, created_at, updated_at FROM saved_requests WHERE user_id = ? ORDER BY updated_at DESC",
        [user_id],
    ).rows


def get_request(user_id, req_id):
    return turso.execute(
        "SELECT id, name, method, url, headers, body, tags, cookies, ai_desc, created_at, updated_at FROM saved_requests WHERE id = ? AND user_id = ?",
        [req_id, user_id],
    ).first()


def create_request(user_id, name, method, url, headers, body, tags=None, cookies=None, ai_desc=None):
    if headers and not isinstance(headers, str):
        headers = json.dumps(headers)
    if cookies and not isinstance(cookies, str):
        cookies = json.dumps(cookies)
    if isinstance(tags, list):
        tags = json.dumps(tags)
    res = turso.execute(
        """INSERT INTO saved_requests (user_id, name, method, url, headers, body, tags, cookies, ai_desc)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        [user_id, name, method, url, headers or "{}", body or "", tags, cookies or "{}", ai_desc or ""],
    )
    return res.last_insert_rowid


def update_request(user_id, req_id, name, method, url, headers, body, tags=None, cookies=None, ai_desc=None):
    if headers and not isinstance(headers, str):
        headers = json.dumps(headers)
    if cookies and not isinstance(cookies, str):
        cookies = json.dumps(cookies)
    if isinstance(tags, list):
        tags = json.dumps(tags)
    turso.execute(
        """UPDATE saved_requests SET name=?, method=?, url=?, headers=?, body=?, tags=?, cookies=?, ai_desc=?,
           updated_at=datetime('now') WHERE id=? AND user_id=?""",
        [name, method, url, headers or "{}", body or "", tags, cookies or "{}", ai_desc or "", req_id, user_id],
    )


def delete_request(user_id, req_id):
    turso.execute(
        "DELETE FROM saved_requests WHERE id=? AND user_id=?",
        [req_id, user_id],
    )


# ── History (per user) ────────────────────────────────────────────────────────

def list_history(user_id, limit=100, offset=0):
    return turso.execute(
        "SELECT * FROM history WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
        [user_id, limit, offset],
    ).rows


def delete_history_entry(user_id, h_id):
    turso.execute(
        "DELETE FROM history WHERE id=? AND user_id=?",
        [h_id, user_id],
    )


def clear_history(user_id):
    turso.execute(
        "DELETE FROM history WHERE user_id=?",
        [user_id],
    )


def add_history(user_id, name, method, url, request_headers, request_body,
                response_status, response_headers, response_body, request_cookies=None):
    if request_headers and not isinstance(request_headers, str):
        request_headers = json.dumps(request_headers)
    if request_cookies and not isinstance(request_cookies, str):
        request_cookies = json.dumps(request_cookies)
    if isinstance(response_headers, dict):
        response_headers = json.dumps(response_headers)
    elif isinstance(response_headers, str):
        pass
    else:
        response_headers = str(response_headers)
    if not isinstance(response_body, str):
        response_body = str(response_body)
    turso.execute(
        """INSERT INTO history (user_id, name, method, url, request_headers, request_body,
           request_cookies, response_status, response_headers, response_body)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        [user_id, name, method, url,
         request_headers or "{}", request_body or "", request_cookies or "{}",
         response_status, response_headers or "{}", response_body or ""],
    )


# ── Env Vars (per user) ──────────────────────────────────────────────────────

def list_env_vars(user_id):
    return turso.execute(
        "SELECT id, key, value FROM env_vars WHERE user_id = ? ORDER BY key",
        [user_id],
    ).rows


def save_env_vars(user_id, vars_list):
    """vars_list: [{key, value}, ...] (tolerates {k,v}). Replaces all for user."""
    stmts = [("DELETE FROM env_vars WHERE user_id=?", [user_id])]
    for v in vars_list:
        key = v.get("key", v.get("k"))
        value = v.get("value", v.get("v"))
        if not key:
            continue
        stmts.append(("INSERT INTO env_vars (user_id, key, value) VALUES (?, ?, ?)", [user_id, key, value]))
    turso.execute_many(stmts)


def delete_env_var(user_id, env_id):
    turso.execute(
        "DELETE FROM env_vars WHERE id=? AND user_id=?",
        [env_id, user_id],
    )


# ── Collections (per user) ────────────────────────────────────────────────────

def list_collections(user_id):
    return turso.execute(
        "SELECT * FROM collections WHERE user_id = ? ORDER BY created_at DESC",
        [user_id],
    ).rows


def create_collection(user_id, name, request_ids=None):
    if request_ids and not isinstance(request_ids, str):
        request_ids = json.dumps(request_ids)
    res = turso.execute(
        "INSERT INTO collections (user_id, name, request_ids) VALUES (?, ?, ?)",
        [user_id, name, request_ids or "[]"],
    )
    return res.last_insert_rowid


def update_collection(user_id, c_id, name, request_ids=None):
    if request_ids and not isinstance(request_ids, str):
        request_ids = json.dumps(request_ids)
    turso.execute(
        "UPDATE collections SET name=?, request_ids=? WHERE id=? AND user_id=?",
        [name, request_ids or "[]", c_id, user_id],
    )


def delete_collection(user_id, c_id):
    turso.execute(
        "DELETE FROM collections WHERE id=? AND user_id=?",
        [c_id, user_id],
    )
