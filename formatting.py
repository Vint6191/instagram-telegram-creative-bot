from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True, slots=True)
class InstagramStats:
    username: str | None = None
    likes: int | None = None
    comments: int | None = None
    views: int | None = None
    followers: int | None = None


@dataclass(frozen=True, slots=True)
class DownloadResult:
    canonical_url: str
    files: tuple[Path, ...]
    stats: InstagramStats
