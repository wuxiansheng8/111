from __future__ import annotations

import re
import zipfile
from datetime import datetime
from pathlib import Path, PurePosixPath
from tempfile import NamedTemporaryFile
from urllib.parse import unquote, urlsplit


def _resolve_result_file(result_url: str, generated_dir: Path) -> Path | None:
    url_path = PurePosixPath(unquote(urlsplit(result_url).path))
    if len(url_path.parts) < 2 or url_path.parts[-2] != "generated":
        return None

    source = generated_dir / url_path.name
    return source if source.is_file() else None


def _safe_model_name(value: str, fallback: str) -> str:
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("._-")
    return (name or fallback)[:80]


def build_generation_archive(
    tasks: list[dict],
    generated_dir: Path,
    media_type: str,
) -> tuple[Path, str, int] | None:
    completed = sorted(
        (
            task
            for task in tasks
            if task.get("status") == "succeeded" and task.get("result_url")
        ),
        key=lambda task: float(task.get("created_at") or 0),
    )

    with NamedTemporaryFile(
        prefix=f"adobe2api-{media_type}-",
        suffix=".zip",
        delete=False,
    ) as temporary:
        archive_path = Path(temporary.name)

    count = 0
    try:
        with zipfile.ZipFile(
            archive_path,
            "w",
            compression=zipfile.ZIP_STORED,
            allowZip64=True,
        ) as archive:
            for task in completed:
                source = _resolve_result_file(
                    str(task.get("result_url") or ""),
                    generated_dir,
                )
                if source is None:
                    continue

                count += 1
                submitted_at = datetime.fromtimestamp(
                    float(task.get("created_at") or 0)
                ).strftime("%Y%m%d-%H%M%S")
                model = _safe_model_name(
                    str(task.get("model") or ""),
                    media_type,
                )
                archive.write(
                    source,
                    f"{count:03d}_{submitted_at}_{model}{source.suffix.lower()}",
                )

        if count == 0:
            archive_path.unlink(missing_ok=True)
            return None

        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        filename = f"adobe2api-{media_type}s-{timestamp}.zip"
        return archive_path, filename, count
    except Exception:
        archive_path.unlink(missing_ok=True)
        raise
