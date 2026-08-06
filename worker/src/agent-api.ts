import { telegramBotToken } from "./config";
import { LOCAL_AGENT_ID, LOCAL_AGENT_TOKEN_SHA256 } from "./local-agent";
import { queueStub } from "./queue";
import { ConfigStore } from "./store";
import { TelegramClient, escapeHtml } from "./telegram";
import type { ReferenceCatalogItem, ReferenceDiscoveredItem } from "./reference-types";
import type { Env, QueueJobRecord, QueueStage } from "./types";

const APP_VERSION_HEADER = "x-creative-bot-version";
const HOSTNAME_HEADER = "x-creative-bot-hostname";

export async function handleAgentApi(request: Request, env: Env, pathname: string): Promise<Response> {
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const token = bearerToken(request);
  if (!token || !(await validAgentToken(token))) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  const hostname = request.headers.get(HOSTNAME_HEADER) ?? undefined;
  const appVersion = request.headers.get(APP_VERSION_HEADER) ?? undefined;
  const queue = queueStub(env);
  await queue.touchAgent(LOCAL_AGENT_ID, hostname, appVersion);

  if (pathname === "/agent/status") {
    return json({
      ok: true,
      stats: await queue.stats(),
      references: await queue.referenceStats(),
    });
  }

  if (pathname === "/agent/lease") {
    const leased = await queue.leaseNext(LOCAL_AGENT_ID);
    if (!leased) return json({ ok: true, job: null, stats: await queue.stats() });
    await safeStatusEdit(env, leased.job, "⬇️ Скачиваю и публикую…");
    return json({
      ok: true,
      job: leased.job,
      leaseToken: leased.leaseToken,
      telegramBotToken: telegramBotToken(env),
      stats: await queue.stats(),
    });
  }

  if (pathname.startsWith("/agent/references/")) {
    return handleReferencesApi(request, env, pathname);
  }

  const body = await readJson(request);
  if (!body) return json({ ok: false, error: "Invalid JSON" }, 400);
  const jobId = text(body.jobId, 120);
  const leaseToken = text(body.leaseToken, 160);
  if (!jobId || !leaseToken) return json({ ok: false, error: "jobId and leaseToken are required" }, 400);

  if (pathname === "/agent/heartbeat") {
    const job = await queue.heartbeat(LOCAL_AGENT_ID, jobId, leaseToken);
    return job ? json({ ok: true, job }) : json({ ok: false, error: "Lease expired" }, 409);
  }

  if (pathname === "/agent/progress") {
    const stage = text(body.stage, 40) as QueueStage;
    const job = await queue.updateProgress(LOCAL_AGENT_ID, jobId, leaseToken, stage);
    if (!job) return json({ ok: false, error: "Lease expired or invalid stage" }, 409);
    await safeStatusEdit(env, job, statusText(stage));
    return json({ ok: true, job });
  }

  if (pathname === "/agent/complete") {
    const job = await queue.complete(LOCAL_AGENT_ID, jobId, leaseToken);
    if (!job) return json({ ok: false, error: "Lease expired" }, 409);
    await safeStatusEdit(env, job, "✅ Опубликовано.");
    return json({ ok: true, job });
  }

  if (pathname === "/agent/fail") {
    const error = text(body.error, 1200) || "Неизвестная ошибка локального приложения";
    const publicError = text(body.publicError, 300) || "Не удалось обработать ссылку.";
    const retryable = body.retryable === true;
    const retryAfterSeconds = clampNumber(body.retryAfterSeconds, 30, 3600, 180);
    const result = await queue.fail(
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
      await safeStatusEdit(env, result.job, `⚠️ Временная ошибка. Повторю через ${minutes} мин.`);
    } else {
      await safeStatusEdit(env, result.job, `❌ ${escapeHtml(publicError)}`);
    }
    return json({ ok: true, job: result.job, willRetry: result.willRetry });
  }

  return json({ ok: false, error: "Not found" }, 404);
}

