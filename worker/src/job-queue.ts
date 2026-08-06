import { DurableObject } from "cloudflare:workers";
import type {
  Env,
  LeasedJob,
  QueueJobInput,
  QueueJobRecord,
  QueueStage,
  QueueStats,
} from "./types";
import type {
  ReferenceCatalogItem,
  ReferenceCatalogLease,
  ReferenceDeliveryLease,
  ReferenceDiscoveredItem,
  ReferenceModelRecord,
  ReferenceNicheRecord,
  ReferenceScanLease,
  ReferenceStats,
  ReferenceUploadLease,
  ReferenceUploadTask,
} from "./reference-types";

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

interface ReferenceNicheRow {
  slug: string;
  title: string;
  thumbnail_url: string | null;
  active: number;
  catalog_present: number;
  catalog_miss_count: number;
  catalog_seen_at: number | null;
  next_scan_at: number;
  last_scan_started_at: number | null;
  last_scanned_at: number | null;
  last_scan_error: string | null;
  scan_lease_owner: string | null;
  scan_lease_token: string | null;
  scan_lease_expires_at: number | null;
  created_at: number;
}


interface ReferenceCatalogStateRow {
  id: number;
  next_sync_at: number;
  last_synced_at: number | null;
  last_sync_error: string | null;
  last_catalog_size: number;
  generation: number;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: number | null;
}

interface ReferenceModelRow {
  chat_id: string;
  name: string;
  active: number;
  created_at: number;
  updated_at: number;
}

interface ReferenceMediaRow {
  id: string;
  source_url: string;
  download_url: string | null;
  description: string | null;
  hashtags_json: string;
  niches_json: string;
  author: string | null;
  views: number | null;
  likes: number | null;
  duration: number | null;
  file_id: string | null;
  file_unique_id: string | null;
  upload_status: string;
  upload_attempt_count: number;
  upload_available_at: number;
  upload_lease_owner: string | null;
  upload_lease_token: string | null;
  upload_lease_expires_at: number | null;
  upload_error: string | null;
  created_at: number;
  updated_at: number;
  stored_at: number | null;
}

interface ReferenceDeliveryRow {
  id: string;
  model_chat_id: string;
  media_id: string;
  status: string;
  attempt_count: number;
  available_at: number;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: number | null;
  telegram_message_id: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  sent_at: number | null;
}

