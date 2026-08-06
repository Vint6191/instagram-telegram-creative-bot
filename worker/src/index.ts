import { telegramWebhookSecret } from "./config";
import { handleAgentApi, REFERENCE_PROTOCOL_VERSION } from "./agent-api";
import { UpdateHandler } from "./handlers";
import { JobQueue } from "./job-queue";
import { queueStub } from "./queue";
import type { Env, TelegramUpdate } from "./types";

export { JobQueue };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await routeRequest(request, env);
    } catch (error) {
      console.error("worker request failed", {
        method: request.method,
        path: new URL(request.url).pathname,
        error: error instanceof Error ? error.message : String(error),
      });
      return Response.json(
        { ok: false, error: "Internal worker error" },
        {
          status: 500,
          headers: {
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        },
      );
    }
  },
} satisfies ExportedHandler<Env>;

async function routeRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    const queue = queueStub(env);
    const [creativeStats, referenceStats] = await Promise.all([
      queue.stats(),
      queue.referenceStats(),
    ]);
    return Response.json(
      {
        ok: true,
        appVersion: "4.0.1",
        architecture: "creative-reference-split-v4",
        referenceProtocol: REFERENCE_PROTOCOL_VERSION,
        buildId: env.BUILD_ID?.trim() || "local",
        creatives: creativeStats,
        references: referenceStats,
      },
      { headers: { "cache-control": "no-store" } },
    );
  }

  if (url.pathname.startsWith("/agent/")) {
    return handleAgentApi(request, env, url.pathname);
  }

  if (request.method === "POST" && url.pathname === "/telegram/webhook") {
    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (!secret || secret !== (await telegramWebhookSecret(env))) {
      return new Response("Unauthorized", { status: 401 });
    }

    let update: TelegramUpdate;
    try {
      update = (await request.json()) as TelegramUpdate;
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    const handler = new UpdateHandler(env);
    await handler.handle(update);
    return new Response("OK");
  }

  return new Response("Not Found", { status: 404 });
}
