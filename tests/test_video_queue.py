import json
import tempfile
import unittest
from pathlib import Path

from core.video_queue import VideoTaskQueue


class VideoTaskQueueTests(unittest.TestCase):
    def make_queue(self, data_dir: Path) -> VideoTaskQueue:
        return VideoTaskQueue(
            data_dir=data_dir,
            account_provider=lambda: [],
            task_runner=lambda payload, account, context: {},
        )

    def test_clear_terminal_removes_only_stopped_task_details(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            queue = self.make_queue(root / "video_tasks")
            task_ids = {}

            for status in ("queued", "running", "succeeded", "failed", "cancelled"):
                task = queue.submit({"model": status, "prompt": status})
                task_ids[status] = task["id"]
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


if __name__ == "__main__":
    unittest.main()
