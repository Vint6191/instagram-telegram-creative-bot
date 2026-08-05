import pytest

from creative_bot.instagram import (
    InstagramDownloadError,
    canonicalize_instagram_url,
    extract_stats,
)


def test_extract_stats_from_nested_documents() -> None:
    stats = extract_stats(
        [
            {
                "owner": {"username": "creator_account", "follower_count": "540000"},
                "edge_media_preview_like": {"count": 128430},
                "edge_media_to_comment": {"count": 1284},
                "video_view_count": 3700000,
            }
        ]
    )
    assert stats.username == "creator_account"
    assert stats.likes == 128430
    assert stats.comments == 1284
    assert stats.views == 3700000
    assert stats.followers == 540000


def test_canonicalize_url() -> None:
    assert canonicalize_instagram_url(
        "https://instagram.com/reels/ABC_123/?igsh=test"
    ) == "https://www.instagram.com/reel/ABC_123/"


def test_reject_foreign_host() -> None:
    with pytest.raises(InstagramDownloadError):
        canonicalize_instagram_url("https://instagram.com.evil.test/reel/ABC/")
