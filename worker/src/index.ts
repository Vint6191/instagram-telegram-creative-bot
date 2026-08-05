import {
  setupToken,
  telegramBotToken,
  telegramWebhookSecret,
} from "./config";
import { UpdateHandler } from "./handlers";
import { ConfigStore } from "./store";
import { TelegramClient } from "./telegram";
import type { Env, TelegramUpdate } from "./types";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/admin/setup") {
      return setupBot(request, env, url.origin);
    }

    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (!secret || secret !== telegramWebhookSecret(env)) {
        return new Response("Unauthorized", { status: 401 });
      }

      let update: TelegramUpdate;
      try {
        update = (await request.json()) as TelegramUpdate;
      } catch {
        return new Response("Bad Request", { status: 400 });
      }

      const handler = new UpdateHandler(env);
      ctx.waitUntil(
        handler.handle(update).catch((error) => {
          console.error("unhandled update error", error);
        }),
      );
      return new Response("OK");
    }

    return new Response("Not Found", { status: 404 });
  },
};

async function setupBot(request: Request, env: Env, origin: string): Promise<Response> {
  const authorization = request.headers.get("authorization");
  if (authorization !== `Bearer ${setupToken(env)}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const telegram = new TelegramClient(telegramBotToken(env));
  const bot = await telegram.getMe();
  await telegram.setWebhook(`${origin}/telegram/webhook`, telegramWebhookSecret(env));
  await telegram.setMyCommands();

  const store = new ConfigStore(env.CONFIG, env.ROOT_ADMIN_ID);
  await store.setBotIdentity({
    id: String(bot.id),
    ...(bot.username ? { username: bot.username } : {}),
  });

  return Response.json({
    ok: true,
    bot: bot.username ? `@${bot.username}` : String(bot.id),
    webhook: `${origin}/telegram/webhook`,
  });
}
