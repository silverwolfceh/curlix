"""Turso (libSQL over HTTP) DB access layer for Curlix.

Requires `TURSO_URL` + `TURSO_TOKEN` env vars. Used on Vercel/serverless
where a SQLite file won't persist.
"""
import os

TURSO_URL = os.environ.get("TURSO_URL", "").strip()
# JWT tokens contain no whitespace; strip stray newlines from pasted values.
TURSO_TOKEN = "".join(os.environ.get("TURSO_TOKEN", "").split())

# Normalize libsql:// → https:// for the HTTP API.
_https_url = TURSO_URL
if _https_url.startswith("libsql://"):
    _https_url = "https://" + _https_url[len("libsql://"):]
elif _https_url.startswith("libsql+wss://"):
    _https_url = "https://" + _https_url[len("libsql+wss://"):]


class TursoResult:
    def __init__(self, rows=None, last_insert_rowid=None, rows_affected=0):
        self.rows = rows or []
        self.last_insert_rowid = last_insert_rowid
        self.rows_affected = rows_affected

    def first(self):
        return self.rows[0] if self.rows else None


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


def execute(sql, args=None):
    """Run one SQL statement. Returns TursoResult."""
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


def execute_many(statements):
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
    return [_turso_result_from(res) for res in results]
