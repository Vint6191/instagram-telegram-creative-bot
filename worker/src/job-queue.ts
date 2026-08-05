import { DurableObject } from "cloudflare:workers";
import type {
  Env,
  LeasedJob,
  QueueJobInput,
  QueueJobRecord,
  QueueStage,
  QueueStats,
} from "./types";

interface JobRow {
  id: string;
  request_key: string;
  url: string;
  requester_id: string;
  requester_name: string;
  source_chat_id: string;
  source_message_id: string;
  status_message_id: string;
  target_chat_id: string;
  status: string;
  stage: string;
  created_at: number;
  updated_at: number;
  available_at: number;
  attempt_count: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: number | null;
  last_error: string | null;
  completed_at: number | null;
}

const LEASE_MS = 10 * 60 * 1000;
const ONLINE_WINDOW_MS = 2 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export class JobQueue extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          request_key TEXT NOT NULL UNIQUE,
          url TEXT NOT NULL,
          requester_id TEXT NOT NULL,
          requester_name TEXT NOT NULL,
          source_chat_id TEXT NOT NULL,
          source_message_id TEXT NOT NULL,
          status_message_id TEXT NOT NULL,
          target_chat_id TEXT NOT NULL,
          status TEXT NOT NULL,
          stage TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          available_at INTEGER NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 5,
          lease_owner TEXT,
          lease_token TEXT,
          lease_expires_at INTEGER,
          last_error TEXT,
          completed_at INTEGER
        )
      `);
      this.ctx.storage.sql.exec(
        "CREATE INDEX IF NOT EXISTS jobs_pick_idx ON jobs(status, available_at, created_at)",
      );
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS agent_presence (
          id TEXT PRIMARY KEY,
          hostname TEXT,
          app_version TEXT,
          last_seen_at INTEGER NOT NULL
        )
      `);
    });
  }

  async touchAgent(agentId: string, hostname?: string, appVersion?: string): Promise<void> {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO agent_presence (id, hostname, app_version, last_seen_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         hostname = excluded.hostname,
         app_version = excluded.app_version,
         last_seen_at = excluded.last_seen_at`,
      cleanText(agentId, 80),
      cleanOptional(hostname, 120) ?? null,
      cleanOptional(appVersion, 40) ?? null,
      now,
    );
  }

  async enqueue(
    input: QueueJobInput,
  ): Promise<{ job: QueueJobRecord; position: number; duplicate: boolean }> {
    this.cleanup();
    const existing = this.ctx.storage.sql
      .exec<JobRow>("SELECT * FROM jobs WHERE request_key = ? LIMIT 1", input.requestKey)
      .toArray()[0];
    if (existing) {
      return {
        job: mapJob(existing),
        position: this.positionFor(existing.id, existing.created_at),
        duplicate: true,
      };
    }

    const now = Date.now();
    const id = randomId("job");
    this.ctx.storage.sql.exec(
      `INSERT INTO jobs (
        id, request_key, url, requester_id, requester_name,
        source_chat_id, source_message_id, status_message_id, target_chat_id,
        status, stage, created_at, updated_at, available_at,
        attempt_count, max_attempts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'queued', ?, ?, ?, 0, 5)`,
      id,
      input.requestKey,
      input.url,
      input.requesterId,
      input.requesterName,
      input.sourceChatId,
      input.sourceMessageId,
      input.statusMessageId,
      input.targetChatId,
      now,
      now,
      now,
    );
    const row = this.ctx.storage.sql.exec<JobRow>("SELECT * FROM jobs WHERE id = ?", id).one();
    return { job: mapJob(row), position: this.positionFor(id, now), duplicate: false };
  }

  async leaseNext(agentId: string): Promise<LeasedJob | null> {
    this.requeueExpiredLeases();
    const now = Date.now();
    const row = this.ctx.storage.sql
      .exec<JobRow>(
        `SELECT * FROM jobs
         WHERE status = 'queued' AND available_at <= ? AND attempt_count < max_attempts
         ORDER BY created_at ASC, id ASC LIMIT 1`,
        now,
      )
      .toArray()[0];
    if (!row) return null;

    const leaseToken = randomSecret(24);
    this.ctx.storage.sql.exec(
      `UPDATE jobs SET
         status = 'leased', stage = 'starting', updated_at = ?,
         attempt_count = attempt_count + 1,
         lease_owner = ?, lease_token = ?, lease_expires_at = ?
       WHERE id = ? AND status = 'queued'`,
      now,
      agentId,
      leaseToken,
      now + LEASE_MS,
      row.id,
    );
    const leased = this.ctx.storage.sql.exec<JobRow>("SELECT * FROM jobs WHERE id = ?", row.id).one();
    return leased.status === "leased" ? { job: mapJob(leased), leaseToken } : null;
  }

  async heartbeat(agentId: string, jobId: string, leaseToken: string): Promise<QueueJobRecord | null> {
    if (!this.findActiveLease(agentId, jobId, leaseToken)) return null;
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "UPDATE jobs SET updated_at = ?, lease_expires_at = ? WHERE id = ?",
      now,
      now + LEASE_MS,
      jobId,
    );
    return mapJob(this.ctx.storage.sql.exec<JobRow>("SELECT * FROM jobs WHERE id = ?", jobId).one());
  }

  async updateProgress(
    agentId: string,
    jobId: string,
    leaseToken: string,
    stage: QueueStage,
  ): Promise<QueueJobRecord | null> {
    const allowed = new Set<QueueStage>(["starting", "downloading", "preparing", "uploading"]);
    if (!allowed.has(stage) || !this.findActiveLease(agentId, jobId, leaseToken)) return null;
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "UPDATE jobs SET stage = ?, updated_at = ?, lease_expires_at = ? WHERE id = ?",
      stage,
      now,
      now + LEASE_MS,
      jobId,
    );
    return mapJob(this.ctx.storage.sql.exec<JobRow>("SELECT * FROM jobs WHERE id = ?", jobId).one());
  }

  async complete(agentId: string, jobId: string, leaseToken: string): Promise<QueueJobRecord | null> {
    if (!this.findActiveLease(agentId, jobId, leaseToken)) return null;
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `UPDATE jobs SET
         status = 'completed', stage = 'completed', updated_at = ?, completed_at = ?,
         lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, last_error = NULL
       WHERE id = ?`,
      now,
      now,
      jobId,
    );
    return mapJob(this.ctx.storage.sql.exec<JobRow>("SELECT * FROM jobs WHERE id = ?", jobId).one());
  }

  async fail(
    agentId: string,
    jobId: string,
    leaseToken: string,
    error: string,
    retryable: boolean,
    retryAfterSeconds: number,
  ): Promise<{ job: QueueJobRecord; willRetry: boolean } | null> {
    const row = this.findActiveLease(agentId, jobId, leaseToken);
    if (!row) return null;
    const now = Date.now();
    const message = cleanText(error, 1200) || "Unknown desktop error";
    const delaySeconds = Math.max(30, Math.min(Math.round(retryAfterSeconds || 180), 3600));
    const willRetry = retryable && row.attempt_count < row.max_attempts;

    if (willRetry) {
      this.ctx.storage.sql.exec(
        `UPDATE jobs SET
           status = 'queued', stage = 'queued', updated_at = ?, available_at = ?,
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, last_error = ?
         WHERE id = ?`,
        now,
        now + delaySeconds * 1000,
        message,
        jobId,
      );
    } else {
      this.ctx.storage.sql.exec(
        `UPDATE jobs SET
           status = 'failed', stage = 'failed', updated_at = ?,
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, last_error = ?
         WHERE id = ?`,
        now,
        message,
        jobId,
      );
    }
    return {
      job: mapJob(this.ctx.storage.sql.exec<JobRow>("SELECT * FROM jobs WHERE id = ?", jobId).one()),
      willRetry,
    };
  }

  async stats(): Promise<QueueStats> {
    this.requeueExpiredLeases();
    const now = Date.now();
    const dayStart = startOfUtcDay(now);
    const counts = this.ctx.storage.sql
      .exec<{
        queued: number | null;
        working: number | null;
        completed_today: number | null;
        failed_today: number | null;
        oldest_queued_at: number | null;
      }>(
        `SELECT
          SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
          SUM(CASE WHEN status = 'leased' THEN 1 ELSE 0 END) AS working,
          SUM(CASE WHEN status = 'completed' AND completed_at >= ? THEN 1 ELSE 0 END) AS completed_today,
          SUM(CASE WHEN status = 'failed' AND updated_at >= ? THEN 1 ELSE 0 END) AS failed_today,
          MIN(CASE WHEN status = 'queued' THEN created_at ELSE NULL END) AS oldest_queued_at
         FROM jobs`,
        dayStart,
        dayStart,
      )
      .one();
    const online = this.ctx.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM agent_presence WHERE last_seen_at >= ?",
        now - ONLINE_WINDOW_MS,
      )
      .one().count;
    return {
      queued: Number(counts.queued ?? 0),
      working: Number(counts.working ?? 0),
      completedToday: Number(counts.completed_today ?? 0),
      failedToday: Number(counts.failed_today ?? 0),
      onlineAgents: Number(online ?? 0),
      ...(counts.oldest_queued_at ? { oldestQueuedAt: Number(counts.oldest_queued_at) } : {}),
    };
  }

  private findActiveLease(agentId: string, jobId: string, leaseToken: string): JobRow | null {
    const now = Date.now();
    return (
      this.ctx.storage.sql
        .exec<JobRow>(
          `SELECT * FROM jobs
           WHERE id = ? AND status = 'leased' AND lease_owner = ? AND lease_token = ?
             AND lease_expires_at > ? LIMIT 1`,
          jobId,
          agentId,
          leaseToken,
          now,
        )
        .toArray()[0] ?? null
    );
  }

  private positionFor(id: string, createdAt: number): number {
    const row = this.ctx.storage.sql
      .exec<{ position: number }>(
        `SELECT COUNT(*) AS position FROM jobs
         WHERE status = 'queued' AND (created_at < ? OR (created_at = ? AND id <= ?))`,
        createdAt,
        createdAt,
        id,
      )
      .one();
    return Math.max(1, Number(row.position ?? 1));
  }

  private requeueExpiredLeases(): void {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `UPDATE jobs SET
         status = 'failed', stage = 'failed', updated_at = ?,
         lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
         last_error = COALESCE(last_error, 'Desktop lease expired too many times')
       WHERE status = 'leased' AND lease_expires_at <= ? AND attempt_count >= max_attempts`,
      now,
      now,
    );
    this.ctx.storage.sql.exec(
      `UPDATE jobs SET
         status = 'queued', stage = 'queued', updated_at = ?, available_at = ?,
         lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
         last_error = COALESCE(last_error, 'Desktop disconnected during processing')
       WHERE status = 'leased' AND lease_expires_at <= ? AND attempt_count < max_attempts`,
      now,
      now + 60_000,
      now,
    );
  }

  private cleanup(): void {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "DELETE FROM jobs WHERE status = 'completed' AND completed_at < ?",
      now - 30 * DAY_MS,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM jobs WHERE status = 'failed' AND updated_at < ?",
      now - 90 * DAY_MS,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM agent_presence WHERE last_seen_at < ?",
      now - 7 * DAY_MS,
    );
  }
}

function mapJob(row: JobRow): QueueJobRecord {
  return {
    id: row.id,
    requestKey: row.request_key,
    url: row.url,
    requesterId: row.requester_id,
    requesterName: row.requester_name,
    sourceChatId: row.source_chat_id,
    sourceMessageId: row.source_message_id,
    statusMessageId: row.status_message_id,
    targetChatId: row.target_chat_id,
    status: row.status as QueueJobRecord["status"],
    stage: row.stage as QueueJobRecord["stage"],
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    availableAt: Number(row.available_at),
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_token ? { leaseToken: row.lease_token } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: Number(row.lease_expires_at) } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    ...(row.completed_at ? { completedAt: Number(row.completed_at) } : {}),
  };
}

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, maxLength);
}

function cleanOptional(value: unknown, maxLength: number): string | undefined {
  const cleaned = cleanText(value, maxLength);
  return cleaned || undefined;
}

function randomSecret(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomSecret(10)}`;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function startOfUtcDay(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}
