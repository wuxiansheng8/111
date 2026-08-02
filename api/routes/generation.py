import re
import secrets
import threading
import time
import uuid
from dataclasses import asdict
from pathlib import Path
from typing import Any, Callable

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from starlette.background import BackgroundTask

from api.schemas import GenerateRequest
from core.entity_store import entity_store
from core.generation_archive import build_generation_archive
from core.media_mentions import LoadedMedia, count_media_kinds


def build_generation_router(
    *,
    store,
    video_task_queue,
    image_task_queue,
    token_manager,
    client,
    generated_dir: Path,
    model_catalog: dict,
    video_model_catalog: dict,
    supported_ratios: set,
    resolve_model: Callable[[str | None], dict],
    resolve_ratio_and_resolution: Callable[[dict, str | None], tuple[str, str, str]],
    require_service_api_key: Callable[[Request], None],
    require_admin_auth: Callable[[Request], None],
    set_request_task_progress: Callable[..., None],
    run_with_token_retries: Callable[..., Any],
    set_request_error_detail: Callable[..., str],
    set_request_preview: Callable[[Request, str, str], None],
    public_image_url: Callable[[Request, str], str],
    public_generated_url: Callable[[Request, str], str],
    resolve_video_options: Callable[[dict], tuple[bool, str, str]],
    load_input_images: Callable[[Any], list[tuple[bytes, str]]],
    load_input_media: Callable[[Any], list[LoadedMedia]],
    prepare_video_source_image: Callable[[bytes, str, str], tuple[bytes, str]],
    video_ext_from_meta: Callable[[dict], str],
    extract_prompt_from_messages: Callable[[Any], str],
    sse_chat_stream: Callable[[dict], Any],
    on_generated_file_written: Callable[[Path, int, int], None],
    quota_error_cls,
    auth_error_cls,
    upstream_temp_error_cls,
    logger,
) -> APIRouter:
    router = APIRouter()
    entity_ref_re = re.compile(r"@entity:([^\s@]+)")

    def _public_context(request: Request) -> dict:
        forwarded_host = str(request.headers.get("x-forwarded-host") or "").strip()
        forwarded_proto = str(request.headers.get("x-forwarded-proto") or "").strip()
        return {
            "host": forwarded_host or str(request.url.netloc),
            "proto": forwarded_proto or str(request.url.scheme or "http"),
            "prefix": str(request.headers.get("x-forwarded-prefix") or "").strip(),
        }

    def _archive_response(queue, media_type: str):
        result = build_generation_archive(
            queue.list(limit=10_000),
            generated_dir,
            media_type,
        )
        if result is None:
            raise HTTPException(status_code=404, detail="没有可下载的已完成文件")

        archive_path, filename, count = result
        return FileResponse(
            archive_path,
            filename=filename,
            media_type="application/zip",
            headers={"X-Archive-File-Count": str(count)},
            background=BackgroundTask(archive_path.unlink, missing_ok=True),
        )

    def _image_reference_count(messages: Any) -> int:
        count = 0
        for message in messages if isinstance(messages, list) else []:
            content = message.get("content") if isinstance(message, dict) else None
            for item in content if isinstance(content, list) else []:
                if isinstance(item, dict) and item.get("type") == "image_url":
                    count += 1
        return count

    def _image_quality(data: dict, model_conf: dict) -> str | None:
        if str(model_conf.get("upstream_model_id") or "") != "gpt-image":
            return None
        quality = str(data.get("quality") or client.gpt_image_quality or "medium").lower()
        if quality not in {"low", "medium", "high"}:
            raise HTTPException(status_code=400, detail="quality must be low, medium, or high")
        return quality

    def _image_ground_search(data: dict, model_conf: dict) -> bool:
        if str(model_conf.get("upstream_model_version") or "") != "nano-banana-3":
            return False
        value = data.get("ground_search", data.get("groundSearch", False))
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "yes", "on"}
        return bool(value)

    def _nanoid(size: int = 21) -> str:
        alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_"
        return "".join(secrets.choice(alphabet) for _ in range(size))

    def _entity_name(item: dict) -> str:
        entity_value = item.get("entityValue")
        if isinstance(entity_value, dict):
            name = str(entity_value.get("displayName") or "").strip()
            if name:
                return name
        return str(item.get("name") or item.get("displayName") or "").strip()

    def _entity_urn(item: dict) -> str:
        for key in ("id", "urn", "entityId", "entityUrn"):
            val = str(item.get(key) or "").strip()
            if val:
                return val
        entity = item.get("entity")
        if isinstance(entity, dict):
            return _entity_urn(entity)
        return ""

    def _entity_names_from_prompt(raw_prompt: str) -> list[str]:
        matches = list(entity_ref_re.finditer(raw_prompt or ""))
        names: list[str] = []
        for match in matches:
            name = match.group(1).strip()
            if name and name not in names:
                names.append(name)
        return names

    def _sync_entity_by_name(name: str) -> list[dict]:
        found: list[dict] = []
        for token_info in token_manager.list_active_account_tokens():
            token = str(token_info.get("token") or "").strip()
            account_id = str(token_info.get("account_id") or "").strip()
            if not token or not account_id:
                continue
            try:
                entities = client.list_entities(token, limit=100)
            except Exception:
                continue
            for item in entities:
                item_name = _entity_name(item)
                if item_name != name:
                    continue
                urn = _entity_urn(item)
                if not urn:
                    continue
                found.append(
                    entity_store.upsert(
                        entity_id=urn,
                        name=item_name,
                        entity_type=str(item.get("entityType") or item.get("type") or ""),
                        account_id=account_id,
                        account_name=str(token_info.get("account_name") or ""),
                        account_email=str(token_info.get("account_email") or ""),
                    )
                )
        return found

    def _resolve_entity_bindings(raw_prompt: str) -> tuple[str, list[dict]]:
        refs: list[dict] = []
        account_id = ""
        for name in _entity_names_from_prompt(raw_prompt):
            matches = entity_store.find_by_name(name)
            if not matches:
                matches = _sync_entity_by_name(name)
            account_ids = {
                str(item.get("account_id") or "").strip()
                for item in matches
                if str(item.get("account_id") or "").strip()
            }
            if not matches:
                raise HTTPException(status_code=400, detail=f"entity not found: {name}")
            if len(account_ids) > 1:
                raise HTTPException(
                    status_code=400,
                    detail=f"entity name is ambiguous across accounts: {name}",
                )
            if len(matches) > 1 and len({str(item.get("id") or "") for item in matches}) > 1:
                raise HTTPException(
                    status_code=400,
                    detail=f"entity name is ambiguous: {name}",
                )
            current_account = next(iter(account_ids), "")
            if not current_account:
                raise HTTPException(status_code=400, detail=f"entity has no account: {name}")
            if account_id and account_id != current_account:
                raise HTTPException(
                    status_code=400,
                    detail="entities in one prompt must belong to the same Adobe account",
                )
            account_id = current_account
            refs.append(
                {
                    "name": name,
                    "urn": str(matches[0].get("id") or "").strip(),
                    "account_id": account_id,
                }
            )
        return account_id, refs

    def _resolve_kling_entity_refs(
        token: str,
        raw_prompt: str,
        bound_refs: list[dict] | None = None,
    ) -> tuple[str, list[dict]]:
        matches = list(entity_ref_re.finditer(raw_prompt or ""))
        if not matches:
            return raw_prompt, []
        if bound_refs is not None:
            by_name = {str(item.get("name") or "").strip(): item for item in bound_refs}
        else:
            entities = client.list_entities(token, limit=100)
            by_name = {_entity_name(item): item for item in entities if _entity_name(item)}
        refs: list[dict] = []
        replacements: dict[str, str] = {}
        for match in matches:
            name = match.group(1).strip()
            if name in replacements:
                continue
            item = by_name.get(name)
            if not item:
                raise HTTPException(status_code=400, detail=f"entity not found: {name}")
            urn = str(item.get("urn") or "").strip() if bound_refs is not None else _entity_urn(item)
            if not urn:
                raise HTTPException(status_code=400, detail=f"entity has no urn: {name}")
            mention_id = _nanoid()
            replacements[name] = mention_id
            refs.append({"name": name, "urn": urn, "mention_id": mention_id})

        def replace_match(match: re.Match) -> str:
            return f"@{replacements[match.group(1).strip()]}"

        return entity_ref_re.sub(replace_match, raw_prompt), refs

    @router.get("/v1/models")
    def list_models(request: Request):
        require_service_api_key(request)
        data = []
        for model_id, conf in model_catalog.items():
            data.append(
                {
                    "id": model_id,
                    "object": "model",
                    "owned_by": "adobe2api",
                    "description": conf["description"],
                }
            )
        for model_id, conf in video_model_catalog.items():
            if bool(conf.get("hidden", False)):
                continue
            data.append(
                {
                    "id": model_id,
                    "object": "model",
                    "owned_by": "adobe2api",
                    "description": conf["description"],
                }
            )
        return {"object": "list", "data": data}

    @router.post("/v1/videos", status_code=202)
    def create_video_task(data: dict, request: Request):
        require_service_api_key(request)
        model_id = str(data.get("model") or "").strip()
        if model_id not in video_model_catalog:
            raise HTTPException(status_code=400, detail="unsupported video model")
        prompt = extract_prompt_from_messages(data.get("messages") or [])
        if not prompt:
            prompt = str(data.get("prompt") or "").strip()
        if not prompt:
            raise HTTPException(status_code=400, detail="messages or prompt is required")

        task = video_task_queue.submit(data, _public_context(request))
        return {"task_id": task["id"], **task}

    @router.get("/v1/videos")
    def list_video_tasks(request: Request, limit: int = 100):
        require_service_api_key(request)
        return {"object": "list", "data": video_task_queue.list(limit=limit)}

    @router.get("/api/v1/studio/videos/archive")
    def download_video_archive(request: Request):
        require_admin_auth(request)
        return _archive_response(video_task_queue, "video")

    @router.delete("/v1/videos")
    def clear_stopped_video_tasks(request: Request):
        require_service_api_key(request)
        removed_ids = video_task_queue.clear_terminal()
        return {
            "status": "ok",
            "deleted_count": len(removed_ids),
            "deleted_ids": removed_ids,
        }

    @router.get("/v1/videos/{task_id}")
    def get_video_task(task_id: str, request: Request):
        require_service_api_key(request)
        task = video_task_queue.get(task_id)
        if not task:
            raise HTTPException(status_code=404, detail="task not found")
        return task

    @router.delete("/v1/videos/{task_id}")
    def cancel_video_task(task_id: str, request: Request):
        require_service_api_key(request)
        task = video_task_queue.cancel(task_id)
        if not task:
            raise HTTPException(status_code=404, detail="task not found")
        if task.get("status") != "cancelled":
            raise HTTPException(status_code=409, detail="only queued tasks can be cancelled")
        return task

    @router.post("/v1/images/tasks", status_code=202)
    def create_image_task(data: dict, request: Request):
        require_service_api_key(request)
        model_id = str(data.get("model") or "").strip()
        if not model_id.startswith(("firefly-nano-banana2-", "firefly-gpt-image-")):
            raise HTTPException(status_code=400, detail="unsupported studio image model")
        if model_id not in model_catalog:
            raise HTTPException(status_code=400, detail="unsupported image model")
        prompt = extract_prompt_from_messages(data.get("messages") or [])
        if not prompt:
            prompt = str(data.get("prompt") or "").strip()
        if not prompt:
            raise HTTPException(status_code=400, detail="messages or prompt is required")
        if _image_reference_count(data.get("messages")) > 6:
            raise HTTPException(status_code=400, detail="at most 6 reference images are supported")
        _image_quality(data, model_catalog[model_id])
        task = image_task_queue.submit(data, _public_context(request))
        return {"task_id": task["id"], **task}

    @router.get("/v1/images/tasks")
    def list_image_tasks(request: Request, limit: int = 100):
        require_service_api_key(request)
        return {"object": "list", "data": image_task_queue.list(limit=limit)}

    @router.get("/api/v1/studio/images/archive")
    def download_image_archive(request: Request):
        require_admin_auth(request)
        return _archive_response(image_task_queue, "image")

    @router.delete("/v1/images/tasks")
    def clear_stopped_image_tasks(request: Request):
        require_service_api_key(request)
        removed_ids = image_task_queue.clear_terminal()
        return {
            "status": "ok",
            "deleted_count": len(removed_ids),
            "deleted_ids": removed_ids,
        }

    @router.get("/v1/images/tasks/{task_id}")
    def get_image_task(task_id: str, request: Request):
        require_service_api_key(request)
        task = image_task_queue.get(task_id)
        if not task:
            raise HTTPException(status_code=404, detail="task not found")
        return task

    @router.delete("/v1/images/tasks/{task_id}")
    def cancel_image_task(task_id: str, request: Request):
        require_service_api_key(request)
        task = image_task_queue.cancel(task_id)
        if not task:
            raise HTTPException(status_code=404, detail="task not found")
        if task.get("status") != "cancelled":
            raise HTTPException(status_code=409, detail="only queued tasks can be cancelled")
        return task

    @router.post("/v1/images/generations")
    def openai_generate(data: dict, request: Request):
        require_service_api_key(request)

        prompt = data.get("prompt", "").strip()
        if not prompt:
            return JSONResponse(
                status_code=400,
                content={
                    "error": {
                        "message": "prompt is required",
                        "type": "invalid_request_error",
                    }
                },
            )

        model_id = data.get("model")
        if str(model_id or "").strip() in video_model_catalog:
            return JSONResponse(
                status_code=400,
                content={
                    "error": {
                        "message": "Use /v1/chat/completions for video generation",
                        "type": "invalid_request_error",
                    }
                },
            )
        ratio, output_resolution, resolved_model_id = resolve_ratio_and_resolution(
            data, model_id
        )
        model_conf = resolve_model(resolved_model_id)

        try:
            set_request_task_progress(
                request, task_status="IN_PROGRESS", task_progress=0.0
            )

            def _run_once(token: str):
                def _image_progress_cb(update: dict):
                    set_request_task_progress(
                        request,
                        task_status=str(update.get("task_status") or "IN_PROGRESS"),
                        task_progress=update.get("task_progress"),
                        upstream_job_id=update.get("upstream_job_id"),
                        retry_after=update.get("retry_after"),
                        error=update.get("error"),
                    )

                job_id = uuid.uuid4().hex
                out_path = generated_dir / f"{job_id}.png"
                old_size = 0
                try:
                    if out_path.exists():
                        old_size = int(out_path.stat().st_size)
                except Exception:
                    old_size = 0

                image_bytes, _meta = client.generate(
                    token=token,
                    prompt=prompt,
                    aspect_ratio=ratio,
                    output_resolution=output_resolution,
                    upstream_model_id=str(
                        model_conf.get("upstream_model_id") or "gemini-flash"
                    ),
                    upstream_model_version=str(
                        model_conf.get("upstream_model_version") or "nano-banana-2"
                    ),
                    quality_level=_image_quality(data, model_conf),
                    detail_level=model_conf.get("detail_level"),
                    ground_search=_image_ground_search(data, model_conf),
                    timeout=client.generate_timeout,
                    out_path=out_path,
                    progress_cb=_image_progress_cb,
                )
                if image_bytes is not None:
                    out_path.write_bytes(image_bytes)
                new_size = int(out_path.stat().st_size) if out_path.exists() else 0
                on_generated_file_written(out_path, old_size, new_size)
                image_url = public_image_url(request, job_id)
                set_request_preview(request, image_url, kind="image")
                return {
                    "created": int(time.time()),
                    "model": resolved_model_id,
                    "data": [{"url": image_url}],
                }

            return run_with_token_retries(
                request=request,
                operation_name="images.generations",
                run_once=_run_once,
            )

        except quota_error_cls:
            error_code = str(
                getattr(request.state, "log_error_code", "") or ""
            ) or set_request_error_detail(
                request,
                error="Token quota exhausted",
                status_code=429,
                error_type="rate_limit_error",
                include_traceback=False,
            )
            set_request_task_progress(
                request,
                task_status="FAILED",
                task_progress=0.0,
                error="Token quota exhausted",
            )
            return JSONResponse(
                status_code=429,
                content={
                    "error": {
                        "message": "Token quota exhausted",
                        "type": "rate_limit_error",
                        "code": error_code,
                    }
                },
            )
        except auth_error_cls:
            error_code = str(
                getattr(request.state, "log_error_code", "") or ""
            ) or set_request_error_detail(
                request,
                error="Token invalid or expired",
                status_code=401,
                error_type="authentication_error",
                include_traceback=False,
            )
            set_request_task_progress(
                request,
                task_status="FAILED",
                task_progress=0.0,
                error="Token invalid or expired",
            )
            return JSONResponse(
                status_code=401,
                content={
                    "error": {
                        "message": "Token invalid or expired",
                        "type": "authentication_error",
                        "code": error_code,
                    }
                },
            )
        except upstream_temp_error_cls as exc:
            error_code = str(
                getattr(request.state, "log_error_code", "") or ""
            ) or set_request_error_detail(
                request,
                error=exc,
                status_code=503,
                error_type="server_error",
                include_traceback=False,
            )
            set_request_task_progress(
                request, task_status="FAILED", task_progress=0.0, error=str(exc)
            )
            return JSONResponse(
                status_code=503,
                content={
                    "error": {
                        "message": str(exc),
                        "type": "server_error",
                        "code": error_code,
                    }
                },
            )
        except HTTPException as exc:
            err_type = (
                "invalid_request_error"
                if 400 <= int(exc.status_code) < 500
                else "server_error"
            )
            error_code = set_request_error_detail(
                request,
                error=str(exc.detail),
                status_code=exc.status_code,
                error_type=err_type,
                include_traceback=False,
            )
            set_request_task_progress(
                request, task_status="FAILED", task_progress=0.0, error=str(exc.detail)
            )
            return JSONResponse(
                status_code=exc.status_code,
                content={
                    "error": {
                        "message": str(exc.detail),
                        "type": err_type,
                        "code": error_code,
                    }
                },
            )
        except Exception as exc:
            error_code = set_request_error_detail(
                request,
                error=exc,
                status_code=500,
                error_type="server_error",
                include_traceback=True,
            )
            logger.exception(
                "Unhandled error in /v1/images/generations log_id=%s model=%s",
                getattr(request.state, "log_id", ""),
                resolved_model_id,
            )
            set_request_task_progress(
                request, task_status="FAILED", task_progress=0.0, error=str(exc)
            )
            return JSONResponse(
                status_code=500,
                content={
                    "error": {
                        "message": str(exc),
                        "type": "server_error",
                        "code": error_code,
                    }
                },
            )

    @router.post("/api/v1/generate")
    def create_job(data: GenerateRequest, request: Request):
        require_service_api_key(request)

        prompt = data.prompt.strip()
        if not prompt:
            raise HTTPException(status_code=400, detail="prompt cannot be empty")

        ratio = data.aspect_ratio.strip() or "16:9"
        if ratio not in supported_ratios:
            raise HTTPException(status_code=400, detail="unsupported aspect ratio")

        output_resolution = (data.output_resolution or "2K").upper()
        if output_resolution not in {"1K", "2K", "4K"}:
            raise HTTPException(status_code=400, detail="unsupported output_resolution")

        model_conf = resolve_model(data.model)
        if data.model:
            output_resolution = model_conf["output_resolution"]

        job = store.create(prompt=prompt, aspect_ratio=ratio)

        def runner(job_id: str):
            store.update(job_id, status="running", progress=5.0)
            max_attempts = client.retry_max_attempts if client.retry_enabled else 1
            max_attempts = max(1, int(max_attempts))
            last_error = "No active tokens available in the pool"

            for attempt in range(1, max_attempts + 1):
                token = token_manager.get_available(
                    strategy=client.token_rotation_strategy
                )
                if not token:
                    break

                try:
                    out_path = generated_dir / f"{job_id}.png"
                    old_size = 0
                    try:
                        if out_path.exists():
                            old_size = int(out_path.stat().st_size)
                    except Exception:
                        old_size = 0

                    image_bytes, meta = client.generate(
                        token=token,
                        prompt=prompt,
                        aspect_ratio=ratio,
                        output_resolution=output_resolution,
                        upstream_model_id=str(
                            model_conf.get("upstream_model_id") or "gemini-flash"
                        ),
                        upstream_model_version=str(
                            model_conf.get("upstream_model_version") or "nano-banana-2"
                        ),
                        quality_level=(
                            client.gpt_image_quality
                            if str(model_conf.get("upstream_model_id") or "") == "gpt-image"
                            else None
                        ),
                        detail_level=model_conf.get("detail_level"),
                        ground_search=bool(
                            data.ground_search
                            and str(model_conf.get("upstream_model_version") or "")
                            == "nano-banana-3"
                        ),
                        out_path=out_path,
                    )
                    if image_bytes is not None:
                        out_path.write_bytes(image_bytes)
                    new_size = int(out_path.stat().st_size) if out_path.exists() else 0
                    on_generated_file_written(out_path, old_size, new_size)
                    progress = float(meta.get("progress") or 100.0)
                    image_url = public_image_url(request, job_id)
                    store.update(
                        job_id,
                        status="succeeded",
                        progress=max(progress, 100.0),
                        image_url=image_url,
                    )
                    return
                except quota_error_cls:
                    token_manager.report_exhausted(token)
                    last_error = "Token quota exhausted."
                    retryable = attempt < max_attempts
                except auth_error_cls:
                    token_manager.report_invalid(token)
                    last_error = "Token invalid or expired."
                    retryable = attempt < max_attempts
                except upstream_temp_error_cls as exc:
                    last_error = str(exc)
                    retryable = (
                        attempt < max_attempts
                        and client.should_retry_temporary_error(exc)
                    )
                except Exception as exc:
                    store.update(job_id, status="failed", error=str(exc))
                    return

                if retryable:
                    delay = client._retry_delay_for_attempt(attempt)
                    if delay > 0:
                        time.sleep(delay)
                    continue
                break

            store.update(job_id, status="failed", error=last_error)

        threading.Thread(target=runner, args=(job.id,), daemon=True).start()

        return {"task_id": job.id, "status": job.status}

    @router.get("/api/v1/generate/{task_id}")
    def get_job(task_id: str, request: Request):
        require_service_api_key(request)

        job = store.get(task_id)
        if not job:
            raise HTTPException(status_code=404, detail="task not found")
        return asdict(job)

    @router.post("/v1/chat/completions")
    def chat_completions(data: dict, request: Request):
        require_service_api_key(request)

        prompt = extract_prompt_from_messages(data.get("messages") or [])
        if not prompt:
            prompt = str(data.get("prompt") or "").strip()
        if not prompt:
            return JSONResponse(
                status_code=400,
                content={
                    "error": {
                        "message": "messages or prompt is required",
                        "type": "invalid_request_error",
                    }
                },
            )

        model_id = str(data.get("model") or "").strip()
        if (
            model_id.startswith("firefly-sora2")
            or model_id.startswith("firefly-veo31-fast")
            or model_id.startswith("firefly-veo31-")
            or model_id.startswith("firefly-kling-")
            or model_id.startswith("firefly-seedance2")
        ) and model_id not in video_model_catalog:
            return JSONResponse(
                status_code=400,
                content={
                    "error": {
                        "message": "Invalid video model. Use /v1/models to get supported firefly-sora2-*, firefly-veo31-*, firefly-kling-* or firefly-seedance2-* models",
                        "type": "invalid_request_error",
                    }
                },
            )
        video_conf = video_model_catalog.get(model_id)
        is_video_model = video_conf is not None
        resolved_model_id = model_id if is_video_model else None
        ratio = "9:16"
        output_resolution = "2K"
        duration = int(video_conf["duration"]) if video_conf else 12
        video_resolution = (
            str(video_conf.get("resolution") or "720p") if video_conf else "720p"
        )
        if video_conf:
            ratio = str(video_conf.get("aspect_ratio") or ratio)
        video_engine = str(video_conf.get("engine") or "sora2") if video_conf else ""
        generate_audio = True
        negative_prompt = ""
        video_reference_mode = (
            str(video_conf.get("reference_mode") or "frame") if video_conf else "frame"
        )
        if is_video_model:
            resolved_video_options = resolve_video_options(data)
            if (
                isinstance(resolved_video_options, tuple)
                and len(resolved_video_options) == 3
            ):
                generate_audio, negative_prompt, requested_reference_mode = (
                    resolved_video_options
                )
                if "reference_mode" not in (video_conf or {}):
                    video_reference_mode = requested_reference_mode
            else:
                generate_audio, negative_prompt = resolved_video_options
            if not any(k in data for k in ("generate_audio", "generateAudio")):
                generate_audio = bool(video_conf.get("generate_audio", generate_audio))
            if video_engine == "seedance2" and video_reference_mode == "image":
                video_reference_mode = "media"
            supported_reference_modes = tuple(
                str(mode) for mode in video_conf.get("reference_modes") or ()
            )
            if (
                supported_reference_modes
                and video_reference_mode not in supported_reference_modes
            ):
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"{video_engine} supports reference_mode: "
                        f"{', '.join(supported_reference_modes)}"
                    ),
                )
        else:
            ratio, output_resolution, resolved_model_id = resolve_ratio_and_resolution(
                data, model_id or None
            )
        image_model_conf = (
            resolve_model(resolved_model_id) if not is_video_model else {}
        )

        try:
            entity_account_id = ""
            kling_bound_refs: list[dict] | None = None
            if video_engine == "kling-o3":
                entity_account_id, kling_bound_refs = _resolve_entity_bindings(prompt)
            queue_account_id = ""
            client_host = str(getattr(request.client, "host", "") or "").strip()
            if client_host in {"127.0.0.1", "::1", "localhost"}:
                queue_account_id = str(data.get("_queue_account_id") or "").strip()
            if entity_account_id and queue_account_id and entity_account_id != queue_account_id:
                raise HTTPException(
                    status_code=409,
                    detail="Kling entity belongs to a different queued account",
                )
            messages = data.get("messages") or []
            input_images = []
            input_media = []
            if is_video_model:
                if video_engine == "seedance2":
                    input_media = load_input_media(messages)
                else:
                    input_images = load_input_images(messages)
                    input_media = [
                        LoadedMedia(
                            content=image_bytes,
                            mime_type=image_mime,
                            kind="image",
                        )
                        for image_bytes, image_mime in input_images
                    ]
            else:
                input_images = load_input_images(messages)
            if video_engine == "seedance2" and (
                len(input_media) > 2
                or any(media.kind != "image" for media in input_media)
            ):
                video_reference_mode = "media"
            set_request_task_progress(
                request, task_status="IN_PROGRESS", task_progress=0.0
            )

            def _run_once(token: str):
                source_image_ids: list[str] = []
                image_url = ""
                response_content = ""

                if is_video_model:
                    if (
                        video_engine == "veo31-standard"
                        and video_reference_mode == "image"
                    ):
                        max_video_inputs = 3
                    elif (
                        video_engine == "kling-o3"
                        and video_reference_mode == "image"
                    ):
                        max_video_inputs = max(
                            0, int((video_conf or {}).get("max_reference_images") or 3)
                        )
                    else:
                        configured_max_inputs = (video_conf or {}).get(
                            "max_reference_media",
                            (video_conf or {}).get("max_input_images"),
                        )
                        if configured_max_inputs is not None:
                            max_video_inputs = max(0, int(configured_max_inputs))
                        else:
                            max_video_inputs = (
                                2
                                if video_engine
                                in {
                                    "veo31-fast",
                                    "veo31-standard",
                                    "kling-o3",
                                    "kling3",
                                }
                                else 1
                            )
                    if len(input_media) > max_video_inputs:
                        raise HTTPException(
                            status_code=400,
                            detail=f"video model supports at most {max_video_inputs} reference media item(s)",
                        )
                    if video_engine == "seedance2":
                        media_counts = count_media_kinds(input_media)
                        media_limits = {
                            "image": int(video_conf.get("max_input_images") or 9),
                            "video": int(video_conf.get("max_input_videos") or 3),
                            "audio": int(video_conf.get("max_input_audios") or 3),
                        }
                        for media_type, count in media_counts.items():
                            if count > media_limits[media_type]:
                                raise HTTPException(
                                    status_code=400,
                                    detail=(
                                        f"Seedance supports at most "
                                        f"{media_limits[media_type]} {media_type} "
                                        "reference item(s)"
                                    ),
                                )
                    source_media_refs: list[dict] = []
                    for media in input_media[:max_video_inputs]:
                        upload_bytes = media.content
                        upload_mime = media.mime_type
                        if media.kind == "image":
                            upload_bytes, upload_mime = prepare_video_source_image(
                                media.content,
                                ratio,
                                video_resolution,
                            )
                        media_id = client.upload_media(
                            token,
                            upload_bytes,
                            upload_mime,
                            media_type=media.kind,
                        )
                        source_media_refs.append(
                            {
                                "id": media_id,
                                "media_type": media.kind,
                                "mention_id": media.mention_id,
                                "label": media.label,
                            }
                        )
                        if media.kind == "image":
                            source_image_ids.append(media_id)

                    def _video_progress_cb(update: dict):
                        set_request_task_progress(
                            request,
                            task_status=str(update.get("task_status") or "IN_PROGRESS"),
                            task_progress=update.get("task_progress"),
                            upstream_job_id=update.get("upstream_job_id"),
                            retry_after=update.get("retry_after"),
                            error=update.get("error"),
                        )

                    job_id = uuid.uuid4().hex
                    tmp_path = generated_dir / f"{job_id}.video.tmp"
                    old_size = 0
                    try:
                        if tmp_path.exists():
                            old_size = int(tmp_path.stat().st_size)
                    except Exception:
                        old_size = 0

                    video_prompt = prompt
                    entity_refs = None
                    if video_engine == "kling-o3":
                        video_prompt, entity_refs = _resolve_kling_entity_refs(
                            token, prompt, kling_bound_refs
                        )

                    video_bytes, video_meta = client.generate_video(
                        token=token,
                        video_conf=video_conf or {},
                        prompt=video_prompt,
                        aspect_ratio=ratio,
                        duration=duration,
                        source_image_ids=source_image_ids,
                        source_media_refs=source_media_refs,
                        entity_refs=entity_refs,
                        timeout=max(int(client.generate_timeout), 600),
                        negative_prompt=negative_prompt,
                        generate_audio=generate_audio,
                        reference_mode=video_reference_mode,
                        out_path=tmp_path,
                        progress_cb=_video_progress_cb,
                    )
                    video_ext = video_ext_from_meta(video_meta)
                    filename = f"{job_id}.{video_ext}"
                    out_path = generated_dir / filename
                    if video_bytes is not None:
                        out_path.write_bytes(video_bytes)
                    elif tmp_path.exists():
                        tmp_path.replace(out_path)
                    new_size = int(out_path.stat().st_size) if out_path.exists() else 0
                    on_generated_file_written(out_path, old_size, new_size)
                    image_url = public_generated_url(request, filename)
                    set_request_preview(request, image_url, kind="video")
                    response_content = (
                        f"```html\n<video src='{image_url}' controls></video>\n```"
                    )
                else:
                    for image_bytes, image_mime in input_images:
                        source_image_ids.append(
                            client.upload_image(
                                token, image_bytes, image_mime or "image/jpeg"
                            )
                        )

                    def _image_progress_cb(update: dict):
                        set_request_task_progress(
                            request,
                            task_status=str(update.get("task_status") or "IN_PROGRESS"),
                            task_progress=update.get("task_progress"),
                            upstream_job_id=update.get("upstream_job_id"),
                            retry_after=update.get("retry_after"),
                            error=update.get("error"),
                        )

                    job_id = uuid.uuid4().hex
                    out_path = generated_dir / f"{job_id}.png"
                    old_size = 0
                    try:
                        if out_path.exists():
                            old_size = int(out_path.stat().st_size)
                    except Exception:
                        old_size = 0

                    image_bytes, _meta = client.generate(
                        token=token,
                        prompt=prompt,
                        aspect_ratio=ratio,
                        output_resolution=output_resolution,
                        upstream_model_id=str(
                            image_model_conf.get("upstream_model_id") or "gemini-flash"
                        ),
                        upstream_model_version=str(
                            image_model_conf.get("upstream_model_version")
                            or "nano-banana-2"
                        ),
                        quality_level=_image_quality(data, image_model_conf),
                        detail_level=image_model_conf.get("detail_level"),
                        ground_search=_image_ground_search(data, image_model_conf),
                        source_image_ids=source_image_ids,
                        timeout=client.generate_timeout,
                        out_path=out_path,
                        progress_cb=_image_progress_cb,
                    )
                    if image_bytes is not None:
                        out_path.write_bytes(image_bytes)
                    new_size = int(out_path.stat().st_size) if out_path.exists() else 0
                    on_generated_file_written(out_path, old_size, new_size)
                    image_url = public_image_url(request, job_id)
                    set_request_preview(request, image_url, kind="image")
                    response_content = f"![Generated Image]({image_url})"

                response_payload = {
                    "id": f"chatcmpl-{uuid.uuid4().hex[:24]}",
                    "object": "chat.completion",
                    "created": int(time.time()),
                    "model": resolved_model_id,
                    "choices": [
                        {
                            "index": 0,
                            "message": {
                                "role": "assistant",
                                "content": response_content,
                            },
                            "finish_reason": "stop",
                        }
                    ],
                    "usage": {
                        "prompt_tokens": 0,
                        "completion_tokens": 0,
                        "total_tokens": 0,
                    },
                }
                if bool(data.get("stream", False)):
                    return StreamingResponse(
                        sse_chat_stream(response_payload),
                        media_type="text/event-stream",
                    )
                return response_payload

            token_selector = None
            selected_account_id = entity_account_id or queue_account_id
            if selected_account_id:
                token_selector = lambda: token_manager.get_available_for_account(
                    selected_account_id, strategy=client.token_rotation_strategy
                )
            return run_with_token_retries(
                request=request,
                operation_name="chat.completions",
                run_once=_run_once,
                token_selector=token_selector,
                allow_token_reuse=bool(queue_account_id),
            )
        except quota_error_cls:
            error_code = str(
                getattr(request.state, "log_error_code", "") or ""
            ) or set_request_error_detail(
                request,
                error="Token quota exhausted",
                status_code=429,
                error_type="rate_limit_error",
                include_traceback=False,
            )
            set_request_task_progress(
                request,
                task_status="FAILED",
                task_progress=0.0,
                error="Token quota exhausted",
            )
            return JSONResponse(
                status_code=429,
                content={
                    "error": {
                        "message": "Token quota exhausted",
                        "type": "rate_limit_error",
                        "code": error_code,
                    }
                },
            )
        except auth_error_cls:
            error_code = str(
                getattr(request.state, "log_error_code", "") or ""
            ) or set_request_error_detail(
                request,
                error="Token invalid or expired",
                status_code=401,
                error_type="authentication_error",
                include_traceback=False,
            )
            set_request_task_progress(
                request,
                task_status="FAILED",
                task_progress=0.0,
                error="Token invalid or expired",
            )
            return JSONResponse(
                status_code=401,
                content={
                    "error": {
                        "message": "Token invalid or expired",
                        "type": "authentication_error",
                        "code": error_code,
                    }
                },
            )
        except upstream_temp_error_cls as exc:
            error_code = str(
                getattr(request.state, "log_error_code", "") or ""
            ) or set_request_error_detail(
                request,
                error=exc,
                status_code=503,
                error_type="server_error",
                include_traceback=False,
            )
            set_request_task_progress(
                request, task_status="FAILED", task_progress=0.0, error=str(exc)
            )
            return JSONResponse(
                status_code=503,
                content={
                    "error": {
                        "message": str(exc),
                        "type": "server_error",
                        "code": error_code,
                    }
                },
            )
        except HTTPException as exc:
            err_type = (
                "invalid_request_error"
                if 400 <= int(exc.status_code) < 500
                else "server_error"
            )
            error_code = set_request_error_detail(
                request,
                error=str(exc.detail),
                status_code=exc.status_code,
                error_type=err_type,
                include_traceback=False,
            )
            set_request_task_progress(
                request, task_status="FAILED", task_progress=0.0, error=str(exc.detail)
            )
            return JSONResponse(
                status_code=exc.status_code,
                content={
                    "error": {
                        "message": str(exc.detail),
                        "type": err_type,
                        "code": error_code,
                    }
                },
            )
        except Exception as exc:
            error_code = set_request_error_detail(
                request,
                error=exc,
                status_code=500,
                error_type="server_error",
                include_traceback=True,
            )
            logger.exception(
                "Unhandled error in /v1/chat/completions log_id=%s model=%s resolved_model=%s is_video_model=%s",
                getattr(request.state, "log_id", ""),
                model_id,
                resolved_model_id,
                is_video_model,
            )
            set_request_task_progress(
                request, task_status="FAILED", task_progress=0.0, error=str(exc)
            )
            return JSONResponse(
                status_code=500,
                content={
                    "error": {
                        "message": str(exc),
                        "type": "server_error",
                        "code": error_code,
                    }
                },
            )

    return router
