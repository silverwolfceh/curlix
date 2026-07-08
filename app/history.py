"""History router: list / add / clear / delete /api/history."""
from fastapi import APIRouter, Request

from .db import list_history, add_history, clear_history, delete_history_entry
from .auth import get_user_id

router = APIRouter()


@router.get("/api/history")
async def get_history(request: Request, limit: int = 100, offset: int = 0):
    await get_user_id(request)
    return list_history(request.state.user_id, limit, offset)


@router.post("/api/history")
async def add_history_api(request: Request, data: dict):
    await get_user_id(request)
    add_history(
        request.state.user_id,
        data.get("name") or "",
        data.get("method") or "GET",
        data.get("url") or "",
        data.get("request_headers") or "{}",
        data.get("request_body") or "",
        data.get("response_status") or 0,
        data.get("response_headers") or "{}",
        data.get("response_body") or "",
        data.get("request_cookies") or "{}",
    )
    return {"ok": True}


@router.delete("/api/history")
async def clear_user_history(request: Request):
    await get_user_id(request)
    clear_history(request.state.user_id)
    return {"ok": True}


@router.delete("/api/history/{h_id}")
async def delete_history_entry_api(request: Request, h_id: int):
    await get_user_id(request)
    delete_history_entry(request.state.user_id, h_id)
    return {"ok": True}
