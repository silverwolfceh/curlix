"""DB access layer for Curlix.

Two backends, auto-selected by env vars:
- **Turso (libSQL) over HTTP** when `TURSO_URL` + `TURSO_TOKEN` are set
  (use this on Vercel / serverless — SQLite file won't persist there).
- **Local SQLite file** (`curlix.db` at repo root) otherwise (local dev).

Both expose the same `execute(sql, args)` / `execute_many(statements)` API so
the rest of `db.py` is backend-agnostic.
"""
import os
import sqlite3

TURSO_URL = os.environ.get("TURSO_URL", "").strip()
TURSO_TOKEN = os.environ.get("TURSO_TOKEN", "").strip()

# Normalize libsql:// → https:// for the HTTP API.
_https_url = TURSO_URL
if _https_url.startswith("libsql://"):
    _https_url = "https://" + _https_url[len("libsql://"):]
elif _https_url.startswith("libsql+wss://"):
    _https_url = "https://" + _https_url[len("libsql+wss://"):]

USE_TURSO = bool(_https_url and TURSO_TOKEN)

# Local SQLite path (only used when not on Turso).
DB_PATH = os.path.join(os.path.dirname(__file__), "..", "curlix.db")


class TursoResult:
    def __init__(self, rows=None, last_insert_rowid=None, rows_affected=0):
        self.rows = rows or []
        self.last_insert_rowid = last_insert_rowid
        self.rows_affected = rows_affected

    def first(self):
        return self.rows[0] if self.rows else None


# ── Turso HTTP backend ────────────────────────────────────────────────────────

def _turso_arg(v):
    if v is None:
        return {"type": "null"}
    if isinstance(v, bool):
        return {"type": "integer", "value": "1" if v else "0"}
    if isinstance(v, int):
        return {"type": "integer", "value": str(v)}
    if isinstance(v, float):
        return {"type": "float", "value": str(v)}
    if isinstance(v, (bytes, bytearray)):
        return {"type": "blob", "value": bytes(v).hex()}
    return {"type": "text", "value": str(v)}


def _turso_val(cell):
    if cell is None:
        return None
    t = cell.get("type")
    v = cell.get("value")
    if t == "null" or v is None:
        return None
    if t == "integer":
        try:
            return int(v)
        except (TypeError, ValueError):
            return v
    if t == "float":
        try:
            return float(v)
        except (TypeError, ValueError):
            return v
    if t == "blob":
        try:
            return bytes.fromhex(v)
        except (TypeError, ValueError):
            return v
    return v


def _turso_call(body):
    import requests
    endpoint = _https_url.rstrip("/") + "/v2/pipeline"
    r = requests.post(
        endpoint,
        headers={"Authorization": "Bearer " + TURSO_TOKEN, "Content-Type": "application/json"},
        json=body,
        timeout=30,
    )
    r.raise_for_status()
    data = r.json()
    if "error" in data:
        msg = data["error"].get("message", str(data["error"])) if isinstance(data["error"], dict) else str(data["error"])
        raise RuntimeError("Turso: " + msg)
    return data.get("results", [])


def _turso_result_from(res):
    """Parse a single execute result from Turso pipeline response.
    Shape: {type:'ok', response:{type:'execute', result:{cols, rows, affected_row_count, last_insert_rowid}}}
    """
    if isinstance(res, dict) and res.get("type") == "error":
        err = res.get("error", {})
        msg = err.get("message", str(err)) if isinstance(err, dict) else str(err)
        raise RuntimeError("Turso: " + msg)
    # Unwrap {type:'ok', response:{...}}
    if isinstance(res, dict) and "response" in res:
        res = res["response"]
    # res is now {type:'execute', result:{cols, rows, ...}}
    if isinstance(res, dict) and "result" in res:
        res = res["result"]
    cols_raw = res.get("cols", []) or []
    cols = [c["name"] if isinstance(c, dict) else c for c in cols_raw]
    rows_raw = res.get("rows", []) or []
    rows = [
        {cols[i]: _turso_val(c) for i, c in enumerate(row) if i < len(cols)}
        for row in rows_raw
    ]
    lir = None
    lir_obj = res.get("last_insert_rowid")
    if lir_obj is not None:
        if isinstance(lir_obj, dict) and lir_obj.get("value") is not None:
            try:
                lir = int(lir_obj["value"])
            except (TypeError, ValueError):
                lir = lir_obj["value"]
        else:
            try:
                lir = int(lir_obj)
            except (TypeError, ValueError):
                lir = lir_obj
    ra = res.get("affected_row_count", 0) or res.get("rows_affected", 0) or 0
    return TursoResult(rows=rows, last_insert_rowid=lir, rows_affected=ra)


def _turso_execute(sql, args=None):
    stmt = {"sql": sql}
    if args:
        stmt["args"] = [_turso_arg(a) for a in args]
    results = _turso_call({"requests": [{"type": "execute", "stmt": stmt}]})
    if not results:
        return TursoResult()
    res = results[0]
    # Transaction wrapper returns inner results under .results
    if isinstance(res, dict) and "results" in res and "cols" not in res:
        inner = res.get("results", [])
        return _turso_result_from(inner[-1]) if inner else TursoResult()
    return _turso_result_from(res)


def _turso_execute_many(statements):
    """Run N statements in one HTTP round-trip (not atomic, but fast).
    Each statement is (sql, args_or_None). Returns list of TursoResult.
    """
    reqs = []
    for sql, args in statements:
        stmt = {"sql": sql}
        if args:
            stmt["args"] = [_turso_arg(a) for a in args]
        reqs.append({"type": "execute", "stmt": stmt})
    results = _turso_call({"requests": reqs})
    out = []
    for res in results:
        out.append(_turso_result_from(res))
    return out


# ── Local SQLite backend ──────────────────────────────────────────────────────

def _sqlite_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def _sqlite_execute(sql, args=None):
    conn = _sqlite_conn()
    try:
        cur = conn.execute(sql, args or [])
        rows = [dict(r) for r in cur.fetchall()]
        lir = cur.lastrowid
        ra = cur.rowcount
        conn.commit()
        return TursoResult(rows=rows, last_insert_rowid=lir, rows_affected=ra)
    finally:
        conn.close()


def _sqlite_execute_many(statements):
    conn = _sqlite_conn()
    out = []
    try:
        for sql, args in statements:
            cur = conn.execute(sql, args or [])
            rows = [dict(r) for r in cur.fetchall()]
            out.append(TursoResult(rows=rows, last_insert_rowid=cur.lastrowid, rows_affected=cur.rowcount))
        conn.commit()
        return out
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


# ── Public API ─────────────────────────────────────────────────────────────────

def execute(sql, args=None):
    """Run one SQL statement. Returns TursoResult."""
    if USE_TURSO:
        return _turso_execute(sql, args)
    return _sqlite_execute(sql, args)


def execute_many(statements):
    """Run N statements in one transaction. Returns list of TursoResult."""
    if USE_TURSO:
        return _turso_execute_many(statements)
    return _sqlite_execute_many(statements)
