import unittest

from core.adobe_client import AdobeClient, UpstreamTemporaryError


class AdobeRetryPolicyTests(unittest.TestCase):
    def setUp(self):
        self.client = object.__new__(AdobeClient)
        self.client.retry_enabled = True
        self.client.retry_backoff_seconds = 10.0
        self.client.retry_on_status_codes = [408, 429, 451, 500, 502, 503, 504]
        self.client.retry_on_error_types = {"timeout", "connection", "proxy"}

    def test_temporary_status_classification(self):
        for status_code in (408, 429, 451, 500, 502, 503, 504):
            with self.subTest(status_code=status_code):
                self.assertTrue(self.client._is_temporary_status(status_code))

        for status_code in (400, 401, 403, 404):
            with self.subTest(status_code=status_code):
                self.assertFalse(self.client._is_temporary_status(status_code))

    def test_408_uses_existing_retry_policy(self):
        error = UpstreamTemporaryError(
            "system under load",
            status_code=408,
            error_type="status",
        )

        self.assertTrue(self.client.should_retry_temporary_error(error))
        self.assertEqual(self.client._retry_delay_for_attempt(1), 10.0)
        self.assertEqual(self.client._retry_delay_for_attempt(2), 20.0)


if __name__ == "__main__":
    unittest.main()
