import unittest

from core.adobe_client import AdobeClient
from core.media_mentions import (
    LoadedMedia,
    bind_seedance_mentions,
    count_media_kinds,
    extract_media_sources,
    normalize_mention_id,
)


class MediaMentionTests(unittest.TestCase):
    def test_counts_structured_loaded_media(self):
        media = [
            LoadedMedia(b"image", "image/png", "image"),
            LoadedMedia(b"image", "image/png", "image"),
            LoadedMedia(b"audio", "audio/mpeg", "audio"),
        ]
        self.assertEqual(
            count_media_kinds(media), {"image": 2, "video": 0, "audio": 1}
        )

    def test_extracts_nested_mention_metadata(self):
        sources = extract_media_sources(
            [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "Use @image_1"},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": "data:image/png;base64,AA==",
                                "mention_id": "image_1",
                                "label": "人物正面",
                            },
                        },
                    ],
                }
            ]
        )
        self.assertEqual(len(sources), 1)
        self.assertEqual(sources[0].mention_id, "image_1")
        self.assertEqual(sources[0].label, "人物正面")

    def test_binds_only_explicitly_referenced_media(self):
        prompt, refs = bind_seedance_mentions(
            "让 @image_1 保持人物外观",
            [
                {"id": "urn:1", "media_type": "image", "mention_id": "image_1"},
                {"id": "urn:2", "media_type": "image", "mention_id": "image_2"},
            ],
        )
        normalized = normalize_mention_id("image_1")
        self.assertIn(f"@{normalized}", prompt)
        self.assertEqual(refs[0]["mention"]["id"], normalized)
        self.assertNotIn("mention", refs[1])

    def test_complete_token_matching_avoids_prefix_collision(self):
        prompt, refs = bind_seedance_mentions(
            "参考 @image_10 的动作",
            [
                {"id": "urn:1", "media_type": "image", "mention_id": "image_1"},
                {"id": "urn:10", "media_type": "image", "mention_id": "image_10"},
            ],
        )
        self.assertNotIn("mention", refs[0])
        self.assertEqual(
            refs[1]["mention"]["id"], normalize_mention_id("image_10")
        )
        self.assertNotIn("@image_10", prompt)

    def test_normalized_id_is_adobe_shape(self):
        mention_id = normalize_mention_id("图片一")
        self.assertEqual(len(mention_id), 21)
        self.assertTrue(mention_id.isascii())

    def test_nine_images_and_one_audio_keep_all_aliases(self):
        content = [{"type": "text", "text": "测试"}]
        for index in range(1, 10):
            content.append(
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"https://example.test/{index}.png",
                        "mention_id": f"图片{index}",
                    },
                }
            )
        content.append(
            {
                "type": "audio_url",
                "audio_url": {
                    "url": "https://example.test/audio.mp3",
                    "mention_id": "音频1",
                },
            }
        )
        sources = extract_media_sources(
            [{"role": "user", "content": content}], max_items=13
        )
        self.assertEqual(len(sources), 10)
        self.assertEqual(sources[-1].kind, "audio")
        self.assertEqual(sources[-1].mention_id, "音频1")

    def test_seedance_payload_keeps_unmentioned_media_as_plain_reference(self):
        client = AdobeClient.__new__(AdobeClient)
        payload = client._build_video_payload(
            video_conf={"engine": "seedance2", "resolution": "720p"},
            prompt="让 @图片1 保持人物外观",
            aspect_ratio="9:16",
            duration=5,
            source_media_refs=[
                {
                    "id": "urn:image:1",
                    "media_type": "image",
                    "mention_id": "图片1",
                    "label": "图片1",
                },
                {
                    "id": "urn:audio:1",
                    "media_type": "audio",
                    "mention_id": "音频1",
                    "label": "音频1",
                },
            ],
            reference_mode="media",
        )
        self.assertEqual(payload["generationMetadata"]["module"], "media2video")
        self.assertIn(f"@{normalize_mention_id('图片1')}", payload["prompt"])
        self.assertEqual(
            payload["referenceBlobs"][0]["mention"]["label"], "图片1"
        )
        self.assertNotIn("mention", payload["referenceBlobs"][1])


if __name__ == "__main__":
    unittest.main()
