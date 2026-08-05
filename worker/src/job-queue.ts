import { DurableObject } from "cloudflare:workers";
import type {
  AgentRecord,
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

interface AgentRow {
  id: string;
  name: string;
  hostname: string | null;
  app_version: string | null;
  created_at: number;
  last_seen_at: number;
  disabled: number;
}

const PAIR_CODE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_LEASE_MS = 8 * 60 * 1000;
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
      this.ctx.storage.sql.exec(
        "CREATE INDEX IF NOT EXISTS jobs_lease_idx ON jobs(lease_expires_at)",
      );
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS agents (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          hostname TEXT,
          app_version TEXT,
          token_hash TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          disabled INTEGER NOT NULL DEFAULT 0
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS pair_codes (
          code_hash TEXT PRIMARY KEY,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          used_at INTEGER
        )
      `);
    });
  }

  async enqueue(input: QueueJobInput): Promise<{ job: QueueJobRecord; position: number; duplicate: boolean }> {
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

  async createPairCode(createdBy: string): Promise<{ code: string; expiresAt: number }> {
    const now = Date.now();
    const expiresAt = now + PAIR_CODE_TTL_MS;
    const code = randomReadableCode(10);
    const codeHash = await sha256(code);
    this.ctx.storage.sql.exec(
      "INSERT INTO pair_codes (code_hash, created_by, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, NULL)",
      codeHash,
      createdBy,
      now,
      expiresAt,
    );
    this.ctx.storage.sql.exec("DELETE FROM pair_codes WHERE expires_at < ? OR used_at IS NOT NULL", now - DAY_MS);
    return { code, expiresAt };
  }

  async pairAgent(
    code: string,
    name: string,
    hostname?: string,
    appVersion?: string,
  ): Promise<{ token: string; agent: AgentRecord } | null> {
    const now = Date.now();
    const normalized = code.trim().toUpperCase();
    const codeHash = await sha256(normalized);
    const row = this.ctx.storage.sql
      .exec<{ code_hash: string; expires_at: number; used_at: number | null }>(
        "SELECT code_hash, expires_at, used_at FROM pair_codes WHERE code_hash = ? LIMIT 1",
        codeHash,
      )
      .toArray()[0];
    if (!row || row.used_at !== null || row.expires_at <= now) return null;

    const token = randomSecret(32);
    const tokenHash = await sha256(token);
    const agentId = randomId("agent");
    const safeName = cleanText(name, 80) || "Windows computer";
    const safeHostname = cleanOptional(hostname, 120);
    const safeVersion = cleanOptional(appVersion, 40);

    this.ctx.storage.sql.exec("UPDATE pair_codes SET used_at = ? WHERE code_hash = ?", now, codeHash);
    // One active desktop is intentional: re-pairing cleanly revokes an old installation.
    this.ctx.storage.sql.exec("UPDATE agents SET disabled = 1 WHERE disabled = 0");
    this.ctx.storage.sql.exec(
      `INSERT INTO agents (
        id, name, hostname, app_version, token_hash,
        created_at, last_seen_at, disabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      agentId,
      safeName,
      safeHostname ?? null,
      safeVersion ?? null,
      tokenHash,
      now,
      now,
    );

    return {
      token,
      agent: {
        id: agentId,
        name: safeName,
        ...(safeHostname ? { hostname: safeHostname } : {}),
        ...(safeVersion ? { appVersion: safeVersion } : {}),
        createdAt: now,
        lastSeenAt: now,
        disabled: false,
      },
    };
  }

  async authenticateAgent(
    token: string,
    metadata?: { hostname?: string; appVersion?: string },
  ): Promise<AgentRecord | null> {
    if (!token) return null;
    const tokenHash = await sha256(token);
    const row = this.ctx.storage.sql
      .exec<AgentRow>(
        `SELECT id, name, hostname, app_version, created_at, last_seen_at, disabled
         FROM agents WHERE token_hash = ? LIMIT 1`,
        tokenHash,
      )
      .toArray()[0];
    if (!row || row.disabled !== 0) return null;

    const now = Date.now();
    const hostname = cleanOptional(metadata?.hostname, 120) ?? row.hostname;
    const appVersion = cleanOptional(metadata?.appVersion, 40) ?? row.app_version;
    this.ctx.storage.sql.exec(
      "UPDATE agents SET last_seen_at = ?, hostname = ?, app_version = ? WHERE id = ?",
      now,
      hostname,
      appVersion,
      row.id,
    );
    return mapAgent({ ...row, last_seen_at: now, hostname, app_version: appVersion });
  }

  leaseNext(agentId: string): LeasedJob | null {
    this.requeueExpiredLeases();
    const now = Date.now();
    const row = this.ctx.storage.sql
      .exec<JobRow>(
        `SELECT * FROM jobs
         WHERE status = 'queued'
           AND available_at <= ?
           AND attempt_count < max_attempts
         ORDER BY created_at ASC
         LIMIT 1`,
        now,
      )
      .toArray()[0];
    if (!row) return null;

    const leaseToken = randomSecret(24);
    const leaseExpiresAt = now + DEFAULT_LEASE_MS;
    this.ctx.storage.sql.exec(
      `UPDATE jobs
       SET status = 'leased', stage = 'starting', updated_at = ?,
           attempt_count = attempt_count + 1,
           lease_owner = ?, lease_token = ?, lease_expires_at = ?
       WHERE id = ?`,
      now,
      agentId,
      leaseToken,
      leaseExpiresAt,
      row.id,
    );
    const leased = this.ctx.storage.sql.exec<JobRow>("SELECT * FROM jobs WHERE id = ?", row.id).one();
    return { job: mapJob(leased), leaseToken };
  }

  heartbeat(agentId: string, jobId: string, leaseToken: string): QueueJobRecord | null {
    const row = this.findActiveLease(agentId, jobId, leaseToken);
    if (!row) return null;
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "UPDATE jobs SET updated_at = ?, lease_expires_at = ? WHERE id = ?",
      now,
      now + DEFAULT_LEASE_MS,
      jobId,
    );
    return mapJob(this.ctx.storage.sql.exec<JobRow>("SELECT * FROM jobs WHERE id = ?", jobId).one());
  }

  updateProgress(
    agentId: string,
    jobId: string,
    leaseToken: string,
    stage: QueueStage,
  ): QueueJobRecord | null {
    const allowed = new Set<QueueStage>(["starting", "downloading", "preparing", "uploading"]);
    if (!allowed.has(stage)) return null;
    const row = this.findActiveLease(agentId, jobId, leaseToken);
    if (!row) return null;
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "UPDATE jobs SET stage = ?, updated_at = ?, lease_expires_at = ? WHERE id = ?",
      stage,
      now,
      now + DEFAULT_LEASE_MS,
      jobId,
    );
    return mapJob(this.ctx.storage.sql.exec<JobRow>("SELECT * FROM jobs WHERE id = ?", jobId).one());
  }

  complete(agentId: string, jobId: string, leaseToken: string): QueueJobRecord | null {
    const row = this.findActiveLease(agentId, jobId, leaseToken);
    if (!row) return null;
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `UPDATE jobs
       SET status = 'completed', stage = 'completed', updated_at = ?, completed_at = ?,
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, last_error = NULL
       WHERE id = ?`,
      now,
      now,
      jobId,
    );
    return mapJob(this.ctx.storage.sql.exec<JobRow>("SELECT * FROM jobs WHERE id = ?", jobId).one());
  }

  fail(
    agentId: string,
    jobId: string,
    leaseToken: string,
    error: string,
    retryable: boolean,
    retryAfterSeconds: number,
  ): { job: QueueJobRecord; willRetry: boolean } | null {
    const row = this.findActiveLease(agentId, jobId, leaseToken);
    if (!row) return null;
    const now = Date.now();
    const message = cleanText(error, 1200) || "Unknown desktop error";
    const nextAttempt = Math.max(30, Math.min(retryAfterSeconds || 180, 3600));
    const willRetry = retryable && row.attempt_count < row.max_attempts;

    if (willRetry) {
      this.ctx.storage.sql.exec(
        `UPDATE jobs
         SET status = 'queued', stage = 'queued', updated_at = ?, available_at = ?,
             lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
             last_error = ?
         WHERE id = ?`,
        now,
        now + nextAttempt * 1000,
        message,
        jobId,
      );
    } else {
      this.ctx.storage.sql.exec(
        `UPDATE jobs
         SET status = 'failed', stage = 'failed', updated_at = ?,
             lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
             last_error = ?
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

  stats(): QueueStats {
    this.requeueExpiredLeases();
    const now = Date.now();
    const dayStart = startOfUtcDay(now);
    const counts = this.ctx.storage.sql
      .exec<{
        queued: number;
        working: number;
        completed_today: number;
        failed_today: number;
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
        "SELECT COUNT(*) AS count FROM agents WHERE disabled = 0 AND last_seen_at >= ?",
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

  listAgents(): AgentRecord[] {
    return this.ctx.storage.sql
      .exec<AgentRow>(
        `SELECT id, name, hostname, app_version, created_at, last_seen_at, disabled
         FROM agents ORDER BY created_at ASC`,
      )
      .toArray()
      .map(mapAgent);
  }

  setAgentDisabled(agentId: string, disabled: boolean): AgentRecord | null {
    this.ctx.storage.sql.exec(
      "UPDATE agents SET disabled = ? WHERE id = ?",
      disabled ? 1 : 0,
      agentId,
    );
    const row = this.ctx.storage.sql
      .exec<AgentRow>(
        `SELECT id, name, hostname, app_version, created_at, last_seen_at, disabled
         FROM agents WHERE id = ? LIMIT 1`,
        agentId,
      )
      .toArray()[0];
    return row ? mapAgent(row) : null;
  }

  private findActiveLease(agentId: string, jobId: string, leaseToken: string): JobRow | null {
    const now = Date.now();
    return (
      this.ctx.storage.sql
        .exec<JobRow>(
          `SELECT * FROM jobs
           WHERE id = ? AND status = 'leased' AND lease_owner = ? AND lease_token = ?
             AND lease_expires_at > ?
           LIMIT 1`,
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
      `UPDATE jobs
       SET status = 'failed', stage = 'failed', updated_at = ?,
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
           last_error = COALESCE(last_error, 'Desktop lease expired too many times')
       WHERE status = 'leased' AND lease_expires_at <= ? AND attempt_count >= max_attempts`,
      now,
      now,
    );
    this.ctx.storage.sql.exec(
      `UPDATE jobs
       SET status = 'queued', stage = 'queued', updated_at = ?, available_at = ?,
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
      "DELETE FROM jobs WHERE status IN ('failed', 'cancelled') AND updated_at < ?",
      now - 90 * DAY_MS,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM pair_codes WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < ?)",
      now - DAY_MS,
      now - DAY_MS,
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

function mapAgent(row: AgentRow): AgentRecord {
  return {
    id: row.id,
    name: row.name,
    ...(row.hostname ? { hostname: row.hostname } : {}),
    ...(row.app_version ? { appVersion: row.app_version } : {}),
    createdAt: Number(row.created_at),
    lastSeenAt: Number(row.last_seen_at),
    disabled: row.disabled !== 0,
  };
}

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, maxLength);
}

function cleanOptional(value: unknown, maxLength: number): string | undefined {
  const cleaned = cleanText(value, maxLength);
  return cleaned || undefined;
}

function randomReadableCode(length: number): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => alphabet[value % alphabet.length]).join("");
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

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

function startOfUtcDay(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}
