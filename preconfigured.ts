import {
  PRECONFIGURED_ADMIN_CLAIM_CODE,
  PRECONFIGURED_SETUP_TOKEN,
  PRECONFIGURED_TELEGRAM_BOT_TOKEN,
  PRECONFIGURED_TELEGRAM_WEBHOOK_SECRET,
  requireConfigured,
} from "./preconfigured";
import type { Env } from "./types";

export function telegramBotToken(env: Env): string {
  return requireConfigured(
    env.TELEGRAM_BOT_TOKEN || PRECONFIGURED_TELEGRAM_BOT_TOKEN,
    "TELEGRAM_BOT_TOKEN",
  );
}

export function telegramWebhookSecret(env: Env): string {
  return requireConfigured(
    env.TELEGRAM_WEBHOOK_SECRET || PRECONFIGURED_TELEGRAM_WEBHOOK_SECRET,
    "TELEGRAM_WEBHOOK_SECRET",
  );
}

export function setupToken(env: Env): string {
  return requireConfigured(env.SETUP_TOKEN || PRECONFIGURED_SETUP_TOKEN, "SETUP_TOKEN");
}

export function adminClaimCode(env: Env): string {
  return requireConfigured(
    env.ADMIN_CLAIM_CODE || PRECONFIGURED_ADMIN_CLAIM_CODE,
    "ADMIN_CLAIM_CODE",
  );
}
