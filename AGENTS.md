# AGENTS.md

Guidance for AI coding agents (pi, Claude Code, etc.) working in this repo.

## What this is

**Curlix** — self-hosted HTTP client / API workbench. FastAPI backend + vanilla JS/HTML/CSS frontend, no build step. Single SQLite DB. Built for corporate networks (NTLM/Kerberos, proxy, SSL verification off).

## Running the app

```powershell
# Install deps (first time) — creates/uses .venv
uv pip install -r requirements.txt

# Start dev server — MUST use uv run, not bare system uvicorn
uv run uvicorn main:app --reload
```

- App at `http://localhost:5555`
- Admin panel at `http://localhost:5555/admin`
- **Always use `uv run ...`** — it targets the `.venv` env. Bare/system uvicorn runs a different Python missing `requests-negotiate-sspi`, `requests-kerberos`, etc.
- Default admin: `admin` / `admin`. Reset: `TURSO_URL=... TURSO_TOKEN=... uv run python reset_admin.py [new_pw]`
- **DB backend: Turso (libSQL over HTTP)** — requires `TURSO_URL` + `TURSO_TOKEN` env vars. No local SQLite fallback.

## Repo layout

```
main.py              # entrypoint: user middleware + mount routers + static
reset_admin.py       # admin password reset script
gettoken.py          # MSAL token helper (standalone, unrelated to app runtime)
requirements.txt
static/              # frontend (index.html, admin.html, app.js, style.css, logo.png, favicon.png)
app/                 # backend package
  __init__.py
  config.py          # app factory: init_db, default admin bootstrap, CORS, logging
  db.py              # Turso data layer (CRUD over app/turso.py)
  models.py          # all Pydantic models
  auth.py            # password hashing, session tokens, admin/user resolution
  auth_routes.py     # /api/login, /api/logout, /api/admin/check
  proxy.py           # /api/proxy
  llm.py             # /api/ai-fill
  settings.py        # /api/settings (admin: full; non-admin: safe subset)
  saved_requests.py  # CRUD /api/saved-requests
  history.py         # /api/history
  env_vars.py        # /api/env-vars
  collections_routes.py  # /api/collections (renamed — stdlib collision)
  users.py           # /api/user/* + /api/admin/users* + /api/import-localstorage
```

## Architecture rules

- **Backend = `app/` package.** All modules use relative imports (`from .db import`, `from .auth import`). `main.py` and `reset_admin.py` use `from app.config import` / `from app.db import`.
- **No new top-level `.py` files for features.** Add a new module under `app/`, then `app.include_router(...)` in `main.py`.
- **`collections_routes.py`, not `collections.py`** — `collections` shadows the stdlib and breaks fastapi imports. Never name a module `collections.py`.
- **DB = Turso (libSQL over HTTP).** Requires `TURSO_URL` + `TURSO_TOKEN`. Access via `app/turso.py` (`execute`/`execute_many`).
- **DB migrations are idempotent** `CREATE TABLE IF NOT EXISTS` (no more `ALTER TABLE ADD COLUMN` — all columns declared inline in DDL). Add new columns by editing the DDL in `init_db()` (`app/db.py`), never destructive schema changes.
- **One route file per feature domain.** Each defines `router = APIRouter()` and is mounted in `main.py`.

## Frontend rules

- **No build step.** Vanilla JS in `static/app.js` (~1300 lines, single file), HTML in `static/index.html` + `static/admin.html`, CSS in `static/style.css`.
- **Cache-bust after JS changes:** bump `app.js?v=N` in `static/index.html`. Current: `v=16`.
- **Admin page (`/admin`) sends no-cache headers** (route in `main.py`) so `admin.html` updates apply immediately. Do not add cache headers elsewhere.
- **All state lives server-side now** (per-user, in Turso) — saved requests, history, env vars, settings. Theme + sidebar-hidden + AI config (local override) stay in `localStorage` with `curlix:` prefix.

### localStorage keys (`curlix:` prefix)
- `curlix:theme` — `light` or unset (dark)
- `curlix:sidebar-hidden` — `1` or `0`
- `curlix:admin-token` — admin session bearer
- `curlix:ai-base|ai-key|ai-model|ai-call|ai-response-style` — frontend AI override (never sent to server)

### `{{VAR}}` substitution
`resolveVars(str)` replaces `{{NAME}}` tokens with env var values at send time. Applied to URL, header keys/values, cookie keys/values, body in `sendRequest()`.

## Key behaviors (don't break these)

- **AI settings fallback:** homepage `getAi*()` read `localStorage` only. If empty, `/api/ai-fill` falls back to server-saved config (`_apply_server_fallback` in `llm.py`). Admin configures server-side via `/admin`. Never load AI key from server into non-admin frontend.
- **`GET /api/settings` is not admin-only** — returns a safe subset for non-admin (AI config + `ai_key_set` boolean, proxy config; never the key value). `POST /api/settings` is admin-only.
- **Proxy:** `/api/proxy` honors env proxies (`HTTP_PROXY`/`HTTPS_PROXY`) unless an explicit proxy is requested. `session.trust_env` left default. This matches `generated.py` (the "Try with requests" export). Do not re-add `trust_env=False` — it breaks corporate-network requests (502).
- **SSL verification is off** (`verify=False`) everywhere — corporate compatibility. Intentional.
- **`pushHistoryEntry` calls `renderHistory()` after success** — history sidebar refreshes after each Send. Don't remove this.
- **Cookies persist** in saved_requests (`cookies` col) and history (`request_cookies` col). `applyRequestToTab` restores them. Don't drop cookies from save/import/export flows.
- **AI desc (`ai_desc`)** saves with each request and restores on reopen.

## "Try with requests" button

`generatePython(id)` in `app.js` builds a standalone `generated.py` using `requests`, downloaded as a file. Must reproduce the exact request: method, URL, headers, cookies, body, proxy, `verify=False`. When debugging proxy/auth issues, compare `/api/proxy` behavior against `generated.py` — they should match.

## Testing changes

No test suite. Verify manually:
1. Restart uvicorn after backend changes.
2. Hard-refresh browser (Ctrl+Shift+R) after frontend changes — bump `app.js?v=N` if needed.
3. Smoke test: `GET /api/admin/check`, login, `GET /api/settings`, `GET /api/saved-requests`.
4. For DB schema changes: run `uv run python -c "from app.db import init_db; init_db()"` (needs `TURSO_URL`/`TURSO_TOKEN`) then inspect tables via `turso db shell curlix`.

## Communication style

Respond terse (caveman style per user AGENTS.md). Drop articles/filler, keep technical substance. Code/commits/PRs written normal English.
