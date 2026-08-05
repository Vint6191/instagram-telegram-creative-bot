from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def main() -> None:
    marker = Path(os.environ.get("STATUS_MARKER", "/tmp/creative-bot-status-reported"))
    if marker.exists():
        return

    token = os.environ["TELEGRAM_BOT_TOKEN"]
    payload = urlencode(
        {
            "chat_id": os.environ["SOURCE_CHAT_ID"],
            "message_id": os.environ["STATUS_MESSAGE_ID"],
            "text": "❌ GitHub Action завершился ошибкой до запуска загрузчика. Проверь журнал Actions.",
        }
    ).encode("utf-8")
    request = Request(
        f"https://api.telegram.org/bot{token}/editMessageText",
        data=payload,
        method="POST",
    )
    with urlopen(request, timeout=30) as response:
        result = json.load(response)
    if not result.get("ok"):
        raise SystemExit(result)


if __name__ == "__main__":
    main()
