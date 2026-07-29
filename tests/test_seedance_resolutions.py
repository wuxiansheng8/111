import unittest

from core.adobe_client import AdobeClient
from core.models.catalog import VIDEO_MODEL_CATALOG


class SeedanceResolutionTests(unittest.TestCase):
    def test_standard_registers_1080p_without_changing_720p_ids(self):
        legacy = VIDEO_MODEL_CATALOG["firefly-seedance2-4s-16x9"]
        full_hd = VIDEO_MODEL_CATALOG["firefly-seedance2-4s-16x9-1080p"]

        self.assertEqual(legacy["resolution"], "720p")
        self.assertEqual(full_hd["resolution"], "1080p")
        self.assertEqual(full_hd["upstream_model_version"], "seedance_2.0")

    def test_fast_remains_720p_only(self):
        self.assertIn("firefly-seedance2-fast-4s-16x9", VIDEO_MODEL_CATALOG)
        self.assertNotIn(
            "firefly-seedance2-fast-4s-16x9-1080p", VIDEO_MODEL_CATALOG
        )

    def test_1080p_video_sizes(self):
        self.assertEqual(
            AdobeClient._video_size("16:9", "1080p"),
            {"width": 1920, "height": 1080},
        )
        self.assertEqual(
            AdobeClient._video_size("9:16", "1080p"),
            {"width": 1080, "height": 1920},
        )


if __name__ == "__main__":
    unittest.main()
