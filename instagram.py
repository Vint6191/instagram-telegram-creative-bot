from __future__ import annotations

import json
import logging
import mimetypes
import time
from pathlib import Path
from typing import Any

import requests

LOGGER = logging.getLogger(__name__)

PHOTO_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
VIDEO_EXTENSIONS = {".mp4"}


class TelegramApiError(RuntimeError):
    def __init__(self, message: str, error_code: int | None = None) -> None:
        super().__init__(message)
        self.error_code = error_code


class TelegramPublisher:
    def __init__(self, token: str, timeout: int = 180) -> None:
        self.base_url = f"https://api.telegram.org/bot{token}"
        self.timeout = timeout
        self.session = requests.Session()

    def publish(self, chat_id: str, files: tuple[Path, ...], caption: str) -> None:
        first_item = True
        for offset in range(0, len(files), 10):
            chunk = files[offset : offset + 10]
            chunk_caption = caption if first_item else None
            if len(chunk) == 1:
                self._send_single(chat_id, chunk[0], chunk_caption)
            else:
                self._send_group(chat_id, chunk, chunk_caption)
            first_item = False

    def edit_status(self, chat_id: str, message_id: str, text: str) -> None:
        self._json_call(
            "editMessageText",
            {
                "chat_id": chat_id,
                "message_id": int(message_id),
                "text": text,
                "parse_mode": "HTML",
                "disable_web_page_preview": True,
            },
        )

    def _send_single(self, chat_id: str, path: Path, caption: str | None) -> None:
        extension = path.suffix.lower()
        if extension in PHOTO_EXTENSIONS:
            method = "sendPhoto"
            field = "photo"
            extra: dict[str, Any] = {}
        elif extension in VIDEO_EXTENSIONS:
            method = "sendVideo"
            field = "video"
            extra = {"supports_streaming": "true"}
        else:
            method = "sendDocument"
            field = "document"
            extra = {}

        data: dict[str, Any] = {
            "chat_id": chat_id,
            "parse_mode": "HTML",
            **extra,
        }
        if caption:
            data["caption"] = caption

        with path.open("rb") as handle:
            self._multipart_call(
                method,
                data,
                {field: (path.name, handle, mimetypes.guess_type(path.name)[0])},
            )

    def _send_group(
        self,
        chat_id: str,
        paths: tuple[Path, ...],
        caption: str | None,
    ) -> None:
        media: list[dict[str, Any]] = []
        handles: list[Any] = []
        files: dict[str, tuple[str, Any, str | None]] = {}
        try:
            for index, path in enumerate(paths):
                attachment = f"media{index}"
                handle = path.open("rb")
                handles.append(handle)
                files[attachment] = (
                    path.name,
                    handle,
                    mimetypes.guess_type(path.name)[0],
                )
                media_type = "photo" if path.suffix.lower() in PHOTO_EXTENSIONS else "video"
                item: dict[str, Any] = {
                    "type": media_type,
                    "media": f"attach://{attachment}",
                }
                if media_type == "video":
                    item["supports_streaming"] = True
                if index == 0 and caption:
                    item["caption"] = caption
                    item["parse_mode"] = "HTML"
                media.append(item)

            self._multipart_call(
                "sendMediaGroup",
                {"chat_id": chat_id, "media": json.dumps(media, ensure_ascii=False)},
                files,
            )
        finally:
            for handle in handles:
                handle.close()

    def _json_call(self, method: str, payload: dict[str, Any]) -> Any:
        return self._request(method, json_payload=payload)

    def _multipart_call(
        self,
        method: str,
        data: dict[str, Any],
        files: dict[str, tuple[str, Any, str | None]],
    ) -> Any:
        return self._request(method, data=data, files=files)

    def _request(
        self,
        method: str,
        *,
        json_payload: dict[str, Any] | None = None,
        data: dict[str, Any] | None = None,
        files: dict[str, tuple[str, Any, str | None]] | None = None,
    ) -> Any:
        last_error: Exception | None = None
        for attempt in range(1, 5):
            try:
                if files:
                    for _, file_tuple in files.items():
                        file_tuple[1].seek(0)
                response = self.session.post(
                    f"{self.base_url}/{method}",
                    json=json_payload,
                    data=data,
                    files=files,
                    timeout=self.timeout,
                )
                try:
                    body = response.json()
                except ValueError as exc:
                    raise TelegramApiError(
                        f"Telegram returned invalid JSON ({response.status_code})"
                    ) from exc

                if response.ok and body.get("ok"):
                    return body.get("result")

                retry_after = body.get("parameters", {}).get("retry_after")
                if response.status_code == 429 and retry_after and attempt < 4:
                    time.sleep(min(int(retry_after) + 1, 60))
                    continue

                description = body.get("description") or f"HTTP {response.status_code}"
                raise TelegramApiError(description, body.get("error_code"))
            except (requests.RequestException, TelegramApiError) as exc:
                last_error = exc
                if isinstance(exc, TelegramApiError) and exc.error_code not in {429, 500, 502, 503, 504}:
                    raise
                if attempt < 4:
                    time.sleep(2 ** (attempt - 1))

        raise TelegramApiError(f"Telegram request failed: {last_error}")
