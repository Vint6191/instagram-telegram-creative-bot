import { telegramBotToken } from "./config";
import { LOCAL_AGENT_ID, LOCAL_AGENT_TOKEN_SHA256 } from "./local-agent";
import { queueStub } from "./queue";
import { ConfigStore } from "./store";
import { TelegramClient, escapeHtml } from "./telegram";
import { clampNumber, cleanText } from "./shared";
import type { ReferenceDiscoveredItem } from "./reference-types";
import type { Env, QueueJobRecord, QueueStage } from "./types";

export const REFERENCE_PROTOCOL_VERSION = 5;
const APP_VERSION_HEADER = "x-creative-bot-version";
const HOSTNAME_HEADER = "x-creative-bot-hostname";

export async function handleAgentApi(request: Request, env: Env, pathname: string): Promise<Response> {
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const token = bearerToken(request);
  if (!token || !(await validAgentToken(token))) return json({ ok: false, error: "Unauthorized" }, 401);

  const queue = queueStub(env);
  await queue.touchAgent(
    LOCAL_AGENT_ID,
    request.headers.get(HOSTNAME_HEADER) ?? undefined,
    request.headers.get(APP_VERSION_HEADER) ?? undefined,
  );

  if (pathname === "/agent/status") {
    return json({
      ok: true,
      stats: await queue.stats(),
      references: await queue.referenceStats(),
      referenceProtocol: REFERENCE_PROTOCOL_VERSION,
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

  if (pathname === "/agent/references/status") {
    const warehouse = await new ConfigStore(env.CONFIG, env.ROOT_ADMIN_ID).getWarehouse();
    return referenceJson({
      ok: true,
      references: await queue.referenceStats(),
      warehouseConfigured: Boolean(warehouse),
      ...(warehouse ? { warehouseChatId: warehouse.chatId, warehouseTitle: warehouse.title } : {}),
    });
  }

  if (pathname === "/agent/references/scan-lease") {
    const warehouse = await new ConfigStore(env.CONFIG, env.ROOT_ADMIN_ID).getWarehouse();
    if (!warehouse) {
      return referenceJson({
        ok: true,
        scan: null,
        blocked: "warehouse_not_configured",
        references: await queue.referenceStats(),
      });
    }
    const scan = await queue.leaseReferenceScan(LOCAL_AGENT_ID);
    return referenceJson({ ok: true, scan, references: await queue.referenceStats() });
  }

  if (pathname === "/agent/references/upload-lease") {
    const warehouse = await new ConfigStore(env.CONFIG, env.ROOT_ADMIN_ID).getWarehouse();
    if (!warehouse) {
      return referenceJson({
        ok: true,
        upload: null,
        blocked: "warehouse_not_configured",
        references: await queue.referenceStats(),
      });
    }
    const upload = await queue.leaseReferenceUpload(LOCAL_AGENT_ID, warehouse.chatId);
    return referenceJson({
      ok: true,
      upload,
      ...(upload ? {
        warehouseChatId: warehouse.chatId,
        telegramBotToken: telegramBotToken(env),
      } : {}),
      references: await queue.referenceStats(),
    });
  }

  if (pathname === "/agent/references/delivery-lease") {
    const delivery = await queue.leaseReferenceDelivery(LOCAL_AGENT_ID);
    return referenceJson({
      ok: true,
      delivery,
      ...(delivery ? { telegramBotToken: telegramBotToken(env) } : {}),
      references: await queue.referenceStats(),
    });
  }

  const body = await readJson(request);
  if (!body) return json({ ok: false, error: "Invalid JSON" }, 400);

  if (pathname.startsWith("/agent/references/")) {
    return handleReferenceMutation(pathname, body, env);
  }

  const jobId = cleanText(body.jobId, 120);
  const leaseToken = cleanText(body.leaseToken, 160);
  if (!jobId || !leaseToken) return json({ ok: false, error: "jobId and leaseToken are required" }, 400);

  if (pathname === "/agent/heartbeat") {
    const job = await queue.heartbeat(LOCAL_AGENT_ID, jobId, leaseToken);
    return job ? json({ ok: true, job }) : json({ ok: false, error: "Lease expired" }, 409);
  }

  if (pathname === "/agent/progress") {
    const stage = cleanText(body.stage, 40) as QueueStage;
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
    const error = cleanText(body.error, 1200) || "Неизвестная ошибка локального приложения";
    const publicError = cleanText(body.publicError, 300) || "Не удалось обработать ссылку.";
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

async function handleReferenceMutation(
  pathname: string,
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  const queue = queueStub(env);

  if (pathname === "/agent/references/discover") {
    const nicheSlug = cleanText(body.nicheSlug, 120);
    const leaseToken = cleanText(body.leaseToken, 160);
    const items = Array.isArray(body.items)
      ? body.items.filter(isRecord).slice(0, 5) as unknown as ReferenceDiscoveredItem[]
      : [];
    if (!nicheSlug || !leaseToken) return referenceJson({ ok: false, error: "nicheSlug and leaseToken are required" }, 400);
    try {
      const uploads = await queue.discoverReferenceItems(LOCAL_AGENT_ID, nicheSlug, leaseToken, items);
      return referenceJson({ ok: true, uploads, references: await queue.referenceStats() });
    } catch (error) {
      return referenceJson({ ok: false, error: error instanceof Error ? error.message : "Discover failed" }, 409);
    }
  }

  if (pathname === "/agent/references/scan-complete") {
    const done = await queue.completeReferenceScan(
      LOCAL_AGENT_ID,
      cleanText(body.nicheSlug, 120),
      cleanText(body.leaseToken, 160),
    );
    return done ? referenceJson({ ok: true }) : referenceJson({ ok: false, error: "Scan lease expired" }, 409);
  }

  if (pathname === "/agent/references/scan-fail") {
    const done = await queue.failReferenceScan(
      LOCAL_AGENT_ID,
      cleanText(body.nicheSlug, 120),
      cleanText(body.leaseToken, 160),
      cleanText(body.error, 1200) || "Unknown RedGIFs scan error",
    );
    return done ? referenceJson({ ok: true }) : referenceJson({ ok: false, error: "Scan lease expired" }, 409);
  }

  if (pathname === "/agent/references/enrich") {
    const mediaId = cleanText(body.mediaId, 160);
    const item = isRecord(body.item) ? body.item as unknown as ReferenceDiscoveredItem : null;
    if (!mediaId || !item) return referenceJson({ ok: false, error: "mediaId and item are required" }, 400);
    const result = await queue.enrichReferenceItem(mediaId, item);
    return result
      ? referenceJson({ ok: true, item: result })
      : referenceJson({ ok: false, error: "Reference not found" }, 404);
  }

  if (pathname === "/agent/references/upload-reconcile") {
    const mediaId = cleanText(body.mediaId, 160);
    const fileId = cleanText(body.fileId, 600);
    const fileUniqueId = cleanText(body.fileUniqueId, 600) || undefined;
    const warehouseChatId = cleanText(body.warehouseChatId, 80);
    const warehouseMessageId = cleanText(body.warehouseMessageId, 80);
    if (!mediaId || !fileId || !warehouseChatId || !warehouseMessageId) {
      return referenceJson({ ok: false, error: "Warehouse receipt is incomplete" }, 400);
    }
    try {
      const result = await queue.reconcileReferenceUpload(
        mediaId,
        fileId,
        fileUniqueId,
        warehouseChatId,
        warehouseMessageId,
      );
      return referenceJson({ ok: true, ...result, references: await queue.referenceStats() });
    } catch (error) {
      return referenceJson({
        ok: false,
        error: error instanceof Error ? error.message : "Upload receipt reconciliation failed",
      }, 409);
    }
  }

  if (pathname === "/agent/references/delivery-reconcile") {
    const deliveryId = cleanText(body.deliveryId, 120);
    const telegramMessageId = cleanText(body.telegramMessageId, 80);
    if (!deliveryId || !telegramMessageId) {
      return referenceJson({ ok: false, error: "Delivery receipt is incomplete" }, 400);
    }
    const done = await queue.reconcileReferenceDelivery(deliveryId, telegramMessageId);
    return done
      ? referenceJson({ ok: true })
      : referenceJson({ ok: false, error: "Delivery receipt no longer exists" }, 404);
  }

  if (pathname === "/agent/references/upload-complete") {
    const mediaId = cleanText(body.mediaId, 160);
    const leaseToken = cleanText(body.leaseToken, 160);
    const fileId = cleanText(body.fileId, 600);
    const fileUniqueId = cleanText(body.fileUniqueId, 600) || undefined;
    const warehouseChatId = cleanText(body.warehouseChatId, 80);
    const warehouseMessageId = cleanText(body.warehouseMessageId, 80);
    if (!mediaId || !leaseToken || !fileId || !warehouseChatId || !warehouseMessageId) {
      return referenceJson({ ok: false, error: "Warehouse upload data is incomplete" }, 400);
    }
    const result = await queue.completeReferenceUpload(
      LOCAL_AGENT_ID,
      mediaId,
      leaseToken,
      fileId,
      fileUniqueId,
      warehouseChatId,
      warehouseMessageId,
    );
    return result
      ? referenceJson({ ok: true, ...result, references: await queue.referenceStats() })
      : referenceJson({ ok: false, error: "Upload lease expired" }, 409);
  }

  if (pathname === "/agent/references/upload-fail") {
    const done = await queue.failReferenceUpload(
      LOCAL_AGENT_ID,
      cleanText(body.mediaId, 160),
      cleanText(body.leaseToken, 160),
      cleanText(body.error, 1200) || "Unknown warehouse upload error",
      clampNumber(body.retryAfterSeconds, 60, 3600, 300),
    );
    return done ? referenceJson({ ok: true }) : referenceJson({ ok: false, error: "Upload lease expired" }, 409);
  }

  if (pathname === "/agent/references/delivery-complete") {
    const done = await queue.completeReferenceDelivery(
      LOCAL_AGENT_ID,
      cleanText(body.deliveryId, 120),
      cleanText(body.leaseToken, 160),
      cleanText(body.telegramMessageId, 80),
    );
    return done ? referenceJson({ ok: true }) : referenceJson({ ok: false, error: "Delivery lease expired" }, 409);
  }

  if (pathname === "/agent/references/delivery-fail") {
    const done = await queue.failReferenceDelivery(
      LOCAL_AGENT_ID,
      cleanText(body.deliveryId, 120),
      cleanText(body.leaseToken, 160),
      cleanText(body.error, 1200) || "Unknown reference delivery error",
      clampNumber(body.retryAfterSeconds, 30, 3600, 180),
    );
    return done ? referenceJson({ ok: true }) : referenceJson({ ok: false, error: "Delivery lease expired" }, 409);
  }

  return referenceJson({ ok: false, error: "Not found" }, 404);
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

function bearerToken(request: Request): string | null {
  const match = (request.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/iu);
  return match?.[1]?.trim() || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function referenceJson(body: Record<string, unknown>, status = 200): Response {
  return json({ ...body, referenceProtocol: REFERENCE_PROTOCOL_VERSION }, status);
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}
