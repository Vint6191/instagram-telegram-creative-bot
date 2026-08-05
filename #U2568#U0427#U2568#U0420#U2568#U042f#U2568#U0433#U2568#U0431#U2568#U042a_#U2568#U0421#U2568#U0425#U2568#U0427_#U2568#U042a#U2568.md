// Preconfigured build requested by the owner.
// Keep this repository PRIVATE: the Telegram bot token is intentionally embedded.
export const PRECONFIGURED_TELEGRAM_BOT_TOKEN = "7799844807:AAFBznwweXnHg9RIO_vwVlfNYtzkJSEf6UE";
export const PRECONFIGURED_ADMIN_CLAIM_CODE = "KSU-CTPWT34R";
export const PRECONFIGURED_TELEGRAM_WEBHOOK_SECRET = "XMPe394z0SszXw01WCayJefjvG-Hu1QS";
export const PRECONFIGURED_SETUP_TOKEN = "4wRRvvVygfC3fy1CzEoWxKyOguBBYOm7";

export function requireConfigured(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is empty`);
  return normalized;
}
