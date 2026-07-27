import hashlib
import re
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class MediaSource:
    kind: str
    url: str
    mention_id: str = ""
    label: str = ""


@dataclass(frozen=True)
class LoadedMedia:
    content: bytes
    mime_type: str
    kind: str
    mention_id: str = ""
    label: str = ""


def _metadata(value: Any) -> tuple[str, str]:
    if not isinstance(value, dict):
        return "", ""
    mention = value.get("mention")
    if not isinstance(mention, dict):
        mention = {}
    mention_id = str(
        value.get("mention_id")
        or value.get("mentionId")
        or mention.get("id")
        or ""
    ).strip()
    label = str(value.get("label") or mention.get("label") or "").strip()
    return mention_id, label


def extract_media_sources(messages: Any, max_items: int = 13) -> list[MediaSource]:
    """Read media and optional mention metadata from the latest user message."""
    if not isinstance(messages, list):
        return []
    field_by_type = {
        "image_url": ("image", "image_url"),
        "video_url": ("video", "video_url"),
        "audio_url": ("audio", "audio_url"),
    }
    for message in reversed(messages):
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        content = message.get("content")
        if not isinstance(content, list):
            return []
        sources: list[MediaSource] = []
        for part in content:
            if not isinstance(part, dict):
                continue
            media_spec = field_by_type.get(str(part.get("type") or ""))
            if not media_spec:
                continue
            kind, field = media_spec
            value = part.get(field)
            part_mention_id, part_label = _metadata(part)
            if isinstance(value, dict):
                url = str(value.get("url") or "").strip()
                value_mention_id, value_label = _metadata(value)
            else:
                url = str(value or "").strip()
                value_mention_id = value_label = ""
            if not url:
                continue
            sources.append(
                MediaSource(
                    kind=kind,
                    url=url,
                    mention_id=value_mention_id or part_mention_id,
                    label=value_label or part_label,
                )
            )
            if len(sources) >= max_items:
                break
        return sources
    return []


def _mention_pattern(mention_id: str) -> re.Pattern[str]:
    return re.compile(rf"@{re.escape(mention_id)}(?![A-Za-z0-9_-])")


def normalize_mention_id(mention_id: str) -> str:
    """Return the exact 21-character ASCII mention ID expected by Adobe."""
    raw_id = str(mention_id or "").strip()
    if not raw_id:
        return ""
    if (
        len(raw_id) == 21
        and raw_id.isascii()
        and all(char.isalnum() or char in "_-" for char in raw_id)
    ):
        return raw_id
    return "m" + hashlib.sha256(raw_id.encode("utf-8")).hexdigest()[:20]


def bind_seedance_mentions(
    prompt: str, media_refs: list[dict]
) -> tuple[str, list[dict]]:
    """Bind only media aliases explicitly referenced by the Seedance prompt."""
    normalized_prompt = str(prompt or "")
    bindings: dict[str, str] = {}
    for media in media_refs:
        alias = str(media.get("mention_id") or "").strip()
        if alias and _mention_pattern(alias).search(normalized_prompt):
            bindings.setdefault(alias, normalize_mention_id(alias))

    for alias in sorted(bindings, key=len, reverse=True):
        normalized_prompt = _mention_pattern(alias).sub(
            f"@{bindings[alias]}", normalized_prompt
        )

    bound_refs: list[dict] = []
    kind_counts = {"image": 0, "video": 0, "audio": 0}
    for media in media_refs:
        kind = str(media.get("media_type") or "image").strip().lower()
        if kind not in kind_counts:
            continue
        kind_counts[kind] += 1
        ref = {
            "id": str(media.get("id") or "").strip(),
            "usage": "style" if kind == "image" else "source",
        }
        normalized_id = bindings.get(str(media.get("mention_id") or "").strip())
        if normalized_id:
            ref["mention"] = {
                "id": normalized_id,
                "label": str(media.get("label") or "").strip()
                or f"{kind.title()}{kind_counts[kind]}",
            }
        if ref["id"]:
            bound_refs.append(ref)
    return normalized_prompt, bound_refs
