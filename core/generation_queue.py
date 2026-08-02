from __future__ import annotations

import json
import os
import threading
import time
import uuid
from collections import deque
from pathlib import Path
from typing import Callable, Optional


class AccountLeaseRegistry:
    def __init__(self) -> None:
        self._leased: set[str] = set()
        self._lock = threading.Lock()

    def acquire(self, account_id: str) -> bool:
        with self._lock:
            if account_id in self._leased:
                return False
            self._leased.add(account_id)
            return True

    def release(self, account_id: str) -> None:
        with self._lock:
            self._leased.discard(account_id)


class GenerationTaskQueue:
    TERMINAL_STATUSES = frozenset({"succeeded", "failed", "cancelled"})

    def __init__(
        self,
        data_dir: Path,
        account_provider: Callable[[], list[dict]],
        task_runner: Callable[[dict, dict, dict], dict],
        media_type: str,
        lease_registry: Optional[AccountLeaseRegistry] = None,
        max_items: int = 200,
    ) -> None:
        self._data_dir = Path(data_dir)
        self._payload_dir = self._data_dir / "payloads"
        self._index_path = self._data_dir / "tasks.json"
        self._account_provider = account_provider
        self._task_runner = task_runner
        self._media_type = str(media_type or "generation")
        self._lease_registry = lease_registry or AccountLeaseRegistry()
        self._max_items = max(20, int(max_items))
        self._tasks: dict[str, dict] = {}
        self._pending: deque[str] = deque()
        self._lock = threading.RLock()
        self._condition = threading.Condition(self._lock)
        self._started = False
        self._data_dir.mkdir(parents=True, exist_ok=True)
        self._payload_dir.mkdir(parents=True, exist_ok=True)
        self._load()

    def start(self) -> None:
        with self._condition:
            if self._started:
                return
            self._started = True
            threading.Thread(
                target=self._dispatch_loop,
                name=f"{self._media_type}-task-dispatcher",
                daemon=True,
            ).start()

    @staticmethod
    def _display_options_from_payload(payload: dict) -> dict:
        quality = str(payload.get("quality") or "").strip().lower()
        if quality not in {"low", "medium", "high"}:
            quality = ""

        raw_ground_search = payload.get(
            "ground_search",
            payload.get("groundSearch", False),
        )
        if isinstance(raw_ground_search, str):
            ground_search = raw_ground_search.strip().lower() in {
                "1", "true", "yes", "on",
            }
        else:
            ground_search = bool(raw_ground_search)

        options = {}
        if quality:
            options["quality"] = quality
        if ground_search:
            options["ground_search"] = True
        return options

    def submit(self, payload: dict, public_context: Optional[dict] = None) -> dict:
        task_id = uuid.uuid4().hex
        now = time.time()
        prompt = self._prompt_from_payload(payload)
        task = {
            "id": task_id,
            "status": "queued",
            "progress": 0.0,
            "model": str(payload.get("model") or ""),
            "media_type": self._media_type,
            "display_options": self._display_options_from_payload(payload),
            "prompt_preview": prompt[:120],
            "result_url": None,
            "error": None,
            "account_id": None,
            "account_name": None,
            "created_at": now,
            "started_at": None,
            "completed_at": None,
        }
        self._write_json(
            self._payload_path(task_id),
            {"payload": payload, "public_context": dict(public_context or {})},
        )
        with self._condition:
            self._tasks[task_id] = task
            self._pending.append(task_id)
            self._cleanup_locked()
            self._persist_locked()
            self._condition.notify_all()
            return self._public_task_locked(task)

    def get(self, task_id: str) -> Optional[dict]:
        with self._lock:
            task = self._tasks.get(str(task_id or ""))
            return self._public_task_locked(task) if task else None

    def list(self, limit: int = 100) -> list[dict]:
        safe_limit = min(max(int(limit or 100), 1), self._max_items)
        with self._lock:
            tasks = sorted(
                self._tasks.values(),
                key=lambda item: float(item.get("created_at") or 0),
                reverse=True,
            )
            return [self._public_task_locked(item) for item in tasks[:safe_limit]]

    def cancel(self, task_id: str) -> Optional[dict]:
        with self._condition:
            task = self._tasks.get(str(task_id or ""))
            if not task:
                return None
            if task.get("status") != "queued":
                return self._public_task_locked(task)
            task["status"] = "cancelled"
            task["completed_at"] = time.time()
            self._pending = deque(item for item in self._pending if item != task_id)
            self._delete_payload(task_id)
            self._persist_locked()
            self._condition.notify_all()
            return self._public_task_locked(task)

    def clear_terminal(self) -> list[str]:
        with self._lock:
            removed_ids = [
                task_id
                for task_id, task in self._tasks.items()
                if task.get("status") in self.TERMINAL_STATUSES
            ]
            if not removed_ids:
                return []

            removed = set(removed_ids)
            for task_id in removed_ids:
                self._tasks.pop(task_id, None)
                self._delete_payload(task_id)
            self._pending = deque(
                task_id for task_id in self._pending if task_id not in removed
            )
            self._persist_locked()
            return removed_ids

    def _load(self) -> None:
        if not self._index_path.exists():
            return
        try:
            raw = json.loads(self._index_path.read_text(encoding="utf-8"))
        except Exception:
            return
        items = raw if isinstance(raw, list) else []
        for item in items:
            if not isinstance(item, dict) or not item.get("id"):
                continue
            task = dict(item)
            task_id = str(task["id"])
            task.setdefault("media_type", self._media_type)
            task.setdefault("display_options", {})
            if task.get("status") in {"queued", "running"}:
                if self._payload_path(task_id).exists():
                    task.update(
                        status="queued",
                        progress=0.0,
                        account_id=None,
                        account_name=None,
                        started_at=None,
                    )
                    self._pending.append(task_id)
                else:
                    task.update(
                        status="failed",
                        error="任务素材已丢失",
                        completed_at=time.time(),
                    )
            self._tasks[task_id] = task
        self._cleanup_locked()
        self._persist_locked()

    def _dispatch_loop(self) -> None:
        while True:
            with self._condition:
                assignment = self._next_assignment_locked()
                if assignment is None:
                    self._condition.wait(timeout=1.0)
                    continue
                task_id, account = assignment
            threading.Thread(
                target=self._run_task,
                args=(task_id, account),
                name=f"{self._media_type}-task-{task_id[:8]}",
                daemon=True,
            ).start()

    def _next_assignment_locked(self) -> Optional[tuple[str, dict]]:
        while self._pending:
            task_id = self._pending[0]
            task = self._tasks.get(task_id)
            if task and task.get("status") == "queued":
                break
            self._pending.popleft()
        if not self._pending:
            return None

        accounts = self._account_provider() or []
        account = None
        for item in accounts:
            account_id = str(item.get("account_id") or "")
            if account_id and self._lease_registry.acquire(account_id):
                account = item
                break
        if account is None:
            return None

        task_id = self._pending.popleft()
        task = self._tasks[task_id]
        account_id = str(account.get("account_id") or "")
        task.update(
            status="running",
            progress=5.0,
            account_id=account_id,
            account_name=str(account.get("account_name") or account.get("account_email") or ""),
            started_at=time.time(),
            error=None,
        )
        self._persist_locked()
        return task_id, dict(account)

    def _run_task(self, task_id: str, account: dict) -> None:
        account_id = str(account.get("account_id") or "")
        final_state = {"status": "failed", "error": "生成失败"}
        try:
            request_data = json.loads(self._payload_path(task_id).read_text(encoding="utf-8"))
            result = self._task_runner(
                dict(request_data.get("payload") or {}),
                account,
                dict(request_data.get("public_context") or {}),
            )
            final_state = {
                "status": "succeeded",
                "progress": 100.0,
                "result_url": str(result.get("result_url") or ""),
                "error": None,
            }
        except Exception as exc:
            final_state["error"] = str(exc)[:500] or "生成失败"
        finally:
            self._delete_payload(task_id)
            with self._condition:
                task = self._tasks.get(task_id)
                if task:
                    task.update(final_state, completed_at=time.time())
                self._lease_registry.release(account_id)
                self._persist_locked()
                self._condition.notify_all()

    def _public_task_locked(self, task: dict) -> dict:
        result = dict(task)
        if result.get("status") == "queued":
            try:
                result["queue_position"] = list(self._pending).index(result["id"]) + 1
            except ValueError:
                result["queue_position"] = None
        else:
            result["queue_position"] = None
        return result

    def _cleanup_locked(self) -> None:
        if len(self._tasks) <= self._max_items:
            return
        removable = sorted(
            (
                item
                for item in self._tasks.values()
                if item.get("status") in self.TERMINAL_STATUSES
            ),
            key=lambda item: float(item.get("created_at") or 0),
        )
        for item in removable[: max(0, len(self._tasks) - self._max_items)]:
            task_id = str(item.get("id") or "")
            self._tasks.pop(task_id, None)
            self._delete_payload(task_id)

    def _persist_locked(self) -> None:
        items = sorted(
            self._tasks.values(), key=lambda item: float(item.get("created_at") or 0)
        )
        self._write_json(self._index_path, items)

    def _payload_path(self, task_id: str) -> Path:
        return self._payload_dir / f"{task_id}.json"

    def _delete_payload(self, task_id: str) -> None:
        try:
            self._payload_path(task_id).unlink(missing_ok=True)
        except Exception:
            pass

    @staticmethod
    def _prompt_from_payload(payload: dict) -> str:
        prompt = str(payload.get("prompt") or "").strip()
        if prompt:
            return prompt
        for message in payload.get("messages") or []:
            content = message.get("content") if isinstance(message, dict) else None
            if isinstance(content, str) and content.strip():
                return content.strip()
            if isinstance(content, list):
                for item in content:
                    if isinstance(item, dict) and item.get("type") == "text":
                        text = str(item.get("text") or "").strip()
                        if text:
                            return text
        return ""

    @staticmethod
    def _write_json(path: Path, payload) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = path.with_suffix(f"{path.suffix}.{uuid.uuid4().hex}.tmp")
        tmp_path.write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        try:
            os.replace(tmp_path, path)
        except PermissionError:
            path.write_text(tmp_path.read_text(encoding="utf-8"), encoding="utf-8")
            tmp_path.unlink(missing_ok=True)
