# Архитектура

## Поток обработки

```text
Telegram update
  → Cloudflare Worker
  → проверка владельца / сотрудника / target
  → GitHub workflow_dispatch
  → GitHub-hosted runner
  → gallery-dl / yt-dlp
  → FFmpeg при необходимости
  → Telegram Bot API
```

## Cloudflare Worker

Отвечает только за быстрые операции:

- webhook Telegram;
- дедупликация update;
- первичное назначение владельца;
- сотрудники и одноразовые приглашения;
- выбранный канал или группа;
- проверка Instagram URL;
- запуск GitHub Actions.

Он не скачивает видео и не запускает FFmpeg.

## Cloudflare KV

Ключи разделены по назначению:

- `settings:root-admin` — владелец;
- `settings:target` — место публикации;
- `user:*` — сотрудники;
- `invite:*` — одноразовые приглашения;
- `update:*` — дедупликация Telegram updates;
- `meta:bot` — идентичность бота.

## GitHub Actions

Workflow `process-instagram.yml` получает снимок target chat ID в момент постановки задачи. Даже если владелец сразу поменяет канал, уже принятая задача уйдёт туда, куда была направлена при постановке.

`concurrency` допускает только один активный Instagram-сеанс, чтобы не использовать cookies параллельно и не создавать лишнюю нагрузку.

Runner временный. После завершения скачанные файлы уничтожаются вместе с окружением.

## Конфигурация

В preconfigured-сборке встроены:

- Telegram bot token;
- Telegram webhook secret;
- закрытый setup token;
- код первичного владельца.

Через GitHub Secrets передаются только внешние инфраструктурные ключи:

- Cloudflare Account ID;
- Cloudflare API token;
- GitHub token для `workflow_dispatch`;
- опциональные Instagram cookies.
