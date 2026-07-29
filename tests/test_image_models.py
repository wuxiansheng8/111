import unittest

from core.models.catalog import MODEL_CATALOG
from core.models.payloads import build_image_payload_candidates, size_from_ratio


class ImageModelTests(unittest.TestCase):
    def test_studio_image_model_matrix(self):
        nano_ids = [key for key in MODEL_CATALOG if key.startswith("firefly-nano-banana2-")]
        gpt_ids = [key for key in MODEL_CATALOG if key.startswith("firefly-gpt-image-")]
        self.assertEqual(len(nano_ids), 42)
        self.assertEqual(len(gpt_ids), 30)
        for resolution in ("1k", "2k", "4k"):
            self.assertIn(f"firefly-nano-banana2-{resolution}-21x9", MODEL_CATALOG)
            self.assertIn(f"firefly-nano-banana2-{resolution}-1x8", MODEL_CATALOG)
            self.assertIn(f"firefly-gpt-image-{resolution}-16x9", MODEL_CATALOG)

    def test_nano_banana_accepts_six_general_references(self):
        references = [f"image-{index}" for index in range(6)]
        payload = build_image_payload_candidates(
            prompt="test",
            aspect_ratio="21:9",
            output_resolution="2K",
            upstream_model_id="gemini-flash",
            upstream_model_version="nano-banana-3",
            ground_search=True,
            source_image_ids=references,
        )[0]
        self.assertEqual(
            payload["referenceBlobs"],
            [{"id": image_id, "usage": "general"} for image_id in references],
        )
        self.assertIs(payload["groundSearch"], True)
        self.assertEqual(size_from_ratio("21:9", "2K"), {"width": 3168, "height": 1344})

    def test_gpt_image_quality_and_six_subject_references(self):
        references = [f"image-{index}" for index in range(6)]
        payload = build_image_payload_candidates(
            prompt="test",
            aspect_ratio="16:9",
            output_resolution="4K",
            upstream_model_id="gpt-image",
            upstream_model_version="2",
            quality_level="high",
            source_image_ids=references,
        )[0]
        self.assertEqual(payload["generationSettings"]["detailLevel"], 5)
        self.assertEqual(
            payload["referenceBlobs"],
            [{"id": image_id, "usage": "subject"} for image_id in references],
        )
        self.assertNotIn("groundSearch", payload)


if __name__ == "__main__":
    unittest.main()
