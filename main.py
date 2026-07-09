"""Curlix entrypoint: assembles the app, mounts routers, serves static files."""
import os
import uuid

from fastapi import Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from app.config import create_app
from app.db import ensure_user, ensure_user_sync

app = create_app()


# ── User resolution middleware ────────────────────────────────────────────────

@app.middleware("http")
async def resolve_user(request: Request, call_next):
    """Resolve user_id from cookie or header. Auto-create user. Set cookie.
    Skipped for /admin and /api/ — those resolve user inside their handlers.
    """
    if request.url.path == "/admin" or request.url.path.startswith("/api/"):
        return await call_next(request)

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

    response = await call_next(request)
    existing_cookie = response.headers.get("set-cookie", "")
    if "opm_uid=" not in existing_cookie:
        response.set_cookie(
            key="opm_uid",
            value=user_id,
            path="/",
            httponly=True,
            samesite="lax",
            max_age=365 * 24 * 3600,
        )
    request.state.user_id = user_id
    return response


# ── Routers ───────────────────────────────────────────────────────────────────

from app.auth_routes import router as auth_router
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

@app.get("/admin")
async def admin_redirect():
    html_path = os.path.join(os.path.dirname(__file__), "static", "admin.html")
    html = open(html_path, encoding="utf-8").read()
    return HTMLResponse(html, headers={
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
    })


app.mount("/", StaticFiles(directory=os.path.join(os.path.dirname(__file__), "static"), html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=5555, reload=False)