const LEASE_MS = 10 * 60 * 1000;
const ONLINE_WINDOW_MS = 2 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const REFERENCE_CATALOG_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REFERENCE_CATALOG_LEASE_MS = 10 * 60 * 1000;
const REFERENCE_SCAN_INTERVAL_MS = 60 * 60 * 1000;
const REFERENCE_SCAN_LEASE_MS = 20 * 60 * 1000;
const REFERENCE_UPLOAD_LEASE_MS = 20 * 60 * 1000;
const REFERENCE_DELIVERY_LEASE_MS = 5 * 60 * 1000;

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
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS reference_niches (
          slug TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          thumbnail_url TEXT,
          active INTEGER NOT NULL DEFAULT 1,
          catalog_present INTEGER NOT NULL DEFAULT 0,
          catalog_miss_count INTEGER NOT NULL DEFAULT 0,
          catalog_seen_at INTEGER,
          next_scan_at INTEGER NOT NULL DEFAULT 0,
          last_scan_started_at INTEGER,
          last_scanned_at INTEGER,
          last_scan_error TEXT,
          scan_lease_owner TEXT,
          scan_lease_token TEXT,
          scan_lease_expires_at INTEGER,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS reference_niches_due_idx
          ON reference_niches(active, next_scan_at);

        CREATE TABLE IF NOT EXISTS reference_catalog_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          next_sync_at INTEGER NOT NULL DEFAULT 0,
          last_synced_at INTEGER,
          last_sync_error TEXT,
          last_catalog_size INTEGER NOT NULL DEFAULT 0,
          generation INTEGER NOT NULL DEFAULT 0,
          lease_owner TEXT,
          lease_token TEXT,
          lease_expires_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS reference_models (
          chat_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS reference_model_niches (
          model_chat_id TEXT NOT NULL,
          niche_slug TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY(model_chat_id, niche_slug)
        );
        CREATE INDEX IF NOT EXISTS reference_model_niches_slug_idx
          ON reference_model_niches(niche_slug, model_chat_id);

        CREATE TABLE IF NOT EXISTS reference_media (
          id TEXT PRIMARY KEY,
          source_url TEXT NOT NULL,
          download_url TEXT,
          description TEXT,
          hashtags_json TEXT NOT NULL DEFAULT '[]',
          niches_json TEXT NOT NULL DEFAULT '[]',
          author TEXT,
          views INTEGER,
          likes INTEGER,
          duration INTEGER,
          file_id TEXT,
          file_unique_id TEXT,
          upload_status TEXT NOT NULL DEFAULT 'pending',
          upload_attempt_count INTEGER NOT NULL DEFAULT 0,
          upload_available_at INTEGER NOT NULL DEFAULT 0,
          upload_lease_owner TEXT,
          upload_lease_token TEXT,
          upload_lease_expires_at INTEGER,
          upload_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          stored_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS reference_media_stored_idx
          ON reference_media(stored_at, created_at);

        CREATE TABLE IF NOT EXISTS reference_media_niches (
          media_id TEXT NOT NULL,
          niche_slug TEXT NOT NULL,
          hot_rank INTEGER,
          relation_source TEXT NOT NULL DEFAULT 'hot_scan',
          first_seen_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          PRIMARY KEY(media_id, niche_slug)
        );
        CREATE INDEX IF NOT EXISTS reference_media_niches_slug_idx
          ON reference_media_niches(niche_slug, media_id);

        CREATE TABLE IF NOT EXISTS reference_deliveries (
          id TEXT PRIMARY KEY,
          model_chat_id TEXT NOT NULL,
          media_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          attempt_count INTEGER NOT NULL DEFAULT 0,
          available_at INTEGER NOT NULL,
          lease_owner TEXT,
          lease_token TEXT,
          lease_expires_at INTEGER,
          telegram_message_id TEXT,
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          sent_at INTEGER,
          UNIQUE(model_chat_id, media_id)
        );
        CREATE INDEX IF NOT EXISTS reference_deliveries_pick_idx
          ON reference_deliveries(status, available_at, created_at);
      `);

      // Safe upgrades for a Durable Object that was created by an earlier
      // References build. Duplicate-column errors simply mean the column exists.
      for (const statement of [
        "ALTER TABLE reference_media ADD COLUMN download_url TEXT",
        "ALTER TABLE reference_media ADD COLUMN upload_status TEXT NOT NULL DEFAULT 'pending'",
        "ALTER TABLE reference_media ADD COLUMN upload_attempt_count INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE reference_media ADD COLUMN upload_available_at INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE reference_media ADD COLUMN upload_lease_owner TEXT",
        "ALTER TABLE reference_media ADD COLUMN upload_lease_token TEXT",
        "ALTER TABLE reference_media ADD COLUMN upload_lease_expires_at INTEGER",
        "ALTER TABLE reference_media ADD COLUMN upload_error TEXT",
        "ALTER TABLE reference_niches ADD COLUMN thumbnail_url TEXT",
        "ALTER TABLE reference_niches ADD COLUMN catalog_present INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE reference_niches ADD COLUMN catalog_miss_count INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE reference_niches ADD COLUMN catalog_seen_at INTEGER",
        "ALTER TABLE reference_media_niches ADD COLUMN relation_source TEXT NOT NULL DEFAULT 'hot_scan'",
      ]) {
        try {
          this.ctx.storage.sql.exec(statement);
        } catch {
          // already present
        }
      }
      this.ctx.storage.sql.exec(
        "CREATE INDEX IF NOT EXISTS reference_media_upload_idx ON reference_media(upload_status, upload_available_at, created_at)",
      );

      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO reference_catalog_state
          (id, next_sync_at, last_catalog_size, generation)
         VALUES (1, 0, 0, 0)`,
      );
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
        position: existing.status === "queued"
          ? this.positionFor(existing.id, existing.created_at)
          : 0,
        duplicate: true,
      };
    }

    // A new Telegram message with the same canonical Instagram URL used to
    // create a second job and publish the same Reel twice. Deduplicate active
    // and recently completed jobs per destination. Failed jobs are excluded so
    // the user can explicitly retry them with a new message.
    const sameUrl = this.ctx.storage.sql
      .exec<JobRow>(
        `SELECT * FROM jobs
         WHERE url = ? AND target_chat_id = ?
           AND status IN ('queued', 'leased', 'completed')
         ORDER BY created_at DESC LIMIT 1`,
        input.url,
        input.targetChatId,
      )
      .toArray()[0];
    if (sameUrl) {
      return {
        job: mapJob(sameUrl),
        position: sameUrl.status === "queued"
          ? this.positionFor(sameUrl.id, sameUrl.created_at)
          : 0,
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

  async requestReferenceCatalogSync(): Promise<void> {
    this.ctx.storage.sql.exec(
      `UPDATE reference_catalog_state SET
        next_sync_at = 0, last_sync_error = NULL,
        lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
       WHERE id = 1`,
    );
  }

  async leaseReferenceCatalog(agentIdValue: string): Promise<ReferenceCatalogLease | null> {
    this.releaseExpiredReferenceLeases();
    const agentId = cleanText(agentIdValue, 80);
    const now = Date.now();
    const state = this.ctx.storage.sql
      .exec<ReferenceCatalogStateRow>(
        `SELECT * FROM reference_catalog_state
         WHERE id = 1 AND next_sync_at <= ?
           AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
        now,
        now,
      )
      .toArray()[0];
    if (!state) return null;
    const leaseToken = randomSecret(24);
    this.ctx.storage.sql.exec(
      `UPDATE reference_catalog_state SET
        lease_owner = ?, lease_token = ?, lease_expires_at = ?
       WHERE id = 1`,
      agentId,
      leaseToken,
      now + REFERENCE_CATALOG_LEASE_MS,
    );
    return { leaseToken };
  }

  async completeReferenceCatalog(
    agentIdValue: string,
    leaseTokenValue: string,
    items: ReferenceCatalogItem[],
    completeSnapshotValue: boolean,
  ): Promise<{ catalogSize: number } | null> {
    const state = this.validReferenceCatalogLease(agentIdValue, leaseTokenValue);
    if (!state) return null;

    const now = Date.now();
    const normalized = new Map<string, ReferenceCatalogItem>();
    for (const raw of items.slice(0, 2500)) {
      const slug = normalizeNicheSlug(raw.slug);
      if (!slug) continue;
      const title = cleanText(raw.title, 100) || titleFromSlug(slug);
      const thumbnailUrl = cleanOptional(raw.thumbnailUrl, 1000);
      const current = normalized.get(slug);
      if (!current || title.length > current.title.length) {
        normalized.set(slug, {
          slug,
          title,
          ...(thumbnailUrl ? { thumbnailUrl } : {}),
        });
      }
    }
    if (normalized.size === 0) throw new Error("Каталог RedGIFs пуст");

    const completeSnapshot = completeSnapshotValue && normalized.size >= 20;
    const generation = Number(state.generation ?? 0) + 1;
    for (const niche of normalized.values()) {
      this.ctx.storage.sql.exec(
        `INSERT INTO reference_niches (
          slug, title, thumbnail_url, active, catalog_present,
          catalog_miss_count, catalog_seen_at, next_scan_at, created_at
        ) VALUES (?, ?, ?, 1, 1, 0, ?, 0, ?)
        ON CONFLICT(slug) DO UPDATE SET
          title = CASE
            WHEN length(excluded.title) >= length(reference_niches.title) THEN excluded.title
            ELSE reference_niches.title END,
          thumbnail_url = COALESCE(excluded.thumbnail_url, reference_niches.thumbnail_url),
          active = 1,
          catalog_present = 1,
          catalog_miss_count = 0,
          catalog_seen_at = excluded.catalog_seen_at`,
        niche.slug,
        niche.title,
        niche.thumbnailUrl ?? null,
        now,
        now,
      );
    }

    if (completeSnapshot) {
      // Three consecutive complete catalog snapshots must miss a niche before
      // it is stopped. A transient RedGIFs rendering/API failure therefore
      // cannot wipe or deactivate the existing catalog.
      this.ctx.storage.sql.exec(
        `UPDATE reference_niches SET
          catalog_present = 0,
          catalog_miss_count = catalog_miss_count + 1,
          active = CASE WHEN catalog_miss_count + 1 >= 3 THEN 0 ELSE active END
         WHERE catalog_seen_at IS NULL OR catalog_seen_at < ?`,
        now,
      );
    }

    const activeRows = this.ctx.storage.sql
      .exec<{ slug: string }>(
        `SELECT slug FROM reference_niches
         WHERE active = 1 AND catalog_present = 1
         ORDER BY title COLLATE NOCASE ASC, slug ASC`,
      )
      .toArray();
    const spacing = activeRows.length > 0
      ? Math.max(1000, Math.floor(REFERENCE_SCAN_INTERVAL_MS / activeRows.length))
      : REFERENCE_SCAN_INTERVAL_MS;
    for (let index = 0; index < activeRows.length; index += 1) {
      const row = activeRows[index];
      if (!row) continue;
      this.ctx.storage.sql.exec(
        `UPDATE reference_niches SET next_scan_at = ?
         WHERE slug = ? AND (last_scanned_at IS NULL OR next_scan_at <= ?)`,
        now + index * spacing,
        row.slug,
        now,
      );
    }

    this.ctx.storage.sql.exec(
      `UPDATE reference_catalog_state SET
        next_sync_at = ?, last_synced_at = ?, last_sync_error = ?,
        last_catalog_size = ?, generation = ?,
        lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
       WHERE id = 1`,
      now + (completeSnapshot ? REFERENCE_CATALOG_INTERVAL_MS : 30 * 60 * 1000),
      now,
      completeSnapshot ? null : `Неполный каталог: ${normalized.size}`,
      normalized.size,
      generation,
    );
    return { catalogSize: normalized.size };
  }

  async failReferenceCatalog(
    agentIdValue: string,
    leaseTokenValue: string,
    errorValue: string,
  ): Promise<boolean> {
    if (!this.validReferenceCatalogLease(agentIdValue, leaseTokenValue)) return false;
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `UPDATE reference_catalog_state SET
        next_sync_at = ?, last_sync_error = ?,
        lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
       WHERE id = 1`,
      now + 15 * 60 * 1000,
      cleanText(errorValue, 1200),
    );
    return true;
  }

  async registerReferenceNiche(slugValue: string, titleValue: string): Promise<ReferenceNicheRecord> {
    const slug = normalizeNicheSlug(slugValue);
    if (!slug) throw new Error("Некорректная ниша RedGIFs");
    const title = cleanText(titleValue, 80) || titleFromSlug(slug);
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO reference_niches (slug, title, active, catalog_present, catalog_seen_at, next_scan_at, created_at)
       VALUES (?, ?, 1, 1, ?, 0, ?)
       ON CONFLICT(slug) DO UPDATE SET
         title = excluded.title, active = 1, catalog_present = 1, catalog_seen_at = excluded.catalog_seen_at`,
      slug,
      title,
      now,
      now,
    );
    return this.referenceNiche(slug);
  }

  async setReferenceNicheActive(slugValue: string, active: boolean): Promise<ReferenceNicheRecord> {
    const slug = normalizeNicheSlug(slugValue);
    if (!slug) throw new Error("Некорректная ниша RedGIFs");
    this.ctx.storage.sql.exec(
      `UPDATE reference_niches SET active = ?, next_scan_at = CASE WHEN ? = 1 THEN 0 ELSE next_scan_at END
       WHERE slug = ?`,
      active ? 1 : 0,
      active ? 1 : 0,
      slug,
    );
    return this.referenceNiche(slug);
  }

  async listReferenceNiches(): Promise<ReferenceNicheRecord[]> {
    return this.ctx.storage.sql
      .exec<ReferenceNicheRow & { model_count: number; media_count: number }>(
        `SELECT n.*,
          (SELECT COUNT(*) FROM reference_model_niches mn WHERE mn.niche_slug = n.slug) AS model_count,
          (SELECT COUNT(*) FROM reference_media_niches rm WHERE rm.niche_slug = n.slug) AS media_count
         FROM reference_niches n
         WHERE n.catalog_present = 1 OR EXISTS (
           SELECT 1 FROM reference_model_niches selected WHERE selected.niche_slug = n.slug
         )
         ORDER BY n.title COLLATE NOCASE ASC, n.slug ASC`,
      )
      .toArray()
      .map(mapReferenceNiche);
  }

  async registerReferenceModel(chatIdValue: string, nameValue: string): Promise<ReferenceModelRecord> {
    const chatId = cleanText(chatIdValue, 40);
    if (!/^-?\d+$/u.test(chatId)) throw new Error("Некорректный Telegram chat id");
    const name = cleanText(nameValue, 100) || `Модель ${chatId}`;
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO reference_models (chat_id, name, active, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET name = excluded.name, active = 1, updated_at = excluded.updated_at`,
      chatId,
      name,
      now,
      now,
    );
    return this.referenceModel(chatId);
  }

  async removeReferenceModel(chatIdValue: string): Promise<void> {
    const chatId = cleanText(chatIdValue, 40);
    this.ctx.storage.sql.exec("DELETE FROM reference_model_niches WHERE model_chat_id = ?", chatId);
    this.ctx.storage.sql.exec("DELETE FROM reference_deliveries WHERE model_chat_id = ? AND status != 'sent'", chatId);
    this.ctx.storage.sql.exec("DELETE FROM reference_models WHERE chat_id = ?", chatId);
  }

  async listReferenceModels(): Promise<ReferenceModelRecord[]> {
    const rows = this.ctx.storage.sql
      .exec<ReferenceModelRow & { niche_count: number; delivery_count: number }>(
        `SELECT m.*,
          (SELECT COUNT(*) FROM reference_model_niches mn WHERE mn.model_chat_id = m.chat_id) AS niche_count,
          (SELECT COUNT(*) FROM reference_deliveries d WHERE d.model_chat_id = m.chat_id AND d.status = 'sent') AS delivery_count
         FROM reference_models m
         ORDER BY m.active DESC, m.name COLLATE NOCASE ASC`,
      )
      .toArray();
    return rows.map((row) => ({
      chatId: row.chat_id,
      name: row.name,
      active: row.active === 1,
      nicheCount: Number(row.niche_count ?? 0),
      deliveryCount: Number(row.delivery_count ?? 0),
      niches: this.ctx.storage.sql
        .exec<{ niche_slug: string }>(
          "SELECT niche_slug FROM reference_model_niches WHERE model_chat_id = ? ORDER BY niche_slug",
          row.chat_id,
        )
        .toArray()
        .map((item) => item.niche_slug),
    }));
  }

  async toggleReferenceModelNiche(
    chatIdValue: string,
    slugValue: string,
  ): Promise<{ enabled: boolean; queued: number }> {
    const chatId = cleanText(chatIdValue, 40);
    const slug = normalizeNicheSlug(slugValue);
    if (!slug) throw new Error("Некорректная ниша RedGIFs");
    const model = this.ctx.storage.sql
      .exec<ReferenceModelRow>("SELECT * FROM reference_models WHERE chat_id = ?", chatId)
      .toArray()[0];
    if (!model) throw new Error("Модель не найдена");
    const exists = this.ctx.storage.sql
      .exec<{ value: number }>(
        "SELECT 1 AS value FROM reference_model_niches WHERE model_chat_id = ? AND niche_slug = ?",
        chatId,
        slug,
      )
      .toArray()[0];
    const now = Date.now();
    if (exists) {
      this.ctx.storage.sql.exec(
        "DELETE FROM reference_model_niches WHERE model_chat_id = ? AND niche_slug = ?",
        chatId,
        slug,
      );
      this.ctx.storage.sql.exec(
        `DELETE FROM reference_deliveries
         WHERE model_chat_id = ? AND status = 'pending'
           AND NOT EXISTS (
             SELECT 1 FROM reference_media_niches rm
             JOIN reference_model_niches mn ON mn.niche_slug = rm.niche_slug
             WHERE rm.media_id = reference_deliveries.media_id
               AND mn.model_chat_id = reference_deliveries.model_chat_id
           )`,
        chatId,
      );
      return { enabled: false, queued: 0 };
    }

    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO reference_model_niches (model_chat_id, niche_slug, created_at)
       VALUES (?, ?, ?)`,
      chatId,
      slug,
      now,
    );
    const before = this.pendingReferenceDeliveries(chatId);
    this.queueReferenceBackfill(chatId, slug, now);
    const after = this.pendingReferenceDeliveries(chatId);
    return { enabled: true, queued: Math.max(0, after - before) };
  }

  async referenceStats(): Promise<ReferenceStats> {
    this.releaseExpiredReferenceLeases();
    const now = Date.now();
    const row = this.ctx.storage.sql
      .exec<{
        models: number;
        active_niches: number;
        catalog_niches: number;
        stored_media: number;
        pending_uploads: number;
        pending_deliveries: number;
        sent_deliveries: number;
      }>(
        `SELECT
          (SELECT COUNT(*) FROM reference_models WHERE active = 1) AS models,
          (SELECT COUNT(*) FROM reference_niches WHERE active = 1 AND catalog_present = 1) AS active_niches,
          (SELECT COUNT(*) FROM reference_niches WHERE catalog_present = 1) AS catalog_niches,
          (SELECT COUNT(*) FROM reference_media WHERE file_id IS NOT NULL) AS stored_media,
          (SELECT COUNT(*) FROM reference_media WHERE file_id IS NULL AND upload_status IN ('pending', 'leased')) AS pending_uploads,
          (SELECT COUNT(*) FROM reference_deliveries WHERE status IN ('pending', 'leased')) AS pending_deliveries,
          (SELECT COUNT(*) FROM reference_deliveries WHERE status = 'sent') AS sent_deliveries`,
      )
      .one();
    const catalog = this.ctx.storage.sql
      .exec<ReferenceCatalogStateRow>("SELECT * FROM reference_catalog_state WHERE id = 1")
      .one();
    const catalogPending = Number(catalog.next_sync_at ?? 0) <= now || (
      catalog.lease_expires_at !== null && Number(catalog.lease_expires_at) > now
    );
    return {
      models: Number(row.models ?? 0),
      activeNiches: Number(row.active_niches ?? 0),
      catalogNiches: Number(row.catalog_niches ?? 0),
      catalogPending,
      ...(catalog.last_synced_at !== null ? { catalogSyncedAt: Number(catalog.last_synced_at) } : {}),
      ...(catalog.last_sync_error ? { catalogError: catalog.last_sync_error } : {}),
      storedMedia: Number(row.stored_media ?? 0),
      pendingUploads: Number(row.pending_uploads ?? 0),
      pendingDeliveries: Number(row.pending_deliveries ?? 0),
      sentDeliveries: Number(row.sent_deliveries ?? 0),
    };
  }

  async leaseReferenceScan(agentIdValue: string): Promise<ReferenceScanLease | null> {
    this.releaseExpiredReferenceLeases();
    const agentId = cleanText(agentIdValue, 80);
    const now = Date.now();
    const row = this.ctx.storage.sql
      .exec<ReferenceNicheRow>(
        `SELECT * FROM reference_niches
         WHERE active = 1 AND catalog_present = 1 AND next_scan_at <= ?
           AND (scan_lease_expires_at IS NULL OR scan_lease_expires_at <= ?)
         ORDER BY next_scan_at ASC, title COLLATE NOCASE ASC LIMIT 1`,
        now,
        now,
      )
      .toArray()[0];
    if (!row) return null;
    const token = randomSecret(24);
    this.ctx.storage.sql.exec(
      `UPDATE reference_niches SET
        scan_lease_owner = ?, scan_lease_token = ?, scan_lease_expires_at = ?,
        last_scan_started_at = ?, next_scan_at = ?
       WHERE slug = ?`,
      agentId,
      token,
      now + REFERENCE_SCAN_LEASE_MS,
      now,
      now + REFERENCE_SCAN_LEASE_MS,
      row.slug,
    );
    return { slug: row.slug, title: row.title, leaseToken: token };
  }

  async completeReferenceScan(
    agentIdValue: string,
    slugValue: string,
    leaseTokenValue: string,
  ): Promise<boolean> {
    if (!this.validReferenceScanLease(agentIdValue, slugValue, leaseTokenValue)) return false;
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `UPDATE reference_niches SET
        last_scanned_at = ?, last_scan_error = NULL, next_scan_at = ?,
        scan_lease_owner = NULL, scan_lease_token = NULL, scan_lease_expires_at = NULL
       WHERE slug = ?`,
      now,
      now + REFERENCE_SCAN_INTERVAL_MS,
      normalizeNicheSlug(slugValue),
    );
    return true;
  }

  async failReferenceScan(
    agentIdValue: string,
    slugValue: string,
    leaseTokenValue: string,
    errorValue: string,
  ): Promise<boolean> {
    if (!this.validReferenceScanLease(agentIdValue, slugValue, leaseTokenValue)) return false;
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `UPDATE reference_niches SET
        last_scan_error = ?, next_scan_at = ?,
        scan_lease_owner = NULL, scan_lease_token = NULL, scan_lease_expires_at = NULL
       WHERE slug = ?`,
      cleanText(errorValue, 1000),
      now + 10 * 60 * 1000,
      normalizeNicheSlug(slugValue),
    );
    return true;
  }

  async discoverReferenceItems(
    nicheSlugValue: string,
    items: ReferenceDiscoveredItem[],
  ): Promise<ReferenceUploadTask[]> {
    const nicheSlug = normalizeNicheSlug(nicheSlugValue);
    if (!nicheSlug) throw new Error("Некорректная ниша RedGIFs");
    const now = Date.now();
    const uploadTasks = new Map<string, ReferenceUploadTask>();

    for (const raw of items.slice(0, 10)) {
      const id = normalizeMediaId(raw.id);
      if (!id) continue;
      const sourceUrl = cleanText(raw.sourceUrl, 500) || `https://www.redgifs.com/watch/${id}`;
      const downloadUrl = cleanOptional(raw.downloadUrl, 1200) ?? null;
      const description = cleanOptional(raw.description, 3000) ?? null;
      const hashtags = normalizeStringArray(raw.hashtags, 80, 80);
      const metadataNiches = normalizeMediaNiches(raw.niches);
      const scannedTitle = this.ctx.storage.sql
        .exec<{ title: string }>("SELECT title FROM reference_niches WHERE slug = ?", nicheSlug)
        .toArray()[0]?.title ?? titleFromSlug(nicheSlug);
      const author = cleanOptional(raw.author, 120) ?? null;
      const views = optionalNonNegativeInteger(raw.views);
      const likes = optionalNonNegativeInteger(raw.likes);
      const duration = optionalNonNegativeInteger(raw.duration);
      const hotRank = optionalPositiveInteger(raw.hotRank);

      this.ctx.storage.sql.exec(
        `INSERT INTO reference_media (
          id, source_url, download_url, description, hashtags_json, niches_json, author,
          views, likes, duration, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          source_url = excluded.source_url,
          download_url = COALESCE(excluded.download_url, reference_media.download_url),
          description = COALESCE(excluded.description, reference_media.description),
          hashtags_json = CASE WHEN excluded.hashtags_json != '[]' THEN excluded.hashtags_json ELSE reference_media.hashtags_json END,
          author = COALESCE(excluded.author, reference_media.author),
          views = COALESCE(excluded.views, reference_media.views),
          likes = COALESCE(excluded.likes, reference_media.likes),
          duration = COALESCE(excluded.duration, reference_media.duration),
          upload_status = CASE
            WHEN reference_media.file_id IS NULL AND reference_media.upload_status = 'failed' THEN 'pending'
            ELSE reference_media.upload_status END,
          upload_attempt_count = CASE
            WHEN reference_media.file_id IS NULL AND reference_media.upload_status = 'failed' THEN 0
            ELSE reference_media.upload_attempt_count END,
          upload_available_at = CASE
            WHEN reference_media.file_id IS NULL AND reference_media.upload_status = 'failed' THEN excluded.updated_at
            ELSE reference_media.upload_available_at END,
          updated_at = excluded.updated_at`,
        id,
        sourceUrl,
        downloadUrl,
        description,
        JSON.stringify(hashtags),
        author,
        views,
        likes,
        duration,
        now,
        now,
      );

      // The page where the video was found is authoritative HOT membership.
      this.upsertReferenceNicheRelation(
        id,
        { slug: nicheSlug, title: scannedTitle },
        "hot_scan",
        hotRank,
        now,
      );
      // A RedGIFs card/single-item response can list additional niches. They
      // enrich matching, but do not make an unknown niche scan-active until it
      // is also present in the global /niches catalog.
      for (const niche of metadataNiches) {
        this.upsertReferenceNicheRelation(
          id,
          niche,
          niche.slug === nicheSlug ? "both" : "media_metadata",
          niche.slug === nicheSlug ? hotRank : null,
          now,
        );
      }
      this.refreshReferenceNichesJson(id);

      const row = this.ctx.storage.sql
        .exec<{ file_id: string | null }>("SELECT file_id FROM reference_media WHERE id = ?", id)
        .one();
      if (!row.file_id) {
        uploadTasks.set(id, this.referenceUploadTask(id));
      } else {
        this.queueReferenceDeliveriesForMedia(id, now);
      }
    }

    return Array.from(uploadTasks.values());
  }

  async enrichReferenceItem(
    mediaIdValue: string,
    raw: ReferenceDiscoveredItem,
  ): Promise<ReferenceUploadTask | null> {
    const id = normalizeMediaId(mediaIdValue || raw.id);
    if (!id) throw new Error("Некорректный RedGIFs ID");
    const existing = this.ctx.storage.sql
      .exec<ReferenceMediaRow>("SELECT * FROM reference_media WHERE id = ?", id)
      .toArray()[0];
    if (!existing) return null;

    const now = Date.now();
    const sourceUrl = cleanOptional(raw.sourceUrl, 500) ?? existing.source_url;
    const downloadUrl = cleanOptional(raw.downloadUrl, 1200) ?? null;
    const description = cleanOptional(raw.description, 3000) ?? null;
    const hashtags = normalizeStringArray(raw.hashtags, 80, 80);
    const author = cleanOptional(raw.author, 120) ?? null;
    const views = optionalNonNegativeInteger(raw.views);
    const likes = optionalNonNegativeInteger(raw.likes);
    const duration = optionalNonNegativeInteger(raw.duration);

    this.ctx.storage.sql.exec(
      `UPDATE reference_media SET
        source_url = ?,
        download_url = COALESCE(?, download_url),
        description = COALESCE(?, description),
        hashtags_json = CASE WHEN ? != '[]' THEN ? ELSE hashtags_json END,
        author = COALESCE(?, author),
        views = COALESCE(?, views), likes = COALESCE(?, likes), duration = COALESCE(?, duration),
        updated_at = ?
       WHERE id = ?`,
      sourceUrl,
      downloadUrl,
      description,
      JSON.stringify(hashtags),
      JSON.stringify(hashtags),
      author,
      views,
      likes,
      duration,
      now,
      id,
    );

    for (const niche of normalizeMediaNiches(raw.niches)) {
      this.upsertReferenceNicheRelation(id, niche, "media_metadata", null, now);
    }
    this.refreshReferenceNichesJson(id);
    if (existing.file_id) this.queueReferenceDeliveriesForMedia(id, now);
    return this.referenceUploadTask(id);
  }

  async leaseReferenceUpload(agentIdValue: string): Promise<ReferenceUploadLease | null> {
    this.releaseExpiredReferenceLeases();
    const agentId = cleanText(agentIdValue, 80);
    const now = Date.now();
    const row = this.ctx.storage.sql
      .exec<ReferenceMediaRow>(
        `SELECT * FROM reference_media
         WHERE file_id IS NULL AND upload_status = 'pending'
           AND upload_available_at <= ? AND upload_attempt_count < 7
         ORDER BY created_at ASC, id ASC LIMIT 1`,
        now,
      )
      .toArray()[0];
    if (!row) return null;

    const leaseToken = randomSecret(24);
    this.ctx.storage.sql.exec(
      `UPDATE reference_media SET
        upload_status = 'leased', upload_attempt_count = upload_attempt_count + 1,
        upload_lease_owner = ?, upload_lease_token = ?, upload_lease_expires_at = ?,
        updated_at = ?
       WHERE id = ? AND file_id IS NULL AND upload_status = 'pending'`,
      agentId,
      leaseToken,
      now + REFERENCE_UPLOAD_LEASE_MS,
      now,
      row.id,
    );
    const leased = this.ctx.storage.sql
      .exec<ReferenceMediaRow>("SELECT * FROM reference_media WHERE id = ?", row.id)
      .one();
    if (leased.upload_status !== "leased" || leased.upload_lease_token !== leaseToken) return null;
    return { ...this.referenceUploadTask(leased.id), leaseToken };
  }

  async completeReferenceUpload(
    agentIdValue: string,
    mediaIdValue: string,
    leaseTokenValue: string,
    fileIdValue: string,
    fileUniqueIdValue?: string,
  ): Promise<{ queuedDeliveries: number } | null> {
    const row = this.validReferenceUploadLease(agentIdValue, mediaIdValue, leaseTokenValue);
    if (!row) return null;
    return this.storeReferenceMedia(row.id, fileIdValue, fileUniqueIdValue);
  }

  async failReferenceUpload(
    agentIdValue: string,
    mediaIdValue: string,
    leaseTokenValue: string,
    errorValue: string,
    retryAfterSecondsValue = 300,
  ): Promise<boolean> {
    const row = this.validReferenceUploadLease(agentIdValue, mediaIdValue, leaseTokenValue);
    if (!row) return false;
    const now = Date.now();
    const retry = row.upload_attempt_count < 7;
    const delay = Math.max(60, Math.min(3600, Math.round(retryAfterSecondsValue || 300)));
    this.ctx.storage.sql.exec(
      `UPDATE reference_media SET
        upload_status = ?, upload_available_at = ?, upload_error = ?, updated_at = ?,
        upload_lease_owner = NULL, upload_lease_token = NULL, upload_lease_expires_at = NULL
       WHERE id = ?`,
      retry ? "pending" : "failed",
      retry ? now + delay * 1000 : now,
      cleanText(errorValue, 1000),
      now,
      row.id,
    );
    return true;
  }

  async storeReferenceMedia(
    mediaIdValue: string,
    fileIdValue: string,
    fileUniqueIdValue?: string,
  ): Promise<{ queuedDeliveries: number }> {
    const mediaId = normalizeMediaId(mediaIdValue);
    const fileId = cleanText(fileIdValue, 500);
    if (!mediaId || !fileId) throw new Error("Некорректные данные Telegram-файла");
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `UPDATE reference_media SET
        file_id = ?, file_unique_id = ?, stored_at = ?, updated_at = ?,
        upload_status = 'stored', upload_error = NULL,
        upload_lease_owner = NULL, upload_lease_token = NULL, upload_lease_expires_at = NULL
       WHERE id = ?`,
      fileId,
      cleanOptional(fileUniqueIdValue, 500) ?? null,
      now,
      now,
      mediaId,
    );
    return { queuedDeliveries: this.queueReferenceDeliveriesForMedia(mediaId, now) };
  }

  async leaseReferenceDelivery(agentIdValue: string): Promise<ReferenceDeliveryLease | null> {
    this.releaseExpiredReferenceLeases();
    const agentId = cleanText(agentIdValue, 80);
    const now = Date.now();
    const row = this.ctx.storage.sql
      .exec<ReferenceDeliveryRow>(
        `SELECT d.* FROM reference_deliveries d
         JOIN reference_media r ON r.id = d.media_id
         JOIN reference_models m ON m.chat_id = d.model_chat_id
         WHERE d.status = 'pending' AND d.available_at <= ?
           AND d.attempt_count < 7 AND r.file_id IS NOT NULL AND m.active = 1
         ORDER BY d.created_at ASC, d.id ASC LIMIT 1`,
        now,
      )
      .toArray()[0];
    if (!row) return null;
    const leaseToken = randomSecret(24);
    this.ctx.storage.sql.exec(
      `UPDATE reference_deliveries SET
        status = 'leased', attempt_count = attempt_count + 1,
        lease_owner = ?, lease_token = ?, lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
      agentId,
      leaseToken,
      now + REFERENCE_DELIVERY_LEASE_MS,
      now,
      row.id,
    );
    const leased = this.ctx.storage.sql
      .exec<ReferenceDeliveryRow>("SELECT * FROM reference_deliveries WHERE id = ?", row.id)
      .one();
    if (leased.status !== "leased") return null;
    const media = this.ctx.storage.sql
      .exec<ReferenceMediaRow>("SELECT * FROM reference_media WHERE id = ?", leased.media_id)
      .one();
    const model = this.ctx.storage.sql
      .exec<ReferenceModelRow>("SELECT * FROM reference_models WHERE chat_id = ?", leased.model_chat_id)
      .one();
    if (!media.file_id) return null;
    return {
      id: leased.id,
      leaseToken,
      modelChatId: leased.model_chat_id,
      modelName: model.name,
      mediaId: media.id,
      fileId: media.file_id,
      sourceUrl: media.source_url,
      ...(media.description ? { description: media.description } : {}),
      hashtags: parseStringArray(media.hashtags_json),
      niches: parseNiches(media.niches_json),
      ...(media.views !== null ? { views: Number(media.views) } : {}),
      ...(media.likes !== null ? { likes: Number(media.likes) } : {}),
      ...(media.duration !== null ? { duration: Number(media.duration) } : {}),
    };
  }

  async completeReferenceDelivery(
    agentIdValue: string,
    deliveryIdValue: string,
    leaseTokenValue: string,
    telegramMessageIdValue: string,
  ): Promise<boolean> {
    const row = this.validReferenceDeliveryLease(agentIdValue, deliveryIdValue, leaseTokenValue);
    if (!row) return false;
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `UPDATE reference_deliveries SET
        status = 'sent', sent_at = ?, updated_at = ?, telegram_message_id = ?, error = NULL,
        lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
       WHERE id = ?`,
      now,
      now,
      cleanText(telegramMessageIdValue, 80),
      row.id,
    );
    return true;
  }

  async failReferenceDelivery(
    agentIdValue: string,
    deliveryIdValue: string,
    leaseTokenValue: string,
    errorValue: string,
    retryAfterSecondsValue = 120,
  ): Promise<boolean> {
    const row = this.validReferenceDeliveryLease(agentIdValue, deliveryIdValue, leaseTokenValue);
    if (!row) return false;
    const now = Date.now();
    const retry = row.attempt_count < 7;
    const delay = Math.max(30, Math.min(3600, Math.round(retryAfterSecondsValue || 120)));
    this.ctx.storage.sql.exec(
      `UPDATE reference_deliveries SET
        status = ?, available_at = ?, updated_at = ?, error = ?,
        lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
       WHERE id = ?`,
      retry ? "pending" : "failed",
      retry ? now + delay * 1000 : now,
      now,
      cleanText(errorValue, 1000),
      row.id,
    );
    return true;
  }

  private referenceNiche(slug: string): ReferenceNicheRecord {
    const row = this.ctx.storage.sql
      .exec<ReferenceNicheRow & { model_count: number; media_count: number }>(
        `SELECT n.*,
          (SELECT COUNT(*) FROM reference_model_niches mn WHERE mn.niche_slug = n.slug) AS model_count,
          (SELECT COUNT(*) FROM reference_media_niches rm WHERE rm.niche_slug = n.slug) AS media_count
         FROM reference_niches n WHERE n.slug = ?`,
        slug,
      )
      .one();
    return mapReferenceNiche(row);
  }

  private referenceModel(chatId: string): ReferenceModelRecord {
    const row = this.ctx.storage.sql
      .exec<ReferenceModelRow & { niche_count: number; delivery_count: number }>(
        `SELECT m.*,
          (SELECT COUNT(*) FROM reference_model_niches mn WHERE mn.model_chat_id = m.chat_id) AS niche_count,
          (SELECT COUNT(*) FROM reference_deliveries d WHERE d.model_chat_id = m.chat_id AND d.status = 'sent') AS delivery_count
         FROM reference_models m WHERE m.chat_id = ?`,
        chatId,
      )
      .one();
    return {
      chatId: row.chat_id,
      name: row.name,
      active: row.active === 1,
      nicheCount: Number(row.niche_count ?? 0),
      deliveryCount: Number(row.delivery_count ?? 0),
      niches: this.ctx.storage.sql
        .exec<{ niche_slug: string }>(
          "SELECT niche_slug FROM reference_model_niches WHERE model_chat_id = ? ORDER BY niche_slug",
          chatId,
        )
        .toArray()
        .map((item) => item.niche_slug),
    };
  }

  private referenceUploadTask(id: string): ReferenceUploadTask {
    const row = this.ctx.storage.sql
      .exec<ReferenceMediaRow>("SELECT * FROM reference_media WHERE id = ?", id)
      .one();
    return {
      id: row.id,
      sourceUrl: row.source_url,
      ...(row.download_url ? { downloadUrl: row.download_url } : {}),
      ...(row.description ? { description: row.description } : {}),
      hashtags: parseStringArray(row.hashtags_json),
      niches: parseNiches(row.niches_json),
      ...(row.author ? { author: row.author } : {}),
      ...(row.views !== null ? { views: Number(row.views) } : {}),
      ...(row.likes !== null ? { likes: Number(row.likes) } : {}),
      ...(row.duration !== null ? { duration: Number(row.duration) } : {}),
    };
  }

  private queueReferenceDeliveriesForMedia(mediaId: string, now: number): number {
    const before = this.totalPendingReferenceDeliveries();
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO reference_deliveries (
        id, model_chat_id, media_id, status, attempt_count, available_at, created_at, updated_at
      )
      SELECT
        'refd_' || hex(randomblob(12)), m.chat_id, ?, 'pending', 0, ?, ?, ?
      FROM reference_models m
      WHERE m.active = 1 AND EXISTS (
        SELECT 1 FROM reference_model_niches mn
        JOIN reference_media_niches rm ON rm.niche_slug = mn.niche_slug
        WHERE mn.model_chat_id = m.chat_id AND rm.media_id = ?
      )`,
      mediaId,
      now,
      now,
      now,
      mediaId,
    );
    return Math.max(0, this.totalPendingReferenceDeliveries() - before);
  }

  private queueReferenceBackfill(chatId: string, slug: string, now: number): void {
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO reference_deliveries (
        id, model_chat_id, media_id, status, attempt_count, available_at, created_at, updated_at
      )
      SELECT 'refd_' || hex(randomblob(12)), ?, r.id, 'pending', 0, ?, ?, ?
      FROM reference_media r
      JOIN reference_media_niches rm ON rm.media_id = r.id
      WHERE rm.niche_slug = ? AND r.file_id IS NOT NULL`,
      chatId,
      now,
      now,
      now,
      slug,
    );
  }

  private pendingReferenceDeliveries(chatId: string): number {
    return Number(
      this.ctx.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM reference_deliveries WHERE model_chat_id = ? AND status IN ('pending', 'leased')",
          chatId,
        )
        .one().count ?? 0,
    );
  }

  private totalPendingReferenceDeliveries(): number {
    return Number(
      this.ctx.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM reference_deliveries WHERE status IN ('pending', 'leased')",
        )
        .one().count ?? 0,
    );
  }

  private validReferenceCatalogLease(
    agentIdValue: string,
    tokenValue: string,
  ): ReferenceCatalogStateRow | null {
    const now = Date.now();
    return this.ctx.storage.sql
      .exec<ReferenceCatalogStateRow>(
        `SELECT * FROM reference_catalog_state
         WHERE id = 1 AND lease_owner = ? AND lease_token = ?
           AND lease_expires_at > ? LIMIT 1`,
        cleanText(agentIdValue, 80),
        cleanText(tokenValue, 160),
        now,
      )
      .toArray()[0] ?? null;
  }

  private upsertReferenceNicheRelation(
    mediaId: string,
    niche: { slug: string; title: string; thumbnailUrl?: string },
    source: "hot_scan" | "media_metadata" | "both",
    hotRank: number | null,
    now: number,
  ): void {
    const slug = normalizeNicheSlug(niche.slug);
    if (!slug) return;
    const title = cleanText(niche.title, 100) || titleFromSlug(slug);
    const thumbnailUrl = cleanOptional(niche.thumbnailUrl, 1000) ?? null;
    this.ctx.storage.sql.exec(
      `INSERT INTO reference_niches (
        slug, title, thumbnail_url, active, catalog_present, next_scan_at, created_at
      ) VALUES (?, ?, ?, 0, 0, 0, ?)
      ON CONFLICT(slug) DO UPDATE SET
        title = CASE
          WHEN length(excluded.title) >= length(reference_niches.title) THEN excluded.title
          ELSE reference_niches.title END,
        thumbnail_url = COALESCE(excluded.thumbnail_url, reference_niches.thumbnail_url)`,
      slug,
      title,
      thumbnailUrl,
      now,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO reference_media_niches (
        media_id, niche_slug, hot_rank, relation_source, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(media_id, niche_slug) DO UPDATE SET
        hot_rank = COALESCE(excluded.hot_rank, reference_media_niches.hot_rank),
        relation_source = CASE
          WHEN reference_media_niches.relation_source = excluded.relation_source
            THEN reference_media_niches.relation_source
          WHEN reference_media_niches.relation_source = 'both' OR excluded.relation_source = 'both'
            THEN 'both'
          ELSE 'both' END,
        last_seen_at = excluded.last_seen_at`,
      mediaId,
      slug,
      hotRank,
      source,
      now,
      now,
    );
  }

  private refreshReferenceNichesJson(mediaId: string): void {
    const niches = this.ctx.storage.sql
      .exec<{ slug: string; title: string; thumbnail_url: string | null }>(
        `SELECT n.slug, n.title, n.thumbnail_url
         FROM reference_media_niches rm
         JOIN reference_niches n ON n.slug = rm.niche_slug
         WHERE rm.media_id = ?
         ORDER BY n.title COLLATE NOCASE ASC, n.slug ASC`,
        mediaId,
      )
      .toArray()
      .map((row) => ({
        slug: row.slug,
        title: row.title,
        ...(row.thumbnail_url ? { thumbnailUrl: row.thumbnail_url } : {}),
      }));
    this.ctx.storage.sql.exec(
      "UPDATE reference_media SET niches_json = ?, updated_at = ? WHERE id = ?",
      JSON.stringify(niches),
      Date.now(),
      mediaId,
    );
  }

  private validReferenceScanLease(agentIdValue: string, slugValue: string, tokenValue: string): boolean {
    const now = Date.now();
    const slug = normalizeNicheSlug(slugValue);
    const row = this.ctx.storage.sql
      .exec<{ value: number }>(
        `SELECT 1 AS value FROM reference_niches
         WHERE slug = ? AND scan_lease_owner = ? AND scan_lease_token = ?
           AND scan_lease_expires_at > ?`,
        slug,
        cleanText(agentIdValue, 80),
        cleanText(tokenValue, 160),
        now,
      )
      .toArray()[0];
    return Boolean(row);
  }

  private validReferenceUploadLease(
    agentIdValue: string,
    mediaIdValue: string,
    tokenValue: string,
  ): ReferenceMediaRow | null {
    const now = Date.now();
    return this.ctx.storage.sql
      .exec<ReferenceMediaRow>(
        `SELECT * FROM reference_media
         WHERE id = ? AND file_id IS NULL AND upload_status = 'leased'
           AND upload_lease_owner = ? AND upload_lease_token = ?
           AND upload_lease_expires_at > ? LIMIT 1`,
        normalizeMediaId(mediaIdValue),
        cleanText(agentIdValue, 80),
        cleanText(tokenValue, 160),
        now,
      )
      .toArray()[0] ?? null;
  }

  private validReferenceDeliveryLease(
    agentIdValue: string,
    deliveryIdValue: string,
    tokenValue: string,
  ): ReferenceDeliveryRow | null {
    const now = Date.now();
    return this.ctx.storage.sql
      .exec<ReferenceDeliveryRow>(
        `SELECT * FROM reference_deliveries
         WHERE id = ? AND status = 'leased' AND lease_owner = ? AND lease_token = ?
           AND lease_expires_at > ? LIMIT 1`,
        cleanText(deliveryIdValue, 120),
        cleanText(agentIdValue, 80),
        cleanText(tokenValue, 160),
        now,
      )
      .toArray()[0] ?? null;
  }

  private releaseExpiredReferenceLeases(): void {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `UPDATE reference_catalog_state SET
        next_sync_at = ?, last_sync_error = COALESCE(last_sync_error, 'Desktop disconnected during catalog sync'),
        lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
       WHERE lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
      now,
      now,
    );
    this.ctx.storage.sql.exec(
      `UPDATE reference_niches SET
        scan_lease_owner = NULL, scan_lease_token = NULL, scan_lease_expires_at = NULL,
        next_scan_at = ?
       WHERE scan_lease_expires_at IS NOT NULL AND scan_lease_expires_at <= ?`,
      now,
      now,
    );
    this.ctx.storage.sql.exec(
      `UPDATE reference_media SET
        upload_status = CASE WHEN upload_attempt_count < 7 THEN 'pending' ELSE 'failed' END,
        upload_available_at = ?, updated_at = ?,
        upload_lease_owner = NULL, upload_lease_token = NULL, upload_lease_expires_at = NULL,
        upload_error = COALESCE(upload_error, 'Desktop disconnected during reference upload')
       WHERE file_id IS NULL AND upload_status = 'leased' AND upload_lease_expires_at <= ?`,
      now + 60_000,
      now,
      now,
    );
    this.ctx.storage.sql.exec(
      `UPDATE reference_deliveries SET
        status = CASE WHEN attempt_count < 7 THEN 'pending' ELSE 'failed' END,
        available_at = ?, updated_at = ?,
        lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
        error = COALESCE(error, 'Desktop disconnected during reference delivery')
       WHERE status = 'leased' AND lease_expires_at <= ?`,
      now + 60_000,
      now,
      now,
    );
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

function mapReferenceNiche(
  row: ReferenceNicheRow & { model_count: number; media_count: number },
): ReferenceNicheRecord {
  return {
    slug: row.slug,
    title: row.title,
    active: row.active === 1,
    catalogPresent: row.catalog_present === 1,
    ...(row.thumbnail_url ? { thumbnailUrl: row.thumbnail_url } : {}),
    modelCount: Number(row.model_count ?? 0),
    mediaCount: Number(row.media_count ?? 0),
    ...(row.last_scanned_at !== null ? { lastScannedAt: Number(row.last_scanned_at) } : {}),
    nextScanAt: Number(row.next_scan_at ?? 0),
  };
}

function normalizeNicheSlug(value: unknown): string {
  const raw = cleanText(value, 120).toLowerCase();
  const fromUrl = raw.match(/(?:redgifs\.com)?\/niches\/([a-z0-9-]+)/u)?.[1];
  const slug = (fromUrl ?? raw)
    .replace(/^https?:\/\//u, "")
    .replace(/\?.*$/u, "")
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-");
  return /^[a-z0-9][a-z0-9-]{1,39}$/u.test(slug) ? slug : "";
}

function titleFromSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeMediaId(value: unknown): string {
  const cleaned = cleanText(value, 160).toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{2,119}$/u.test(cleaned) ? cleaned : "";
}

function normalizeStringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  const source = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const output: string[] = [];
  const seen = new Set<string>();
  for (const item of source) {
    const cleaned = cleanText(item, maxLength);
    const key = cleaned.toLowerCase();
    if (!cleaned || seen.has(key)) continue;
    seen.add(key);
    output.push(cleaned);
    if (output.length >= maxItems) break;
  }
  return output;
}

function normalizeMediaNiches(
  value: unknown,
): Array<{ slug: string; title: string; thumbnailUrl?: string }> {
  const output: Array<{ slug: string; title: string; thumbnailUrl?: string }> = [];
  const seen = new Set<string>();
  const source = Array.isArray(value) ? value : [];
  for (const item of source) {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : null;
    const rawSlug = record ? record.slug : item;
    const slug = normalizeNicheSlug(rawSlug);
    if (!slug || seen.has(slug)) continue;
    const title = record ? cleanText(record.title, 100) : "";
    const thumbnailUrl = record ? cleanOptional(record.thumbnailUrl, 1000) : undefined;
    output.push({
      slug,
      title: title || titleFromSlug(slug),
      ...(thumbnailUrl ? { thumbnailUrl } : {}),
    });
    seen.add(slug);
  }
  return output.slice(0, 80);
}

function optionalNonNegativeInteger(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

function optionalPositiveInteger(value: unknown): number | null {
  const number = optionalNonNegativeInteger(value);
  return number !== null && number > 0 ? number : null;
}

function parseStringArray(value: string): string[] {
  try {
    return normalizeStringArray(JSON.parse(value) as unknown, 80, 80);
  } catch {
    return [];
  }
}

function parseNiches(value: string): Array<{ slug: string; title: string }> {
  try {
    return normalizeMediaNiches(JSON.parse(value) as unknown);
  } catch {
    return [];
  }
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
