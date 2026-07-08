"""Saved requests router: CRUD /api/saved-requests."""
from fastapi import APIRouter, Request

from .db import (
    list_requests, get_request, create_request, update_request, delete_request,
)
from .auth import get_user_id

router = APIRouter()


@router.get("/api/saved-requests")
async def get_saved_requests(request: Request):
    await get_user_id(request)
    return list_requests(request.state.user_id)


@router.post("/api/saved-requests")
async def create_saved_request(request: Request, data: dict):
    await get_user_id(request)
    rid = create_request(
        request.state.user_id,
        name=data.get("name", ""),
        method=data.get("method", "GET"),
        url=data.get("url", ""),
        headers=data.get("headers", {}),
        body=data.get("body", ""),
        tags=data.get("tags"),
        cookies=data.get("cookies", {}),
        ai_desc=data.get("ai_desc", ""),
    )
    return {"id": rid}


@router.get("/api/saved-requests/{req_id}")
async def get_saved_request(request: Request, req_id: int):
    await get_user_id(request)
    return get_request(request.state.user_id, req_id)


@router.put("/api/saved-requests/{req_id}")
async def update_saved_request(request: Request, req_id: int, data: dict):
    await get_user_id(request)
    update_request(
        request.state.user_id, req_id,
        name=data.get("name", ""),
        method=data.get("method", "GET"),
        url=data.get("url", ""),
        headers=data.get("headers", {}),
        body=data.get("body", ""),
        tags=data.get("tags"),
        cookies=data.get("cookies", {}),
        ai_desc=data.get("ai_desc", ""),
    )
    return {"ok": True}


@router.delete("/api/saved-requests/{req_id}")
async def delete_saved_request(request: Request, req_id: int):
    await get_user_id(request)
    delete_request(request.state.user_id, req_id)
    return {"ok": True}
