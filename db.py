"""SQLite database layer for Curlix v2."""

import sqlite3
import os
import json
from datetime import datetime

DB_PATH = os.path.join(os.path.dirname(__file__), "curlix.db")


def get_db():
    """Get a synchronous sqlite3 connection."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    """Create tables if they don't exist."""
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            role TEXT DEFAULT 'user',
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS user_aliases (
            user_id TEXT PRIMARY KEY,
            handle TEXT UNIQUE NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        );

        CREATE TABLE IF NOT EXISTS saved_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            name TEXT,
            method TEXT,
            url TEXT,
            headers TEXT,
            body TEXT,
            tags TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            name TEXT,
            method TEXT,
            url TEXT,
            request_headers TEXT,
            request_body TEXT,
            response_status INTEGER,
            response_headers TEXT,
            response_body TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS env_vars (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            key TEXT,
            value TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS collections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            name TEXT,
            request_ids TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE INDEX IF NOT EXISTS idx_aliases_handle ON user_aliases(handle);
    """)
    conn.commit()

    # ── Migrations: add cookie columns (idempotent) ──
    def _has_col(table, col):
        return any(r[1] == col for r in conn.execute(f"PRAGMA table_info({table})").fetchall())
    if not _has_col("saved_requests", "cookies"):
        conn.execute("ALTER TABLE saved_requests ADD COLUMN cookies TEXT")
    if not _has_col("saved_requests", "ai_desc"):
        conn.execute("ALTER TABLE saved_requests ADD COLUMN ai_desc TEXT")
    if not _has_col("history", "request_cookies"):
        conn.execute("ALTER TABLE history ADD COLUMN request_cookies TEXT")
    conn.commit()
    conn.close()


def ensure_user(user_id):
    """Create user and alias record if not exists. Returns created bool."""
    conn = get_db()
    user = conn.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone()
    if not user:
        conn.execute(
            "INSERT INTO users (id, role) VALUES (?, 'user')",
            (user_id,),
        )
        conn.execute(
            "INSERT INTO user_aliases (user_id, handle) VALUES (?, ?)",
            (user_id, user_id),
        )
        conn.commit()
        conn.close()
        return True
    conn.close()
    return False


def ensure_user_sync(user_id):
    """Lookup user by UUID or handle. Sets cookie via response if found."""
    conn = get_db()
    user = conn.execute(
        "SELECT u.id FROM users u JOIN user_aliases ua ON u.id = ua.user_id WHERE u.id = ? OR ua.handle = ?",
        (user_id, user_id),
    ).fetchone()
    if user:
        conn.close()
        return str(user["id"])
    conn.close()
    return None


def rename_user(user_id, new_handle):
    """Update user's alias handle. Returns True on success."""
    conn = get_db()
    conn.execute("UPDATE user_aliases SET handle = ? WHERE user_id = ?", (new_handle, user_id))
    conn.commit()
    conn.close()
    return True


def create_user(user_id, role="user"):
    """Create a user (and alias) without auto-creating."""
    conn = get_db()
    conn.execute("INSERT OR IGNORE INTO users (id, role) VALUES (?, ?)", (user_id, role))
    conn.execute(
        "INSERT OR IGNORE INTO user_aliases (user_id, handle) VALUES (?, ?)",
        (user_id, user_id),
    )
    conn.commit()
    conn.close()


def get_all_users():
    """List all users with their aliases."""
    conn = get_db()
    rows = conn.execute("""
        SELECT u.id, u.role, u.created_at, ua.handle
        FROM users u
        LEFT JOIN user_aliases ua ON u.id = ua.user_id
        ORDER BY u.created_at
    """).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def update_user_role(user_id, role):
    conn = get_db()
    conn.execute("UPDATE users SET role = ? WHERE id = ?", (role, user_id))
    conn.commit()
    conn.close()


def delete_user(user_id):
    conn = get_db()
    conn.execute("DELETE FROM env_vars WHERE user_id = ?", (user_id,))
    conn.execute("DELETE FROM saved_requests WHERE user_id = ?", (user_id,))
    conn.execute("DELETE FROM history WHERE user_id = ?", (user_id,))
    conn.execute("DELETE FROM collections WHERE user_id = ?", (user_id,))
    conn.execute("DELETE FROM user_aliases WHERE user_id = ?", (user_id,))
    conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    conn.commit()
    conn.close()


# ── Settings (shared) ─────────────────────────────────────────────────────────

def get_settings():
    conn = get_db()
    rows = conn.execute("SELECT key, value FROM settings").fetchall()
    conn.close()
    result = {}
    for r in rows:
        try:
            result[r["key"]] = json.loads(r["value"])
        except (json.JSONDecodeError, TypeError):
            result[r["key"]] = r["value"]
    return result


def save_settings(data):
    """data is a dict of key→value (already serializable)."""
    conn = get_db()
    for key, value in data.items():
        s = json.dumps(value) if not isinstance(value, str) else value
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, s))
    conn.commit()
    conn.close()


# ── Saved Requests (per user) ─────────────────────────────────────────────────

