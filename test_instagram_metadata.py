from __future__ import annotations

import json
import logging
import shutil
import subprocess
from pathlib import Path

from PIL import Image

LOGGER = logging.getLogger(__name__)

TELEGRAM_PHOTO_LIMIT = 9_500_000
TELEGRAM_FILE_LIMIT = 49_000_000
PHOTO_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".webm"}


class MediaPreparationError(RuntimeError):
    pass


def prepare_media(files: tuple[Path, ...], workspace: Path) -> tuple[Path, ...]:
    prepared_dir = workspace / "prepared"
    prepared_dir.mkdir(parents=True, exist_ok=True)
    result: list[Path] = []

    for index, source in enumerate(files, start=1):
        extension = source.suffix.lower()
        if extension in PHOTO_EXTENSIONS:
            result.append(prepare_photo(source, prepared_dir / f"{index:02d}.jpg"))
        elif extension in VIDEO_EXTENSIONS:
            result.append(prepare_video(source, prepared_dir / f"{index:02d}.mp4"))

    if not result:
        raise MediaPreparationError("Не найдено фото или видео для отправки")
    return tuple(result)


def prepare_photo(source: Path, destination: Path) -> Path:
    if source.suffix.lower() in {".jpg", ".jpeg"} and source.stat().st_size <= TELEGRAM_PHOTO_LIMIT:
        shutil.copy2(source, destination)
        return destination

    with Image.open(source) as image:
        image = image.convert("RGB")
        quality = 92
        while quality >= 55:
            image.save(destination, "JPEG", quality=quality, optimize=True)
            if destination.stat().st_size <= TELEGRAM_PHOTO_LIMIT:
                return destination
            quality -= 7

        width, height = image.size
        while max(width, height) > 1280:
            width = int(width * 0.85)
            height = int(height * 0.85)
            resized = image.resize((width, height), Image.Resampling.LANCZOS)
            resized.save(destination, "JPEG", quality=75, optimize=True)
            if destination.stat().st_size <= TELEGRAM_PHOTO_LIMIT:
                return destination

    raise MediaPreparationError(f"Не удалось ужать изображение {source.name}")


def prepare_video(source: Path, destination: Path) -> Path:
    if (
        source.suffix.lower() == ".mp4"
        and source.stat().st_size <= TELEGRAM_FILE_LIMIT
        and is_h264_aac(source)
    ):
        shutil.copy2(source, destination)
        return destination

    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        raise MediaPreparationError("Для обработки видео нужны ffmpeg и ffprobe")

    duration = probe_duration(source)
    if duration <= 0:
        raise MediaPreparationError(f"Не удалось определить длительность {source.name}")

    target_total_bitrate = int((TELEGRAM_FILE_LIMIT * 8 * 0.94) / duration)
    audio_bitrate = 96_000
    video_bitrate = max(220_000, target_total_bitrate - audio_bitrate)

    command = [
        "ffmpeg",
        "-y",
        "-i",
        str(source),
        "-map_metadata",
        "-1",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "-b:v",
        str(video_bitrate),
        "-maxrate",
        str(int(video_bitrate * 1.15)),
        "-bufsize",
        str(int(video_bitrate * 2)),
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        "-movflags",
        "+faststart",
        str(destination),
    ]
    run_media_command(command, timeout=15 * 60)

    if destination.stat().st_size > TELEGRAM_FILE_LIMIT:
        second_bitrate = max(180_000, int(video_bitrate * 0.82))
        command[command.index("-b:v") + 1] = str(second_bitrate)
        command[command.index("-maxrate") + 1] = str(int(second_bitrate * 1.1))
        command[command.index("-bufsize") + 1] = str(int(second_bitrate * 2))
        run_media_command(command, timeout=15 * 60)

    if destination.stat().st_size > TELEGRAM_FILE_LIMIT:
        raise MediaPreparationError(
            f"Видео {source.name} не удалось ужать до лимита Telegram 50 MB"
        )
    return destination


def is_h264_aac(path: Path) -> bool:
    if shutil.which("ffprobe") is None:
        return True
    command = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,codec_name",
        "-of",
        "json",
        str(path),
    ]
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        return False
    try:
        streams = json.loads(completed.stdout).get("streams", [])
    except json.JSONDecodeError:
        return False
    video = [item.get("codec_name") for item in streams if item.get("codec_type") == "video"]
    audio = [item.get("codec_name") for item in streams if item.get("codec_type") == "audio"]
    return video == ["h264"] and (not audio or all(codec == "aac" for codec in audio))


def probe_duration(path: Path) -> float:
    command = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(path),
    ]
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        raise MediaPreparationError(completed.stderr.strip() or "ffprobe failed")
    try:
        return float(completed.stdout.strip())
    except ValueError as exc:
        raise MediaPreparationError("Invalid ffprobe duration") from exc


def run_media_command(command: list[str], timeout: int) -> None:
    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    if completed.returncode != 0:
        LOGGER.error("ffmpeg failed: %s", completed.stderr[-4000:])
        raise MediaPreparationError("FFmpeg не смог обработать видео")
