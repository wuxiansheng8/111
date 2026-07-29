import unittest

from core.adobe_client import AdobeClient
from core.models.catalog import VIDEO_MODEL_CATALOG


class KlingModelTests(unittest.TestCase):
    def test_kling3_registers_three_to_fifteen_seconds_at_both_resolutions(self):
        models = {
            model_id: config
            for model_id, config in VIDEO_MODEL_CATALOG.items()
            if model_id.startswith("firefly-kling3-")
        }

        self.assertEqual(len(models), 52)
        self.assertEqual(models["firefly-kling3-3s-16x9"]["resolution"], "720p")
        self.assertEqual(
            models["firefly-kling3-15s-9x16-1080p"]["resolution"], "1080p"
        )

    def test_kling_omni_preserves_1080p_ids_and_adds_720p(self):
        models = {
            model_id: config
            for model_id, config in VIDEO_MODEL_CATALOG.items()
            if model_id.startswith("firefly-kling-o3-")
        }

        self.assertEqual(len(models), 52)
        self.assertEqual(
            models["firefly-kling-o3-5s-16x9"]["resolution"], "1080p"
        )
        self.assertEqual(
            models["firefly-kling-o3-3s-16x9-720p"]["resolution"], "720p"
        )

    def test_kling_omni_frame_mode_uses_ordered_frames(self):
        client = AdobeClient.__new__(AdobeClient)
        payload = client._build_video_payload(
            video_conf={"engine": "kling-o3", "resolution": "720p"},
            prompt="test",
            aspect_ratio="16:9",
            duration=3,
            source_image_ids=["first", "last"],
            reference_mode="frame",
        )

        self.assertEqual(
            payload["referenceBlobs"],
            [
                {"id": "first", "usage": "frame", "order": 1},
                {"id": "last", "usage": "frame", "order": 2},
            ],
        )

    def test_kling_omni_image_mode_uses_up_to_three_asset_references(self):
        client = AdobeClient.__new__(AdobeClient)
        payload = client._build_video_payload(
            video_conf={"engine": "kling-o3", "resolution": "1080p"},
            prompt="test",
            aspect_ratio="9:16",
            duration=15,
            source_image_ids=["reference-1", "reference-2", "reference-3", "ignored"],
            reference_mode="image",
        )

        self.assertEqual(
            payload["referenceBlobs"],
            [
                {"id": "reference-1", "usage": "asset"},
                {"id": "reference-2", "usage": "asset"},
                {"id": "reference-3", "usage": "asset"},
            ],
        )


if __name__ == "__main__":
    unittest.main()
