from __future__ import annotations

from html import escape

from .domain import InstagramStats


def format_count(value: int) -> str:
    return f"{value:,}".replace(",", " ")


def build_caption(stats: InstagramStats, original_url: str) -> str:
    lines: list[str] = []

    if stats.username:
        username = stats.username.lstrip("@")
        lines.append(f"👤 <b>@{escape(username)}</b>")

    metrics: list[str] = []
    if stats.likes is not None:
        metrics.append(f"❤️ {format_count(stats.likes)}")
    if stats.comments is not None:
        metrics.append(f"💬 {format_count(stats.comments)}")
    if stats.views is not None:
        metrics.append(f"👁 {format_count(stats.views)}")
    if stats.followers is not None:
        metrics.append(f"👥 {format_count(stats.followers)}")

    if lines and metrics:
        lines.append("")
    lines.extend(metrics)

    if lines:
        lines.append("")
    lines.append(f'🔗 <a href="{escape(original_url, quote=True)}">Оригинал</a>')

    caption = "\n".join(lines)
    if len(caption) > 1024:
        raise ValueError("Telegram caption exceeds 1024 characters")
    return caption
