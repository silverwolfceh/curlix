# AGENTS.md — Curlix AI Coding Agent Guide

**Curlix** — self-hosted HTTP client / API workbench. FastAPI backend + vanilla JS/HTML/CSS frontend, zero build step. Multi-user, per-user SQLite (or Turso for serverless). Corporate-ready: NTLM/Kerberos, proxy, SSL off.

## Run

```powershell
uv pip install -r requirements.txt        # first time
uv run uvicorn main:app --reload          # dev server — always use `uv run`
```

- App: `http://localhost:5555`
- Admin: `http://localhost:5555/admin`
- Default login: `admin` / `admin`
- Reset admin: `uv run python reset_admin.py [new_pw]`
- **DB backend:** local SQLite (`curlix.db` at repo root) by default. Set `TURSO_URL` + `TURSO_TOKEN` → Turso (libSQL over HTTP) for Vercel/serverless.

## Repo Layout

```
main.py              # Entry: middleware, mount routers, static mount, /admin route
reset_admin.py       # Admin password reset
gettoken.py          # MSAL token helper (standalone, not app runtime)
requirements.txt
curlix.db            # SQLite (gitignored, regenerated)
static/              # Frontend: index.html, admin.html, app.js, style.css, assets/
app/                 # Backend package — all features here
  __init__.py
  config.py          # App factory: init_db, admin bootstrap, CORS, logging
  db.py              # SQLite data layer (DB_PATH = ../curlix.db)
  models.py          # Pydantic models
  auth.py            # Password hashing, session tokens, user resolution
  auth_routes.py     # /api/login, /api/logout, /api/admin/check
  proxy.py           # /api/proxy (browser CORS bypass, corporate auth)
  llm.py             # /api/ai-fill (natural language → request)
  settings.py        # /api/settings (admin: full, non-admin: safe subset)
  saved_requests.py  # /api/saved-requests (CRUD)
  history.py         # /api/history (list, add, clear, delete)
  env_vars.py        # /api/env-vars (CRUD, encrypted)
  collections_routes.py  # /api/collections (CRUD) — never name module "collections.py"
  users.py           # /api/user/*, /api/admin/users*, /api/import-localstorage
```

## Architecture Rules

- **Backend in `app/`.** All feature modules use relative imports (`from .db import`). `main.py` and `reset_admin.py` use `from app.config import` / `from app.db import`.
- **No top-level `.py` for features.** Add under `app/`, mount in `main.py` with `app.include_router(...)`.
- **`collections_routes.py` only** — `collections` shadows stdlib, breaks FastAPI.
- **DB at project root** (`curlix.db`). `db.py` is in `app/`, `DB_PATH = ../curlix.db`. Don't move it.
- **DB migrations = idempotent DDL** (`CREATE TABLE IF NOT EXISTS`). Edit DDL in `init_db()` in `app/db.py` to add columns. Never use `ALTER TABLE ADD COLUMN`.
- **One route file per domain.** Each defines `router = APIRouter()` and is mounted in `main.py`.

## Frontend Rules

- **No build step.** Vanilla JS (`static/app.js`), HTML (`index.html` + `admin.html`), CSS (`style.css`).
- **Cache-bust:** bump `app.js?v=N` in `index.html` after JS changes. Current version: `v=55`.
- **`/admin` route sends no-cache headers.** Don't add cache headers elsewhere.
- **All user state is server-side** (per-user, in SQLite): saved requests, history, env vars, settings.
- **`localStorage` keys** (`curlix:` prefix):
  - `curlix:theme` — `light` or unset (dark)
  - `curlix:sidebar-hidden` — `1` or `0`
  - `curlix:admin-token` — admin session bearer
  - `curlix:env-key` — derived encryption key (survives refresh in localStorage)
  - `curlix:ai-base|ai-key|ai-model|ai-call|ai-response-style` — frontend AI override (never sent to server)
- **`{{VAR}}` substitution:** `resolveVars(str)` replaces `{{NAME}}` tokens with env var values at send time. Applied in `sendRequest()` to URL, header keys/values, cookie keys/values, body.

## Sync & Auth Flow

- **Anonymous → localStorage** (`curlix:saved`, `curlix:history`, `curlix:env`).
- **Logged in → server** (SQLite, per-user). Env vars encrypted with AES-GCM (PBKDF2 key derivation).
- **Login/Register:**
  1. Derive encryption key from password via PBKDF2 (`200k` iterations, SHA-256).
  2. Store key in sessionStorage + localStorage (survives page refresh).
  3. Sync local data → server (saved requests, history, env vars) — fires once per session (`_syncedThisSession` flag).
  4. Clear localStorage items after sync.
  5. Reload page for clean state.
- **Logout:** clear encryption key, reset sync flag so next login can sync fresh anonymous data.
- **Env key persistence:** stored in both sessionStorage and localStorage. `loadEnvKeyIfPresent()` checks sessionStorage first, falls back to localStorage on refresh.

## Key Behaviors (Don't Break)

- **AI settings fallback:** `getAi*()` reads localStorage only. `/api/ai-fill` falls back to server config (`_apply_server_fallback` in `llm.py`) if client empty. Admin configures server-side via `/admin`. Never serve AI key to non-admin frontend.
- **`GET /api/settings` is NOT admin-only** — returns safe subset for non-admin (AI config + `ai_key_set` boolean, proxy config; never the key value). `POST /api/settings` is admin-only.
- **Proxy:** `/api/proxy` honors env proxies (`HTTP_PROXY`/`HTTPS_PROXY`) unless explicit proxy requested. `session.trust_env` = default. Matches "Try with requests" export (`generated.py`). Never set `trust_env=False` — breaks corporate requests (502).
- **SSL verification = off** (`verify=False`) everywhere. Intentional for corporate networks.
- **`pushHistoryEntry` calls `renderHistory()`** after success — sidebar auto-refreshes. Don't remove.
- **Cookies persist** in `saved_requests` (`cookies` col) and `history` (`request_cookies` col). `applyRequestToTab` restores them. Don't drop in save/import/export flows.
- **`ai_desc`** saves with each request, restores on reopen.
- **`typeof item.headers === 'string'` check** before `JSON.parse()` — server can return already-deserialized objects (Turso).
- **Clear requests button** — `clearAllRequests()` deletes all saved requests via confirmation dialog (same pattern as `clearHistory()`).

## "Try with requests"

`generatePython(id)` in `app.js` builds a standalone `generated.py` using `requests`, downloaded as a file. Reproduces exact request: method, URL, headers, cookies, body, proxy, `verify=False`. Compare `/api/proxy` behavior against `generated.py` when debugging.

## Testing

No test suite. Manual smoke test:
1. Restart uvicorn after backend changes.
2. Hard-refresh browser (Ctrl+Shift+R) after frontend changes — bump `app.js?v=N` if needed.
3. Smoke: `GET /api/admin/check`, login, `GET /api/settings`, `GET /api/saved-requests`.
4. DB schema changes: `uv run python -c "from app.db import init_db; init_db()"` then `PRAGMA table_info` on `curlix.db`.