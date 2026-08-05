from creative_bot.domain import InstagramStats
from creative_bot.formatting import build_caption, format_count


def test_format_count() -> None:
    assert format_count(128430) == "128 430"


def test_caption_contains_only_available_stats() -> None:
    caption = build_caption(
        InstagramStats(username="demo", likes=1000, comments=23),
        "https://www.instagram.com/reel/ABC/",
    )
    assert "@demo" in caption
    assert "❤️ 1 000" in caption
    assert "💬 23" in caption
    assert "👁" not in caption
    assert "Категории" not in caption
    assert "Сохранено" not in caption