def list_requests(user_id):
    conn = get_db()
    rows = conn.execute(
        "SELECT id, name, method, url, headers, body, tags, cookies, ai_desc, created_at, updated_at FROM saved_requests WHERE user_id = ? ORDER BY updated_at DESC",
        (user_id,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_request(user_id, req_id):
    conn = get_db()
    row = conn.execute(
        "SELECT id, name, method, url, headers, body, tags, cookies, ai_desc, created_at, updated_at FROM saved_requests WHERE id = ? AND user_id = ?",
        (req_id, user_id),
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def create_request(user_id, name, method, url, headers, body, tags=None, cookies=None, ai_desc=None):
    if headers and not isinstance(headers, str):
        headers = json.dumps(headers)
    if cookies and not isinstance(cookies, str):
        cookies = json.dumps(cookies)
    if isinstance(tags, list):
        tags = json.dumps(tags)
    conn = get_db()
    cur = conn.execute(
        """INSERT INTO saved_requests (user_id, name, method, url, headers, body, tags, cookies, ai_desc)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (user_id, name, method, url, headers or "{}", body or "", tags, cookies or "{}", ai_desc or ""),
    )
    conn.commit()
    rid = cur.lastrowid
    conn.close()
    return rid


def update_request(user_id, req_id, name, method, url, headers, body, tags=None, cookies=None, ai_desc=None):
    if headers and not isinstance(headers, str):
        headers = json.dumps(headers)
    if cookies and not isinstance(cookies, str):
        cookies = json.dumps(cookies)
    if isinstance(tags, list):
        tags = json.dumps(tags)
    conn = get_db()
    conn.execute(
        """UPDATE saved_requests SET name=?, method=?, url=?, headers=?, body=?, tags=?, cookies=?, ai_desc=?,
           updated_at=datetime('now') WHERE id=? AND user_id=?""",
        (name, method, url, headers or "{}", body or "", tags, cookies or "{}", ai_desc or "", req_id, user_id),
    )
    conn.commit()
    conn.close()


def delete_request(user_id, req_id):
    conn = get_db()
    conn.execute("DELETE FROM saved_requests WHERE id=? AND user_id=?", (req_id, user_id))
    conn.commit()
    conn.close()


# ── History (per user) ────────────────────────────────────────────────────────

def list_history(user_id, limit=100, offset=0):
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM history WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
        (user_id, limit, offset),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def delete_history_entry(user_id, h_id):
    conn = get_db()
    conn.execute("DELETE FROM history WHERE id=? AND user_id=?", (h_id, user_id))
    conn.commit()
    conn.close()


def clear_history(user_id):
    conn = get_db()
    conn.execute("DELETE FROM history WHERE user_id=?", (user_id,))
    conn.commit()
    conn.close()


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
    conn = get_db()
    conn.execute(
        """INSERT INTO history (user_id, name, method, url, request_headers, request_body,
           request_cookies, response_status, response_headers, response_body)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (user_id, name, method, url,
         request_headers or "{}", request_body or "", request_cookies or "{}",
         response_status, response_headers or "{}", response_body or ""),
    )
    conn.commit()
    conn.close()


# ── Env Vars (per user) ──────────────────────────────────────────────────────

def list_env_vars(user_id):
    conn = get_db()
    rows = conn.execute(
        "SELECT id, key, value FROM env_vars WHERE user_id = ? ORDER BY key",
        (user_id,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def save_env_vars(user_id, vars_list):
    """vars_list is [{key, value}, ...]. Replaces all for user."""
    conn = get_db()
    conn.execute("DELETE FROM env_vars WHERE user_id=?", (user_id,))
    for v in vars_list:
        conn.execute(
            "INSERT INTO env_vars (user_id, key, value) VALUES (?, ?, ?)",
            (user_id, v["key"], v["value"]),
        )
    conn.commit()
    conn.close()


def delete_env_var(user_id, env_id):
    conn = get_db()
    conn.execute("DELETE FROM env_vars WHERE id=? AND user_id=?", (env_id, user_id))
    conn.commit()
    conn.close()


# ── Collections (per user) ────────────────────────────────────────────────────

def list_collections(user_id):
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM collections WHERE user_id = ? ORDER BY created_at DESC",
        (user_id,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def create_collection(user_id, name, request_ids=None):
    if request_ids and not isinstance(request_ids, str):
        request_ids = json.dumps(request_ids)
    conn = get_db()
    cur = conn.execute(
        "INSERT INTO collections (user_id, name, request_ids) VALUES (?, ?, ?)",
        (user_id, name, request_ids or "[]"),
    )
    conn.commit()
    cid = cur.lastrowid
    conn.close()
    return cid


def update_collection(user_id, c_id, name, request_ids=None):
    if request_ids and not isinstance(request_ids, str):
        request_ids = json.dumps(request_ids)
    conn = get_db()
    conn.execute(
        "UPDATE collections SET name=?, request_ids=? WHERE id=? AND user_id=?",
        (name, request_ids or "[]", c_id, user_id),
    )
    conn.commit()
    conn.close()


def delete_collection(user_id, c_id):
    conn = get_db()
    conn.execute("DELETE FROM collections WHERE id=? AND user_id=?", (c_id, user_id))
    conn.commit()
    conn.close()