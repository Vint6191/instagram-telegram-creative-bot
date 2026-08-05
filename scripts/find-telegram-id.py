from __future__ import annotations

import argparse
import json
from urllib.request import urlopen


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Print user IDs from recent Telegram bot updates before webhook setup"
    )
    parser.add_argument("token", help="Bot token from BotFather")
    args = parser.parse_args()

    with urlopen(f"https://api.telegram.org/bot{args.token}/getUpdates", timeout=30) as response:
        payload = json.load(response)

    seen: set[int] = set()
    for update in payload.get("result", []):
        message = update.get("message") or {}
        user = message.get("from") or {}
        user_id = user.get("id")
        if not isinstance(user_id, int) or user_id in seen:
            continue
        seen.add(user_id)
        username = user.get("username")
        name = " ".join(
            part for part in (user.get("first_name"), user.get("last_name")) if part
        )
        print(f"{user_id}\t@{username}" if username else f"{user_id}\t{name}")

    if not seen:
        print("No updates. Send /start to the bot and run the script again.")


if __name__ == "__main__":
    main()
