import { telegramBotToken } from "./config";
import { LOCAL_AGENT_ID, LOCAL_AGENT_TOKEN } from "./local-agent";
import { queueStub } from "./queue";
import { TelegramClient, escapeHtml } from "./telegram";
import type { AgentRecord, Env, QueueJobRecord, QueueStage } from "./types";

const APP_VERSION_HEADER = "x-creative-bot-version";
const HOSTNAME_HEADER = "x-creative-bot-hostname";

export async function handleAgentApi(request: Request, env: Env, pathname: string): Promise<Response> {
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const token = bearerToken(request);
  if (!token || token !== LOCAL_AGENT_TOKEN) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  const now = Date.now();
  const hostname = request.headers.get(HOSTNAME_HEADER) ?? undefined;
  const appVersion = request.headers.get(APP_VERSION_HEADER) ?? undefined;
  const agent: AgentRecord = {
    id: LOCAL_AGENT_ID,
    name: "Local desktop",
    ...(hostname ? { hostname } : {}),
    ...(appVersion ? { appVersion } : {}),
    createdAt: now,
    lastSeenAt: now,
    disabled: false,
  };

  if (pathname === "/agent/status") {
    const stats = await queueStub(env).stats();
    return json({ ok: true, agent, stats: { ...stats, onlineAgents: 1 } });
  }

  if (pathname === "/agent/lease") {
    const leased = await queueStub(env).leaseNext(LOCAL_AGENT_ID);
    if (!leased) {
      const stats = await queueStub(env).stats();
      return json({ ok: true, job: null, stats: { ...stats, onlineAgents: 1 } });
    }
    await safeStatusEdit(env, leased.job, "⬇️ Скачиваю и публикую…");
    const stats = await queueStub(env).stats();
    return json({
      ok: true,
      job: leased.job,
      leaseToken: leased.leaseToken,
      telegramBotToken: telegramBotToken(env),
      stats: { ...stats, onlineAgents: 1 },
    });
  }

  const body = await readJson(request);
  if (!body) return json({ ok: false, error: "Invalid JSON" }, 400);
  const jobId = text(body.jobId, 120);
  const leaseToken = text(body.leaseToken, 160);
  if (!jobId || !leaseToken) return json({ ok: false, error: "jobId and leaseToken are required" }, 400);

  if (pathname === "/agent/heartbeat") {
    const job = await queueStub(env).heartbeat(LOCAL_AGENT_ID, jobId, leaseToken);
    return job ? json({ ok: true, job }) : json({ ok: false, error: "Lease expired" }, 409);
  }

  if (pathname === "/agent/progress") {
    const stage = text(body.stage, 40) as QueueStage;
    const job = await queueStub(env).updateProgress(LOCAL_AGENT_ID, jobId, leaseToken, stage);
    if (!job) return json({ ok: false, error: "Lease expired or invalid stage" }, 409);
    await safeStatusEdit(env, job, statusText(stage));
    return json({ ok: true, job });
  }

  if (pathname === "/agent/complete") {
    const job = await queueStub(env).complete(LOCAL_AGENT_ID, jobId, leaseToken);
    if (!job) return json({ ok: false, error: "Lease expired" }, 409);
    await safeStatusEdit(env, job, "✅ Опубликовано.");
    return json({ ok: true, job });
  }

  if (pathname === "/agent/fail") {
    const error = text(body.error, 1200) || "Неизвестная ошибка локального приложения";
    const publicError = text(body.publicError, 300) || "Не удалось обработать ссылку.";
    const retryable = body.retryable === true;
    const retryAfterSeconds = clampNumber(body.retryAfterSeconds, 30, 3600, 180);
    const result = await queueStub(env).fail(
      LOCAL_AGENT_ID,
      jobId,
      leaseToken,
      error,
      retryable,
      retryAfterSeconds,
    );
    if (!result) return json({ ok: false, error: "Lease expired" }, 409);
    if (result.willRetry) {
      const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
      await safeStatusEdit(
        env,
        result.job,
        `⚠️ Временная ошибка. Повторю через ${minutes} мин.`,
      );
    } else {
      await safeStatusEdit(env, result.job, `❌ ${escapeHtml(publicError)}`);
    }
    return json({ ok: true, job: result.job, willRetry: result.willRetry });
  }

  return json({ ok: false, error: "Not found" }, 404);
}

async function safeStatusEdit(env: Env, job: QueueJobRecord, message: string): Promise<void> {
  const telegram = new TelegramClient(telegramBotToken(env));
  try {
    await telegram.editMessageText(job.sourceChatId, Number(job.statusMessageId), message);
  } catch (error) {
    console.error("status edit failed", {
      jobId: job.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function statusText(stage: QueueStage): string {
  switch (stage) {
    case "starting":
      return "⏳ Начинаю обработку…";
    case "downloading":
      return "⬇️ Скачиваю из Instagram…";
    case "preparing":
      return "🎞 Подготавливаю файлы…";
    case "uploading":
      return "📤 Публикую в Telegram…";
    default:
      return "⏳ Обрабатываю…";
  }
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = (await request.json()) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function bearerToken(request: Request): string | null {
  const value = request.headers.get("authorization") ?? "";
  const match = value.match(/^Bearer\s+(.+)$/iu);
  return match?.[1]?.trim() || null;
}

function text(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function clampNumber(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, Math.round(number))) : fallback;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
