import base64
import binascii
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from core.entity_store import entity_store


def build_entity_router(
    *,
    client,
    token_manager,
    require_service_api_key,
) -> APIRouter:
    router = APIRouter()

    def _get_token() -> str:
        token = token_manager.get_available(strategy=client.token_rotation_strategy)
        if not token:
            raise HTTPException(status_code=503, detail="No active tokens available")
        return token

    def _image_from_value(value: Any) -> tuple[bytes, str]:
        raw = str(value or "").strip()
        if not raw:
            raise HTTPException(status_code=400, detail="entity image is empty")
        mime_type = "image/png"
        if raw.startswith("data:"):
            head, sep, body = raw.partition(",")
            if not sep:
                raise HTTPException(status_code=400, detail="invalid data URL image")
            mime_part = head[5:]
            if ";" in mime_part:
                mime_type = mime_part.split(";", 1)[0] or mime_type
            elif mime_part:
                mime_type = mime_part
            raw = body
        try:
            image_bytes = base64.b64decode(raw, validate=True)
        except binascii.Error:
            raise HTTPException(status_code=400, detail="invalid base64 image data")
        if not image_bytes:
            raise HTTPException(status_code=400, detail="entity image is empty")
        if len(image_bytes) > 10 * 1024 * 1024:
            raise HTTPException(status_code=400, detail="entity image too large, max 10MB")
        normalized_mime = str(mime_type or "image/png").lower()
        if normalized_mime == "image/jpg":
            normalized_mime = "image/jpeg"
        if normalized_mime not in {"image/png", "image/jpeg", "image/webp"}:
            normalized_mime = "image/png"
        return image_bytes, normalized_mime

    def _entity_name(item: dict) -> str:
        entity_value = item.get("entityValue")
        if isinstance(entity_value, dict):
            name = str(entity_value.get("displayName") or "").strip()
            if name:
                return name
        return str(item.get("name") or item.get("displayName") or "").strip()

    def _entity_urn(item: dict) -> str:
        for key in ("id", "urn", "entityId", "entityUrn"):
            value = str(item.get(key) or "").strip()
            if value:
                return value
        entity = item.get("entity")
        if isinstance(entity, dict):
            return _entity_urn(entity)
        return ""

    def _entity_type(item: dict) -> str:
        return str(item.get("type") or item.get("entityType") or "").strip()

    @router.post("/v1/entities")
    def create_entity(data: dict, request: Request):
        require_service_api_key(request)
        name = str(data.get("name") or data.get("displayName") or "").strip()
        if not name:
            raise HTTPException(status_code=400, detail="name is required")
        entity_type = str(data.get("type") or data.get("entityType") or "character").strip()
        if entity_type not in {"character", "object", "location"}:
            raise HTTPException(
                status_code=400,
                detail="type must be one of: character, object, location",
            )
        images = data.get("images") or []
        if not isinstance(images, list) or not images:
            raise HTTPException(status_code=400, detail="images must contain 1-4 items")
        if len(images) > 4:
            raise HTTPException(status_code=400, detail="images supports at most 4 items")
        token = _get_token()
        account_id = token_manager.account_id_from_token(token)
        token_meta = token_manager.get_meta_by_value(token)
        try:
            request.state.log_token_id = token_meta.get("token_id")
            request.state.log_token_account_id = token_meta.get("token_account_id")
            request.state.log_token_account_name = token_meta.get("token_account_name")
            request.state.log_token_account_email = token_meta.get("token_account_email")
            request.state.log_token_source = token_meta.get("token_source")
            request.state.log_token_attempt = 1
            request.state.log_task_status = "IN_PROGRESS"
            request.state.log_task_progress = 0.0
        except Exception:
            pass
        repo = client.resolve_repo_urn(token)
        entity_data = client.create_entity(
            token=token,
            display_name=name,
            entity_type=entity_type,
            description=str(data.get("description") or ""),
        )
        entity_id = _entity_urn(entity_data)
        if not entity_id:
            for item in client.list_entities(token, limit=100):
                if _entity_name(item) == name:
                    entity_id = _entity_urn(item)
                    break
        if not entity_id:
            raise HTTPException(status_code=502, detail="entity created but no id returned")

        component_upload_href = client.entity_component_upload_href(entity_data)
        components = []
        for image in images:
            image_bytes, mime_type = _image_from_value(image)
            components.append(
                client.upload_entity_image(
                    token=token,
                    repo_urn=repo,
                    entity_name=name,
                    image_bytes=image_bytes,
                    mime_type=mime_type,
                    component_upload_href=component_upload_href,
                )
            )
        client.register_entity_base_resources(token, entity_id, components)
        entity_store.upsert(
            entity_id=entity_id,
            name=name,
            entity_type=entity_type,
            account_id=account_id,
            account_name=str(token_meta.get("token_account_name") or ""),
            account_email=str(token_meta.get("token_account_email") or ""),
        )
        try:
            request.state.log_task_status = "COMPLETED"
            request.state.log_task_progress = 100.0
            request.state.log_upstream_job_id = entity_id
            request.state.log_model = f"entity:{entity_type}"
            request.state.log_prompt_preview = f"entity: {name}"
        except Exception:
            pass
        return {
            "id": entity_id,
            "name": name,
            "type": entity_type,
            "image_count": len(components),
            "account_id": account_id,
            "account_name": str(token_meta.get("token_account_name") or ""),
            "account_email": str(token_meta.get("token_account_email") or ""),
        }

    @router.get("/v1/entities")
    def list_entities(request: Request, limit: int = 50, sync: bool = False):
        require_service_api_key(request)
        if not sync:
            return {"entities": entity_store.list_all()}
        token = _get_token()
        account_id = token_manager.account_id_from_token(token)
        token_meta = token_manager.get_meta_by_value(token)
        items = []
        for item in client.list_entities(token, limit=limit):
            entity_id = _entity_urn(item)
            if not entity_id:
                continue
            name = _entity_name(item)
            entity_type = _entity_type(item)
            entity_store.upsert(
                entity_id=entity_id,
                name=name,
                entity_type=entity_type,
                account_id=account_id,
                account_name=str(token_meta.get("token_account_name") or ""),
                account_email=str(token_meta.get("token_account_email") or ""),
            )
            items.append(
                {
                    "id": entity_id,
                    "name": name,
                    "type": entity_type,
                    "account_id": account_id,
                }
            )
        return {"entities": items}

    @router.delete("/v1/entities/{entity_id:path}")
    def delete_entity(entity_id: str, request: Request):
        require_service_api_key(request)
        record = entity_store.get_by_id(entity_id)
        account_id = str((record or {}).get("account_id") or "").strip()
        token = (
            token_manager.get_available_for_account(
                account_id, strategy=client.token_rotation_strategy
            )
            if account_id
            else _get_token()
        )
        if not token:
            raise HTTPException(
                status_code=503,
                detail="No active token available for entity account",
            )
        deleted = client.delete_entity(token, entity_id)
        if deleted:
            entity_store.remove(entity_id)
        return {"deleted": deleted}

    return router
