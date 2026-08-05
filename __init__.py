from __future__ import annotations

import base64
import logging
import os
import sys
import tempfile
from pathlib import Path

from .formatting import build_caption
from .instagram import InstagramDownloadError, InstagramDownloader
from .media import MediaPreparationError, prepare_media
from .telegram import TelegramApiError, TelegramPublisher

LOGGER = logging.getLogger(__name__)


class ConfigurationError(RuntimeError):
    pass


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    try:
        config = load_config()
    except ConfigurationError as exc:
        LOGGER.error("Configuration error: %s", exc)
        return 2

    publisher = TelegramPublisher(config["telegram_token"])

    with tempfile.TemporaryDirectory(prefix="creative-bot-") as temporary:
        workspace = Path(temporary)
        cookies_file = write_cookies(workspace, config.get("cookies_b64"))

        try:
            LOGGER.info("Processing request %s", config["request_id"])
            downloader = InstagramDownloader(cookies_file)
            result = downloader.download(config["url"], workspace / "download")
            prepared = prepare_media(result.files, workspace)
            caption = build_caption(result.stats, result.canonical_url)
            publisher.publish(config["target_chat_id"], prepared, caption)
            try:
                publisher.edit_status(
                    config["source_chat_id"],
                    config["status_message_id"],
                    "✅ Опубликовано.",
                )
                mark_status_reported()
            except TelegramApiError:
                LOGGER.exception("Published successfully, but could not update status message")
            LOGGER.info("Published %d media file(s)", len(prepared))
            return 0
        except (InstagramDownloadError, MediaPreparationError, TelegramApiError) as exc:
            LOGGER.exception("Request failed")
            update_failure_status(publisher, config, public_error(exc))
            return 1
        except Exception as exc:  # defensive boundary for GitHub Action
            LOGGER.exception("Unexpected failure")
            update_failure_status(
                publisher,
                config,
                "Неожиданная ошибка. Подробности есть в GitHub Actions.",
            )
            return 1


def load_config() -> dict[str, str]:
    required = {
        "telegram_token": "TELEGRAM_BOT_TOKEN",
        "url": "INSTAGRAM_URL",
        "source_chat_id": "SOURCE_CHAT_ID",
        "status_message_id": "STATUS_MESSAGE_ID",
        "target_chat_id": "TARGET_CHAT_ID",
        "request_id": "REQUEST_ID",
    }
    result: dict[str, str] = {}
    missing: list[str] = []
    for key, environment_name in required.items():
        value = os.environ.get(environment_name, "").strip()
        if not value:
            missing.append(environment_name)
        else:
            result[key] = value
    if missing:
        raise ConfigurationError(f"Missing environment variables: {', '.join(missing)}")

    cookies = os.environ.get("INSTAGRAM_COOKIES_B64", "").strip()
    if cookies:
        result["cookies_b64"] = cookies
    return result


def write_cookies(workspace: Path, encoded: str | None) -> Path | None:
    if not encoded:
        return None
    try:
        content = base64.b64decode(encoded, validate=True)
    except ValueError as exc:
        raise ConfigurationError("INSTAGRAM_COOKIES_B64 is not valid base64") from exc
    if not content.startswith(b"# Netscape HTTP Cookie File"):
        raise ConfigurationError("Cookies must use Netscape cookies.txt format")
    path = workspace / "instagram-cookies.txt"
    path.write_bytes(content)
    path.chmod(0o600)
    return path


def public_error(error: Exception) -> str:
    message = str(error)
    if isinstance(error, InstagramDownloadError):
        if "cookies" in message.casefold() or "instagram" in message.casefold():
            return "Instagram не отдал контент. Возможно, нужно обновить cookies или загрузчик после изменений Instagram."
        return "Не удалось скачать этот Instagram-пост."
    if isinstance(error, MediaPreparationError):
        return message[:300]
    if isinstance(error, TelegramApiError):
        return "Не удалось опубликовать файл в Telegram. Проверь права бота и размер файла."
    return "Не удалось обработать ссылку."


def update_failure_status(
    publisher: TelegramPublisher,
    config: dict[str, str],
    message: str,
) -> None:
    try:
        publisher.edit_status(
            config["source_chat_id"],
            config["status_message_id"],
            f"❌ {message}",
        )
        mark_status_reported()
    except Exception:
        LOGGER.exception("Could not update Telegram failure status")


def mark_status_reported() -> None:
    marker = os.environ.get("STATUS_MARKER", "").strip()
    if marker:
        Path(marker).touch()


if __name__ == "__main__":
    sys.exit(main())