async function handleReferencesApi(request: Request, env: Env, pathname: string): Promise<Response> {
  const queue = queueStub(env);

  if (pathname === "/agent/references/catalog-lease") {
    const lease = await queue.leaseReferenceCatalog(LOCAL_AGENT_ID);
    return json({
      ok: true,
      catalog: lease,
      references: await queue.referenceStats(),
    });
  }

  if (pathname === "/agent/references/scan-lease") {
    const lease = await queue.leaseReferenceScan(LOCAL_AGENT_ID);
    if (!lease) {
      return json({ ok: true, scan: null, references: await queue.referenceStats() });
    }
    return json({
      ok: true,
      scan: lease,
      references: await queue.referenceStats(),
    });
  }

  if (pathname === "/agent/references/upload-lease") {
    // Never lease or burn an upload attempt before the visible Telegram
    // warehouse has been configured. Earlier builds consumed all retries here.
    const store = new ConfigStore(env.CONFIG, env.ROOT_ADMIN_ID);
    const warehouse = await store.getWarehouse();
    if (!warehouse) {
      return json({
        ok: true,
        upload: null,
        warehouseMissing: true,
        references: await queue.referenceStats(),
      });
    }
    const lease = await queue.leaseReferenceUpload(LOCAL_AGENT_ID);
    if (!lease) {
      return json({ ok: true, upload: null, references: await queue.referenceStats() });
    }
    return json({
      ok: true,
      upload: lease,
      warehouseChatId: warehouse.chatId,
      telegramBotToken: telegramBotToken(env),
      references: await queue.referenceStats(),
    });
  }

  if (pathname === "/agent/references/delivery-lease") {
    const lease = await queue.leaseReferenceDelivery(LOCAL_AGENT_ID);
    return json({
      ok: true,
      delivery: lease,
      ...(lease ? { telegramBotToken: telegramBotToken(env) } : {}),
      references: await queue.referenceStats(),
    });
  }

  if (pathname === "/agent/references/stats") {
    return json({ ok: true, references: await queue.referenceStats() });
  }

  const body = await readJson(request);
  if (!body) return json({ ok: false, error: "Invalid JSON" }, 400);

  if (pathname === "/agent/references/catalog-complete") {
    const leaseToken = text(body.leaseToken, 160);
    const niches = Array.isArray(body.niches)
      ? body.niches.filter(isRecord).slice(0, 2500) as unknown as ReferenceCatalogItem[]
      : [];
    if (!leaseToken) return json({ ok: false, error: "leaseToken is required" }, 400);
    const result = await queue.completeReferenceCatalog(
      LOCAL_AGENT_ID,
      leaseToken,
      niches,
      body.completeSnapshot === true,
    );
    return result
      ? json({ ok: true, ...result, references: await queue.referenceStats() })
      : json({ ok: false, error: "Catalog lease expired" }, 409);
  }

  if (pathname === "/agent/references/catalog-fail") {
    const done = await queue.failReferenceCatalog(
      LOCAL_AGENT_ID,
      text(body.leaseToken, 160),
      text(body.error, 1200) || "Unknown RedGIFs catalog error",
    );
    return done ? json({ ok: true }) : json({ ok: false, error: "Catalog lease expired" }, 409);
  }

  if (pathname === "/agent/references/enrich") {
    const mediaId = text(body.mediaId, 160);
    const item = isRecord(body.item) ? body.item as unknown as ReferenceDiscoveredItem : null;
    if (!mediaId || !item) return json({ ok: false, error: "mediaId and item are required" }, 400);
    const result = await queue.enrichReferenceItem(mediaId, item);
    return result ? json({ ok: true, item: result }) : json({ ok: false, error: "Reference not found" }, 404);
  }

  if (pathname === "/agent/references/discover") {
    const nicheSlug = text(body.nicheSlug, 120);
    const items = Array.isArray(body.items)
      ? body.items.filter(isRecord).slice(0, 10) as unknown as ReferenceDiscoveredItem[]
      : [];
    if (!nicheSlug) return json({ ok: false, error: "nicheSlug is required" }, 400);
    const uploads = await queue.discoverReferenceItems(nicheSlug, items);
    return json({ ok: true, uploads });
  }

  if (pathname === "/agent/references/upload-complete") {
    const mediaId = text(body.mediaId, 160);
    const leaseToken = text(body.leaseToken, 160);
    const fileId = text(body.fileId, 600);
    const fileUniqueId = text(body.fileUniqueId, 600);
    const warehouseChatId = text(body.warehouseChatId, 80);
    const warehouseMessageId = text(body.warehouseMessageId, 80);
    if (!mediaId || !leaseToken || !fileId || !warehouseChatId || !warehouseMessageId) {
      return json({
        ok: false,
        error: "mediaId, leaseToken, fileId and warehouse message are required",
      }, 400);
    }
    const result = await queue.completeReferenceUpload(
      LOCAL_AGENT_ID,
      mediaId,
      leaseToken,
      fileId,
      fileUniqueId || undefined,
      warehouseChatId || undefined,
      warehouseMessageId || undefined,
    );
    return result ? json({ ok: true, ...result }) : json({ ok: false, error: "Upload lease expired" }, 409);
  }

  if (pathname === "/agent/references/upload-fail") {
    const done = await queue.failReferenceUpload(
      LOCAL_AGENT_ID,
      text(body.mediaId, 160),
      text(body.leaseToken, 160),
      text(body.error, 1200) || "Unknown RedGIFs upload error",
      clampNumber(body.retryAfterSeconds, 60, 3600, 300),
    );
    return done ? json({ ok: true }) : json({ ok: false, error: "Upload lease expired" }, 409);
  }

  if (pathname === "/agent/references/store") {
    const mediaId = text(body.mediaId, 160);
    const fileId = text(body.fileId, 600);
    const fileUniqueId = text(body.fileUniqueId, 600);
    const warehouseChatId = text(body.warehouseChatId, 80);
    const warehouseMessageId = text(body.warehouseMessageId, 80);
    if (!mediaId || !fileId || !warehouseChatId || !warehouseMessageId) {
      return json({ ok: false, error: "Warehouse message is required" }, 400);
    }
    const result = await queue.storeReferenceMedia(
      mediaId,
      fileId,
      fileUniqueId || undefined,
      warehouseChatId || undefined,
      warehouseMessageId || undefined,
    );
    return json({ ok: true, ...result });
  }

  if (pathname === "/agent/references/scan-complete") {
    const done = await queue.completeReferenceScan(
      LOCAL_AGENT_ID,
      text(body.nicheSlug, 120),
      text(body.leaseToken, 160),
    );
    return done ? json({ ok: true }) : json({ ok: false, error: "Scan lease expired" }, 409);
  }

  if (pathname === "/agent/references/scan-fail") {
    const done = await queue.failReferenceScan(
      LOCAL_AGENT_ID,
      text(body.nicheSlug, 120),
      text(body.leaseToken, 160),
      text(body.error, 1200) || "Unknown RedGIFs scan error",
    );
    return done ? json({ ok: true }) : json({ ok: false, error: "Scan lease expired" }, 409);
  }

  if (pathname === "/agent/references/delivery-complete") {
    const done = await queue.completeReferenceDelivery(
      LOCAL_AGENT_ID,
      text(body.deliveryId, 120),
      text(body.leaseToken, 160),
      text(body.telegramMessageId, 80),
    );
    return done ? json({ ok: true }) : json({ ok: false, error: "Delivery lease expired" }, 409);
  }

  if (pathname === "/agent/references/delivery-fail") {
    const done = await queue.failReferenceDelivery(
      LOCAL_AGENT_ID,
      text(body.deliveryId, 120),
      text(body.leaseToken, 160),
      text(body.error, 1200) || "Unknown Telegram delivery error",
      clampNumber(body.retryAfterSeconds, 30, 3600, 120),
    );
    return done ? json({ ok: true }) : json({ ok: false, error: "Delivery lease expired" }, 409);
  }

  return json({ ok: false, error: "Not found" }, 404);
}

async function validAgentToken(token: string): Promise<boolean> {
  const digest = await sha256Base64Url(token);
  if (digest.length !== LOCAL_AGENT_TOKEN_SHA256.length) return false;
  let difference = 0;
  for (let index = 0; index < digest.length; index += 1) {
    difference |= digest.charCodeAt(index) ^ LOCAL_AGENT_TOKEN_SHA256.charCodeAt(index);
  }
  return difference === 0;
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
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
    case "starting": return "⏳ Начинаю обработку…";
    case "downloading": return "⬇️ Скачиваю из Instagram…";
    case "preparing": return "🎞 Подготавливаю файлы…";
    case "uploading": return "📤 Публикую в Telegram…";
    default: return "⏳ Обрабатываю…";
  }
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = (await request.json()) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}
