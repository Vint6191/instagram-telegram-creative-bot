import type { Env } from "./types";

export function telegramBotToken(env: Env): string {
  return required(env.TELEGRAM_BOT_TOKEN, "TELEGRAM_BOT_TOKEN");
}

export function telegramWebhookSecret(env: Env): string {
  return required(env.TELEGRAM_WEBHOOK_SECRET, "TELEGRAM_WEBHOOK_SECRET");
}

export function setupToken(env: Env): string {
  return required(env.SETUP_TOKEN, "SETUP_TOKEN");
}

export function adminClaimCode(env: Env): string {
  return (env.ADMIN_CLAIM_CODE ?? "").trim();
}

function required(value: string | undefined, name: string): string {
  const normalized = (value ?? "").trim();
  if (!normalized) throw new Error(`${name} is not configured`);
  return normalized;
}
