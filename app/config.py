"""App configuration: FastAPI instance, DB init, default admin bootstrap, logging."""
import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .db import init_db, get_settings, save_settings

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def create_app() -> FastAPI:
    """App factory: init DB, bootstrap default admin, configure CORS."""
    app = FastAPI()

    init_db()

    # Auto-create default admin on first run
    settings = get_settings()
    admin = settings.get("admin")
    if not admin:
        import hashlib, secrets
        salt = secrets.token_hex(16)
        pw_hash = f"{salt}${hashlib.sha256((salt + 'admin').encode()).hexdigest()}"
        settings["admin"] = {"username": "admin", "password_hash": pw_hash}
        save_settings(settings)
        logger.info("[config] Created default admin user")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    return app
