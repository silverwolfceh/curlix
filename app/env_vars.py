"""Environment variables router: /api/env-vars."""
from fastapi import APIRouter, Request

from .db import list_env_vars, save_env_vars, delete_env_var
from .auth import get_user_id
from .models import EnvVarsRequest

router = APIRouter()


@router.get("/api/env-vars")
async def get_env_vars(request: Request):
    await get_user_id(request)
    return list_env_vars(request.state.user_id)


@router.put("/api/env-vars")
async def save_env_vars_api(request: Request, body: EnvVarsRequest):
    await get_user_id(request)
    save_env_vars(request.state.user_id, body.vars)
    return {"ok": True}


@router.delete("/api/env-vars/{env_id}")
async def delete_env_var_api(request: Request, env_id: int):
    await get_user_id(request)
    delete_env_var(request.state.user_id, env_id)
    return {"ok": True}
