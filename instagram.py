[build-system]
requires = ["setuptools>=75"]
build-backend = "setuptools.build_meta"

[project]
name = "instagram-creative-telegram-bot"
version = "1.0.1"
description = "Download Instagram media and publish it to Telegram"
requires-python = ">=3.12"
dependencies = [
  "gallery-dl==1.32.1",
  "yt-dlp==2026.6.9",
  "curl-cffi>=0.13,<1",
  "requests>=2.32,<3",
  "Pillow>=11,<13"
]

[project.optional-dependencies]
test = ["pytest>=8,<10"]

[project.scripts]
creative-bot-run = "creative_bot.main:main"

[tool.setuptools.packages.find]
where = ["src"]

[tool.pytest.ini_options]
pythonpath = ["src"]
testpaths = ["tests"]
