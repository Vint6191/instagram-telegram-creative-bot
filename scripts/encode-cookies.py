from __future__ import annotations

import argparse
import base64
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Encode Netscape cookies.txt for the INSTAGRAM_COOKIES_B64 GitHub secret"
    )
    parser.add_argument("cookies", type=Path)
    args = parser.parse_args()

    content = args.cookies.read_bytes()
    if not content.startswith(b"# Netscape HTTP Cookie File"):
        raise SystemExit("Expected Netscape cookies.txt format")
    print(base64.b64encode(content).decode("ascii"))


if __name__ == "__main__":
    main()
