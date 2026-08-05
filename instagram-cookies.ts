from __future__ import annotations

import json
import logging
import re
import shutil
import subprocess
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from .domain import DownloadResult, InstagramStats

LOGGER = logging.getLogger(__name__)

MEDIA_EXTENSIONS = {
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".mp4",
    ".mov",
    ".mkv",
    ".webm",
}

_ALLOWED_HOSTS = {
    "instagram.com",
    "www.instagram.com",
    "m.instagram.com",
    "instagr.am",
    "www.instagr.am",
}
_SHORTCODE_RE = re.compile(r"^/(?:reel|reels|p|tv)/([A-Za-z0-9_-]+)/?")


class InstagramDownloadError(RuntimeError):
    pass


class InstagramDownloader:
    def __init__(self, cookies_file: Path | None = None) -> None:
        self.cookies_file = cookies_file

    def download(self, raw_url: str, destination: Path) -> DownloadResult:
        canonical_url = canonicalize_instagram_url(raw_url)
        destination.mkdir(parents=True, exist_ok=True)

        gallery_error: Exception | None = None
        try:
            self._download_with_gallery_dl(canonical_url, destination)
        except Exception as exc:  # fallback is intentional
            gallery_error = exc
            LOGGER.warning("gallery-dl failed: %s", exc)

        files = collect_media_files(destination)
        if not files:
            try:
                self._download_with_ytdlp(canonical_url, destination)
            except Exception as exc:
                details = f"gallery-dl: {gallery_error}; yt-dlp: {exc}"
                raise InstagramDownloadError(
                    "Instagram не отдал контент. Возможно, нужны свежие cookies или Instagram изменил выдачу. "
                    + details
                ) from exc
            files = collect_media_files(destination)

        if not files:
            raise InstagramDownloadError("Загрузчик завершился без медиафайлов")

        metadata = load_metadata_documents(destination)
        stats = extract_stats(metadata)
        return DownloadResult(
            canonical_url=canonical_url,
            files=tuple(files),
            stats=stats,
        )

    def _download_with_gallery_dl(self, url: str, destination: Path) -> None:
        if shutil.which("gallery-dl") is None:
            raise InstagramDownloadError("gallery-dl executable is not installed")

        config: dict[str, Any] = {
            "extractor": {
                "instagram": {
                    "videos": True,
                    "previews": False,
                    "sleep-request": "1.0-2.0",
                    "retries": 1,
                }
            }
        }
        if self.cookies_file:
            config["extractor"]["instagram"]["cookies"] = str(self.cookies_file)

        config_file = destination / "gallery-dl.json"
        config_file.write_text(json.dumps(config), encoding="utf-8")

        command = [
            "gallery-dl",
            "--config-ignore",
            "--config-json",
            str(config_file),
            "--directory",
            str(destination),
            "--write-metadata",
            "--write-info-json",
            "--no-input",
            "--no-part",
            "--retries",
            "1",
            url,
        ]
        run_checked(command, timeout=10 * 60)

    def _download_with_ytdlp(self, url: str, destination: Path) -> None:
        if shutil.which("yt-dlp") is None:
            raise InstagramDownloadError("yt-dlp executable is not installed")

        output_template = str(destination / "%(id)s_%(autonumber)02d.%(ext)s")
        command = [
            "yt-dlp",
            "--no-warnings",
            "--no-progress",
            "--write-info-json",
            "--merge-output-format",
            "mp4",
            "--retries",
            "2",
            "--fragment-retries",
            "2",
            "--output",
            output_template,
        ]
        if self.cookies_file:
            command.extend(["--cookies", str(self.cookies_file)])
        command.append(url)
        run_checked(command, timeout=10 * 60)


def canonicalize_instagram_url(raw_url: str) -> str:
    parsed = urlparse(raw_url.strip())
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in _ALLOWED_HOSTS:
        raise InstagramDownloadError("Разрешены только ссылки instagram.com")
    match = _SHORTCODE_RE.match(parsed.path)
    if not match:
        raise InstagramDownloadError("Нужна ссылка на Instagram Reel или пост")
    kind = parsed.path.strip("/").split("/")[0]
    if kind == "reels":
        kind = "reel"
    return f"https://www.instagram.com/{kind}/{match.group(1)}/"


def collect_media_files(directory: Path) -> list[Path]:
    files = [
        path
        for path in directory.rglob("*")
        if path.is_file() and path.suffix.lower() in MEDIA_EXTENSIONS
    ]
    return sorted(files, key=lambda path: natural_sort_key(str(path.relative_to(directory))))


def natural_sort_key(value: str) -> list[str | int]:
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", value)]


def load_metadata_documents(directory: Path) -> list[Any]:
    documents: list[Any] = []
    for path in sorted(directory.rglob("*.json")):
        if path.name == "gallery-dl.json":
            continue
        try:
            documents.append(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            LOGGER.warning("Cannot read metadata file: %s", path)
    return documents


def extract_stats(documents: Iterable[Any]) -> InstagramStats:
    docs = list(documents)
    username = first_text(
        docs,
        exact_keys=("username", "uploader", "uploader_id", "owner_username"),
    )
    likes = first_integer(docs, exact_keys=("like_count", "likes", "favorite_count", "edge_media_preview_like"))
    comments = first_integer(docs, exact_keys=("comment_count", "comments", "edge_media_to_comment"))
    views = first_integer(
        docs,
        exact_keys=("video_view_count", "view_count", "play_count", "plays", "views"),
    )
    followers = first_integer(
        docs,
        exact_keys=("follower_count", "followers", "edge_followed_by_count"),
    )
    return InstagramStats(
        username=normalize_username(username),
        likes=likes,
        comments=comments,
        views=views,
        followers=followers,
    )


def first_integer(documents: Iterable[Any], exact_keys: tuple[str, ...]) -> int | None:
    normalized = {key.casefold() for key in exact_keys}
    for document in documents:
        for key, value in walk_key_values(document):
            if key.casefold() not in normalized:
                continue
            number = coerce_integer(value)
            if number is not None and number >= 0:
                return number
    return None


def first_text(documents: Iterable[Any], exact_keys: tuple[str, ...]) -> str | None:
    normalized = {key.casefold() for key in exact_keys}
    for document in documents:
        for key, value in walk_key_values(document):
            if key.casefold() not in normalized:
                continue
            if isinstance(value, str) and value.strip():
                return value.strip()
            if isinstance(value, Mapping):
                nested = value.get("username") or value.get("name")
                if isinstance(nested, str) and nested.strip():
                    return nested.strip()
    return None


def walk_key_values(value: Any) -> Iterable[tuple[str, Any]]:
    if isinstance(value, Mapping):
        for key, child in value.items():
            yield str(key), child
            yield from walk_key_values(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk_key_values(child)


def coerce_integer(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        cleaned = value.strip().replace(" ", "").replace(",", "")
        if cleaned.isdigit():
            return int(cleaned)
    if isinstance(value, Mapping):
        for key in ("count", "total", "value"):
            if key in value:
                coerced = coerce_integer(value[key])
                if coerced is not None:
                    return coerced
    return None


def normalize_username(value: str | None) -> str | None:
    if not value:
        return None
    cleaned = value.strip().lstrip("@").strip()
    if not cleaned or " " in cleaned or "/" in cleaned:
        return None
    return cleaned


def run_checked(command: list[str], timeout: int) -> None:
    completed = subprocess.run(
        command,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=timeout,
        check=False,
    )
    if completed.returncode != 0:
        output = completed.stdout[-4000:].strip()
        raise InstagramDownloadError(
            f"Command failed with exit code {completed.returncode}: {output}"
        )
