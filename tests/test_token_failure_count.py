import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock

from core.stores import RequestLogStore
from core.token_mgr import TokenManager


class TokenFailureCountTests(unittest.TestCase):
    def make_manager(self, tokens):
        manager = TokenManager.__new__(TokenManager)
        manager._lock = threading.Lock()
        manager._rr_index = 0
        manager.tokens = tokens
        manager.save = Mock()
        return manager

    def test_record_failure_increments_only_matching_token(self):
        manager = self.make_manager(
            [
                {"id": "token-a", "value": "a", "fails": 2},
                {"id": "token-b", "value": "b", "fails": 5},
            ]
        )

        manager.record_failure("token-a")

        self.assertEqual(manager.tokens[0]["fails"], 3)
        self.assertEqual(manager.tokens[1]["fails"], 5)
        manager.save.assert_called_once_with()

    def test_successful_refresh_resets_failure_count(self):
        manager = self.make_manager(
            [
                {
                    "id": "token-a",
                    "value": "old-token",
                    "status": "disabled",
                    "fails": 4,
                    "auto_refresh": True,
                    "refresh_profile_id": "profile-a",
                }
            ]
        )

        manager.upsert_auto_refresh_token("new-token", "profile-a")

        self.assertEqual(manager.tokens[0]["fails"], 0)
        self.assertEqual(manager.tokens[0]["value"], "new-token")
        self.assertEqual(manager.tokens[0]["status"], "disabled")

    def test_failure_threshold_disables_matching_token(self):
        manager = self.make_manager(
            [
                {
                    "id": "token-a",
                    "value": "token",
                    "status": "active",
                    "fails": 2,
                }
            ]
        )

        disabled = manager.record_failure("token-a", disable_threshold=3)

        self.assertTrue(disabled)
        self.assertEqual(manager.tokens[0]["fails"], 3)
        self.assertEqual(manager.tokens[0]["status"], "disabled")

    def test_zero_failure_threshold_keeps_token_active(self):
        manager = self.make_manager(
            [
                {
                    "id": "token-a",
                    "value": "token",
                    "status": "active",
                    "fails": 9,
                }
            ]
        )

        disabled = manager.record_failure("token-a", disable_threshold=0)

        self.assertFalse(disabled)
        self.assertEqual(manager.tokens[0]["fails"], 10)
        self.assertEqual(manager.tokens[0]["status"], "active")

    def test_failure_below_threshold_keeps_token_active(self):
        manager = self.make_manager(
            [
                {
                    "id": "token-a",
                    "value": "token",
                    "status": "active",
                    "fails": 1,
                }
            ]
        )

        disabled = manager.record_failure("token-a", disable_threshold=3)

        self.assertFalse(disabled)
        self.assertEqual(manager.tokens[0]["fails"], 2)
        self.assertEqual(manager.tokens[0]["status"], "active")

    def test_enforcing_new_threshold_disables_existing_failures(self):
        manager = self.make_manager(
            [
                {"id": "token-a", "status": "active", "fails": 5},
                {"id": "token-b", "status": "active", "fails": 2},
            ]
        )

        disabled_count = manager.enforce_failure_threshold(5)

        self.assertEqual(disabled_count, 1)
        self.assertEqual(manager.tokens[0]["status"], "disabled")
        self.assertEqual(manager.tokens[1]["status"], "active")

    def test_terminal_status_does_not_override_threshold_disabled(self):
        manager = self.make_manager(
            [
                {
                    "id": "token-a",
                    "value": "token",
                    "status": "active",
                    "fails": 0,
                }
            ]
        )
        manager.record_failure("token-a", disable_threshold=1)

        manager.report_invalid("token")
        manager.report_exhausted("token")

        self.assertEqual(manager.tokens[0]["status"], "disabled")

    def test_reactivating_token_preserves_failure_count(self):
        manager = self.make_manager(
            [
                {
                    "id": "token-a",
                    "value": "token",
                    "status": "disabled",
                    "fails": 3,
                    "error_until": 0,
                }
            ]
        )

        manager.set_status("token-a", "active")

        self.assertEqual(manager.tokens[0]["fails"], 3)

    def test_clearing_request_logs_preserves_failure_count(self):
        manager = self.make_manager(
            [{"id": "token-a", "value": "token", "fails": 0}]
        )
        manager.record_failure("token-a")

        with tempfile.TemporaryDirectory() as temp_dir:
            store = RequestLogStore(Path(temp_dir) / "request_logs.jsonl")
            store.add_payload(
                {"id": "request-a", "token_id": "token-a", "status_code": 500}
            )
            store.clear()
            logs, total = store.list()

        self.assertEqual(logs, [])
        self.assertEqual(total, 0)
        self.assertEqual(manager.tokens[0]["fails"], 1)


if __name__ == "__main__":
    unittest.main()
