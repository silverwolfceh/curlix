"""Collections router: CRUD /api/collections."""
from fastapi import APIRouter, Request

from .db import (
    list_collections, create_collection, update_collection, delete_collection,
)
from .auth import get_user_id

router = APIRouter()


@router.get("/api/collections")
async def get_collections(request: Request):
    await get_user_id(request)
    return list_collections(request.state.user_id)


@router.post("/api/collections")
async def create_collection_api(request: Request, data: dict):
    await get_user_id(request)
    cid = create_collection(
        request.state.user_id,
        name=data.get("name", ""),
        request_ids=data.get("request_ids"),
    )
    return {"id": cid}


@router.put("/api/collections/{c_id}")
async def update_collection_api(request: Request, c_id: int, data: dict):
    await get_user_id(request)
    update_collection(
        request.state.user_id, c_id,
        name=data.get("name", ""),
        request_ids=data.get("request_ids"),
    )
    return {"ok": True}


@router.delete("/api/collections/{c_id}")
async def delete_collection_api(request: Request, c_id: int):
    await get_user_id(request)
    delete_collection(request.state.user_id, c_id)
    return {"ok": True}
