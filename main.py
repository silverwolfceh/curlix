"""Curlix entrypoint: assembles the app, mounts routers, serves static files."""

from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from app.config import create_app

app = create_app()


# ── Routers ───────────────────────────────────────────────────────────────────

from app.auth_routes import router as auth_router
from app.user_auth_routes import router as user_auth_router
from app.proxy import router as proxy_router
from app.llm import router as llm_router
from app.settings import router as settings_router
from app.saved_requests import router as saved_requests_router
from app.history import router as history_router
from app.env_vars import router as env_vars_router
from app.collections_routes import router as collections_router
from app.users import router as users_router

for r in (
    auth_router,
    user_auth_router,
    proxy_router,
    llm_router,
    settings_router,
    saved_requests_router,
    history_router,
    env_vars_router,
    collections_router,
    users_router,
):
    app.include_router(r)


# ── Admin page + static files ─────────────────────────────────────────────────

_NO_CACHE = {
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
}

@app.get("/admin")
async def admin_redirect():
    html = open("static/admin.html", encoding="utf-8").read()
    return HTMLResponse(html, headers=_NO_CACHE)


# Explicit `/` route with no-cache so the browser always revalidates index.html
# and picks up the latest `app.js?v=N` bump. Without this, a stale cached
# index.html keeps loading an old JS version (broke anon mode after the
# account refactor: old app.js redirected to /admin on any 401).
@app.get("/")
async def index():
    html = open("static/index.html", encoding="utf-8").read()
    return HTMLResponse(html, headers=_NO_CACHE)


app.mount("/", StaticFiles(directory="static", html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=5555, reload=False)
