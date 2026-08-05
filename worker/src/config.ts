import type { Env } from "./types";

export function telegramBotToken(env: Env): string {
  return required(env.TELEGRAM_BOT_TOKEN, "TELEGRAM_BOT_TOKEN");
}

export async function telegramWebhookSecret(env: Env): Promise<string> {
  const token = telegramBotToken(env);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function adminClaimCode(env: Env): string {
  return (env.ADMIN_CLAIM_CODE ?? "").trim();
}

function required(value: string | undefined, name: string): string {
  const normalized = (value ?? "").trim();
  if (!normalized) throw new Error(`${name} is not configured`);
  return normalized;
}
