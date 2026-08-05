# Instagram → Telegram Creative Bot

Cloudflare Worker receives Instagram links from Telegram, stores them in a durable queue, and the local Windows/PyCharm application downloads and publishes them.

## What is in this repository

- `worker/` — Telegram webhook, access control, target channel settings, durable queue and local-agent API.
- `.github/workflows/deploy-worker.yml` — checks, deploys the Worker, preserves the existing KV configuration and configures the Telegram webhook.

The local PyCharm application is intentionally not stored here: its private agent token must not be published in GitHub.

## Required GitHub Actions secrets

Already-created repository secrets are preserved when repository files are replaced.

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `SETUP_TOKEN`

Optional: `ROOT_ADMIN_ID`, `ADMIN_CLAIM_CODE`.

## Normal operation

1. Start the local PyCharm application with `main.py`.
2. Send one Instagram Reel/post link to the Telegram bot.
3. The Worker stores it even while the computer is offline.
4. The local application downloads the media, publishes it with statistics, and cleans temporary files.
