import json
import tempfile
import unittest
from pathlib import Path

from core.generation_queue import AccountLeaseRegistry, GenerationTaskQueue


class GenerationTaskQueueTests(unittest.TestCase):
    def make_queue(self, data_dir: Path) -> GenerationTaskQueue:
        return GenerationTaskQueue(
            data_dir=data_dir,
            account_provider=lambda: [],
            task_runner=lambda payload, account, context: {},
            media_type="video",
        )

    def test_clear_terminal_removes_only_stopped_task_details(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            queue = self.make_queue(root / "video_tasks")
            task_ids = {}

            for status in ("queued", "running", "succeeded", "failed", "cancelled"):
                task = queue.submit({"model": status, "prompt": status})
                task_ids[status] = task["id"]
                self.assertEqual(task["media_type"], "video")
                with queue._lock:
                    queue._tasks[task["id"]]["status"] = status
                    queue._persist_locked()

            generated_video = root / "generated" / "result.mp4"
            generated_video.parent.mkdir(parents=True)
            generated_video.write_bytes(b"video")

            removed_ids = queue.clear_terminal()

            self.assertEqual(
                set(removed_ids),
                {task_ids["succeeded"], task_ids["failed"], task_ids["cancelled"]},
            )
            remaining = {task["id"]: task["status"] for task in queue.list()}
            self.assertEqual(
                remaining,
                {task_ids["queued"]: "queued", task_ids["running"]: "running"},
            )
            self.assertTrue(generated_video.exists())

            persisted = json.loads(
                (root / "video_tasks" / "tasks.json").read_text(encoding="utf-8")
            )
            self.assertEqual(
                {task["id"] for task in persisted},
                {task_ids["queued"], task_ids["running"]},
            )

    def test_image_and_video_queues_share_account_leases(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            account = {"account_id": "account-1", "token": "token"}
            leases = AccountLeaseRegistry()
            video_queue = GenerationTaskQueue(
                data_dir=root / "video_tasks",
                account_provider=lambda: [account],
                task_runner=lambda payload, selected, context: {},
                media_type="video",
                lease_registry=leases,
            )
            image_queue = GenerationTaskQueue(
                data_dir=root / "image_tasks",
                account_provider=lambda: [account],
                task_runner=lambda payload, selected, context: {},
                media_type="image",
                lease_registry=leases,
            )
            video_queue.submit({"model": "video", "prompt": "video"})
            image_queue.submit({"model": "image", "prompt": "image"})

            with video_queue._condition:
                video_assignment = video_queue._next_assignment_locked()
            with image_queue._condition:
                image_assignment = image_queue._next_assignment_locked()

            self.assertIsNotNone(video_assignment)
            self.assertIsNone(image_assignment)

    def test_existing_tasks_gain_queue_media_type(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir) / "video_tasks"
            data_dir.mkdir(parents=True)
            (data_dir / "tasks.json").write_text(
                json.dumps([{"id": "old-task", "status": "succeeded"}]),
                encoding="utf-8",
            )

            queue = self.make_queue(data_dir)

            self.assertEqual(queue.get("old-task")["media_type"], "video")


if __name__ == "__main__":
    unittest.main()
