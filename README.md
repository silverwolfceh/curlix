# Curlix 📨

> Capture — Rebuild — Replay

A self-hosted, single-binary HTTP client and API workbench. Send requests, manage environments, build requests from natural language via AI, and replay saved requests. No accounts, no cloud — all data stays in a local SQLite database.

Built for corporate networks: NTLM/Kerberos auth, HTTP proxy support, and SSL verification disabled for internal endpoints.

![Curlix](static/logo.png)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/silverwolfceh/curlix&repository-slug=curlix&branch=feature/curlix-deploy)

> **Deploying to Vercel?** Set these env vars in your Vercel project (Settings → Environment Variables): `TURSO_URL` (libsql://…) and `TURSO_TOKEN` (token). See [Deploy to Vercel](#deploy-to-vercel-free-tier) below.

---

## Features

- **Multi-tab request workspace** — open many requests in parallel tabs, each isolated.
- **Methods** — GET, POST, PUT, PATCH, DELETE.
- **Headers & Cookies** — collapsible editors per request.
- **Body** — raw text body with `{{VAR}}` environment substitution.
- **Environment variables** — `{{NAME}}` tokens resolved at send time across URL, headers, cookies, body. Manage in the Env sidebar panel.
- **History** — every sent request is logged (method, URL, status, request headers/cookies/body, response). Click to reopen.
- **Saved requests** — persist requests to the sidebar with name, method, URL, headers, cookies, body, and AI prompt. Export/import as JSON.
- **AI Assist** — describe a request in natural language (or paste a curl command); an OpenAI-compatible API fills the form. Missing values become `{{PLACEHOLDER}}` tokens you're prompted to fill.
- **Try with requests** — one click downloads a standalone `generated.py` script using the `requests` library, ready to run offline.
- **Export / Import** — share request collections as JSON files.
- **Admin panel** (`/admin`) — configure AI API base/key/model, admin credentials, manage users.
- **Themes** — dark (default) and light, per-browser.
- **Responsive** — works on mobile (sidebar becomes a drawer).

---

## Quick start

### Prerequisites

- Python 3.9+
- A virtual environment (recommended)

### Install

```powershell
python -m venv .venv
.venv\Scripts\activate
uv pip install -r requirements.txt
```

### Run

```powershell
# MUST use the venv uvicorn — system uvicorn may lack deps
.venv\Scripts\uvicorn.exe main:app --reload
```

App served at **http://localhost:5555**.

Admin panel at **http://localhost:5555/admin**.

> **Local dev (file SQLite):** without `TURSO_URL`/`TURSO_TOKEN` set, the app
> falls back to a local file `curlix.db`. Set the Turso env vars to use the
> serverless DB even locally.

### Default admin

On first run a default admin is created:

- **Username:** `admin`
- **Password:** `admin`

**Change this immediately** via the admin panel. If you forget the password, reset it:

```powershell
TURSO_URL=... TURSO_TOKEN=... uv run python reset_admin.py [new_password]
# defaults to "admin" if no arg
```

---

## Deploy to Vercel (free tier)

Curlix runs on Vercel serverless with [Turso](https://turso.tech) as the
SQLite backend (so data persists across cold starts). No credit card needed
for either.

### 1. Create a Turso database

```bash
pip install turso
turso auth signup          # sign in with GitHub
turso db create curlix
turso db tokens create curlix   # → copy the token
turso db show curlix --url      # → copy the libsql:// URL
```

### 2. Set Vercel env vars

In your Vercel project settings → Environment Variables, add:

| Name | Value |
|-----|-------|
| `TURSO_URL` | `libsql://curlix-<you>.turso.io` |
| `TURSO_TOKEN` | (the token from `turso db tokens create`) |

### 3. Deploy

Push to GitHub → import the repo into Vercel → deploy. `vercel.json` routes
all traffic to `main.py` (FastAPI ASGI). Tables auto-create on first cold start.

### Caveats (Vercel/Linux)

- **Kerberos auth unavailable** — `requests_kerberos` needs system GSSAPI
  libs that don't exist on Vercel. The option is silently ignored if the lib
  isn't installed. NTLM (`requests_ntlm`) still works.
- **Cold starts** ~1-2s after idle; warm requests are fast.
- `curlix.db` file is unused on Vercel (Turso is the source of truth).

---

---

## Configuration

### AI Assist (server-side fallback)

Configure in the admin panel (`/admin` → AI Settings). Used as fallback when a user hasn't set their own AI config in the homepage Settings tab.

| Field | Description |
|-------|-------------|
| API Base URL | OpenAI-compatible base, e.g. `https://api.openai.com/v1` |
| API Key | `sk-...` |
| Model | e.g. `gpt-4o-mini` |
| Call API | `responses` (`/responses`) or `completions` (`/chat/completions`) |
| Response Style | `strict_json` (recommended), `compact`, `detailed` |

Homepage users can override AI config in their own Settings tab (stored in `localStorage`, never sent to server). Empty fields fall back to the admin-configured server values.

### Proxy & Auth

In the homepage Settings tab:

- **Proxy URL / User / Pass** — HTTP proxy for outgoing requests. Saved server-side.
- **NT ID / Password** — Basic auth credentials sent with every request. Saved server-side.

Per-request options (checkboxes on each request tab):

- **Use Proxy** — apply the configured proxy to this request.
- **Use NTLM** — Windows SSPI NTLM auth (`requests-negotiate-sspi`, no KfW needed).
- **Use Kerberos** — Kerberos SPNEGO (`requests-kerberos`).

### Environment variables

Managed in the Env sidebar panel. Key/value pairs. Referenced as `{{KEY}}` in URL, header keys/values, cookie keys/values, and body. Resolved at send time.

---

## Data storage

All data in a single SQLite file: **`curlix.db`** (next to `main.py`).

| Table | Content |
|-------|---------|
| `users` | User IDs + roles |
| `user_aliases` | Human-readable handles |
| `settings` | Key/value config (AI, proxy, auth, admin creds) |
| `saved_requests` | Saved requests (name, method, url, headers, cookies, body, ai_desc) |
| `history` | Request history (request + response data) |
| `env_vars` | Environment variables |
| `collections` | Request collections |

Inspect directly:

```powershell
.venv\Scripts\python.exe -c "import sqlite3; c=sqlite3.connect('curlix.db'); print([r[0] for r in c.execute('SELECT name FROM sqlite_master WHERE type=\"table\"').fetchall()])"
```

---

## Architecture

Single-file FastAPI backend + vanilla JS/HTML/CSS frontend. No build step.

```
main.py          # FastAPI app: /api/proxy, /api/ai-fill, static mount, /admin route
admin.py         # Admin/auth router: users, saved requests, history, env, collections, settings
db.py            # SQLite layer (init, migrations, CRUD)
gettoken.py      # Token helper
reset_admin.py   # Admin password reset script
static/
  index.html     # Main app shell
  admin.html     # Admin panel
  app.js         # All frontend logic
  style.css      # Styling
  logo.png
  favicon.png
requirements.txt
```

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/proxy` | Proxy a request (avoids browser CORS). Supports proxy, NTLM, Kerberos. SSL verification off. |
| POST | `/api/ai-fill` | Convert natural language → request object. Falls back to server AI config when client omits. |
| GET / POST | `/api/settings` | Read/write settings (admin: full; non-admin: safe subset). |
| GET / POST / PUT / DELETE | `/api/saved-requests[/{id}]` | CRUD saved requests. |
| GET / POST / DELETE | `/api/history[/{id}]` | History list, add, clear. |
| GET / PUT / DELETE | `/api/env-vars[/{id}]` | Environment variables. |
| POST | `/api/login` / `/api/logout` | Admin session. |
| GET | `/api/admin/users` | User management (admin). |
| GET | `/api/user/info` / `/rename` / `/api/switch-device` | User identity. |

---

## Try with requests

Each request tab has a **🐍 Try with requests** button under the Body field. It downloads `generated.py` — a standalone script using the `requests` library that reproduces the exact request (method, URL, headers, cookies, body, proxy, `verify=False`). Run it anywhere:

```powershell
python generated.py
```

Useful for debugging, CI, or sharing a reproducible request outside the app.

---

## Development notes

- **Always use `.venv\Scripts\uvicorn.exe`**, not system uvicorn — the system Python may lack `requests-negotiate-sspi` and other deps.
- Static files are served via `StaticFiles` mount. Bump `app.js?v=N` in `index.html` after JS changes to bust browser cache.
- `/admin` route sends no-cache headers so admin HTML updates are picked up immediately.
- DB migrations are idempotent `ALTER TABLE ADD COLUMN` checks in `init_db()`.

---

## License

Private / internal.
