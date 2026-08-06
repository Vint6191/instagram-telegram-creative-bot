import {
  REFERENCE_CATALOG,
  REFERENCE_CATALOG_COUNT,
  REFERENCE_CATALOG_VERSION,
  REFERENCE_CATEGORIES,
  isReferenceCatalogSlug,
  referenceCatalogBySlug,
} from "./reference-catalog";
import type {
  ReferenceCategoryRecord,
  ReferenceDeliveryLease,
  ReferenceDiscoveredItem,
  ReferenceGroupRecord,
  ReferenceScanLease,
  ReferenceStats,
  ReferenceUploadLease,
  ReferenceUploadTask,
} from "./reference-types";
import { cleanOptional, cleanText, randomId, randomSecret } from "./shared";

interface GroupRow {
  chat_id: string;
  name: string;
  active: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

interface MediaRow {
  id: string;
  source_url: string;
  download_url: string | null;
  description: string | null;
  hashtags_json: string;
  author: string | null;
  views: number | null;
  likes: number | null;
  duration: number | null;
  file_id: string | null;
  file_unique_id: string | null;
  warehouse_chat_id: string | null;
  warehouse_message_id: string | null;
  upload_status: string;
  upload_attempt_count: number;
  upload_available_at: number;
  upload_lease_owner: string | null;
  upload_lease_token: string | null;
  upload_lease_expires_at: number | null;
  upload_error: string | null;
  upload_target_chat_id: string | null;
  created_at: number;
  updated_at: number;
  stored_at: number | null;
}

interface DeliveryRow {
  id: string;
  group_chat_id: string;
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

interface NicheRuntimeRow {
  slug: string;
  next_scan_at: number;
  last_scan_started_at: number | null;
  last_scanned_at: number | null;
  last_scan_error: string | null;
  scan_lease_owner: string | null;
  scan_lease_token: string | null;
  scan_lease_expires_at: number | null;
}

const HOUR_MS = 60 * 60 * 1000;
const SCAN_SPACING_MS = Math.max(1_000, Math.floor(HOUR_MS / REFERENCE_CATALOG_COUNT));
const SCAN_LEASE_MS = 20 * 60 * 1000;
const UPLOAD_LEASE_MS = 20 * 60 * 1000;
const DELIVERY_LEASE_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 7;

export class ReferenceQueueRepository {
  constructor(private readonly sql: DurableObjectSqlStorage) {}

  init(): void {
    // Full reference rebuild: physically remove every known table from the
    // abandoned implementations. Creative jobs and agent presence use other
    // tables and are intentionally untouched.
    this.sql.exec(`
      DROP TABLE IF EXISTS reference_deliveries;
      DROP TABLE IF EXISTS reference_media_niches;
      DROP TABLE IF EXISTS reference_model_niches;
      DROP TABLE IF EXISTS reference_media;
      DROP TABLE IF EXISTS reference_models;
      DROP TABLE IF EXISTS reference_niches;
      DROP TABLE IF EXISTS reference_curated_niches;
      DROP TABLE IF EXISTS reference_catalog_state;
      DROP TABLE IF EXISTS reference_maintenance_state;
      DROP TABLE IF EXISTS ref3_deliveries;
      DROP TABLE IF EXISTS ref3_media_niches;
      DROP TABLE IF EXISTS ref3_group_niches;
      DROP TABLE IF EXISTS ref3_media;
      DROP TABLE IF EXISTS ref3_groups;
      DROP TABLE IF EXISTS ref3_niche_runtime;
      DROP TABLE IF EXISTS ref3_catalog;
      DROP TABLE IF EXISTS ref3_meta;
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS ref4_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ref4_catalog (
        slug TEXT PRIMARY KEY,
        catalog_id INTEGER NOT NULL UNIQUE,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        description TEXT NOT NULL,
        sort_order INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ref4_catalog_category_idx
        ON ref4_catalog(category, sort_order);

      CREATE TABLE IF NOT EXISTS ref4_niche_runtime (
        slug TEXT PRIMARY KEY,
        next_scan_at INTEGER NOT NULL,
        last_scan_started_at INTEGER,
        last_scanned_at INTEGER,
        last_scan_error TEXT,
        scan_lease_owner TEXT,
        scan_lease_token TEXT,
        scan_lease_expires_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS ref4_niche_due_idx
        ON ref4_niche_runtime(next_scan_at);

      CREATE TABLE IF NOT EXISTS ref4_groups (
        chat_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS ref4_group_niches (
        group_chat_id TEXT NOT NULL,
        niche_slug TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(group_chat_id, niche_slug)
      );
      CREATE INDEX IF NOT EXISTS ref4_group_niches_slug_idx
        ON ref4_group_niches(niche_slug, group_chat_id);

      CREATE TABLE IF NOT EXISTS ref4_media (
        id TEXT PRIMARY KEY,
        source_url TEXT NOT NULL,
        download_url TEXT,
        description TEXT,
        hashtags_json TEXT NOT NULL DEFAULT '[]',
        author TEXT,
        views INTEGER,
        likes INTEGER,
        duration INTEGER,
        file_id TEXT,
        file_unique_id TEXT,
        warehouse_chat_id TEXT,
        warehouse_message_id TEXT,
        upload_status TEXT NOT NULL DEFAULT 'pending',
        upload_attempt_count INTEGER NOT NULL DEFAULT 0,
        upload_available_at INTEGER NOT NULL DEFAULT 0,
        upload_lease_owner TEXT,
        upload_lease_token TEXT,
        upload_lease_expires_at INTEGER,
        upload_error TEXT,
        upload_target_chat_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        stored_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS ref4_media_upload_idx
        ON ref4_media(upload_status, upload_available_at, created_at);

      CREATE TABLE IF NOT EXISTS ref4_media_niches (
        media_id TEXT NOT NULL,
        niche_slug TEXT NOT NULL,
        hot_rank INTEGER,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        PRIMARY KEY(media_id, niche_slug)
      );
      CREATE INDEX IF NOT EXISTS ref4_media_niches_slug_idx
        ON ref4_media_niches(niche_slug, media_id);

      CREATE TABLE IF NOT EXISTS ref4_deliveries (
        id TEXT PRIMARY KEY,
        group_chat_id TEXT NOT NULL,
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
        UNIQUE(group_chat_id, media_id)
      );
      CREATE INDEX IF NOT EXISTS ref4_deliveries_pick_idx
        ON ref4_deliveries(status, available_at, created_at);
    `);

    this.seedCatalog();
    this.setMeta("schema_version", "4");
    this.ensureMeta("enabled", "0");
    this.ensureMeta("next_scan_lease_at", "0");
  }

  setEnabled(enabled: boolean): void {
    this.setMeta("enabled", enabled ? "1" : "0");
  }

  isEnabled(): boolean {
    return this.getMeta("enabled") !== "0";
  }

  registerGroup(chatIdValue: string, nameValue: string): ReferenceGroupRecord {
    const chatId = normalizeChatId(chatIdValue);
    const name = cleanText(nameValue, 100) || `Группа ${chatId}`;
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO ref4_groups (chat_id, name, active, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET
         name = excluded.name, active = 1, updated_at = excluded.updated_at, deleted_at = NULL`,
      chatId,
      name,
      now,
      now,
    );
    return this.getGroup(chatId);
  }

  renameGroup(chatIdValue: string, nameValue: string): ReferenceGroupRecord {
    const chatId = normalizeChatId(chatIdValue);
    const name = cleanText(nameValue, 100);
    if (!name) throw new Error("Название группы пустое");
    this.sql.exec("UPDATE ref4_groups SET name = ?, updated_at = ? WHERE chat_id = ? AND deleted_at IS NULL", name, Date.now(), chatId);
    return this.getGroup(chatId);
  }

  setGroupActive(chatIdValue: string, active: boolean): ReferenceGroupRecord {
    const chatId = normalizeChatId(chatIdValue);
    this.sql.exec("UPDATE ref4_groups SET active = ?, updated_at = ? WHERE chat_id = ? AND deleted_at IS NULL", active ? 1 : 0, Date.now(), chatId);
    if (!active) {
      this.sql.exec(
        "DELETE FROM ref4_deliveries WHERE group_chat_id = ? AND status = 'pending'",
        chatId,
      );
    } else {
      this.queueBackfillForGroup(chatId, Date.now());
    }
    return this.getGroup(chatId);
  }

  removeGroup(chatIdValue: string): void {
    const chatId = normalizeChatId(chatIdValue);
    const now = Date.now();
    this.sql.exec("DELETE FROM ref4_group_niches WHERE group_chat_id = ?", chatId);
    this.sql.exec("DELETE FROM ref4_deliveries WHERE group_chat_id = ? AND status = 'pending'", chatId);
    this.sql.exec(
      "UPDATE ref4_groups SET active = 0, deleted_at = ?, updated_at = ? WHERE chat_id = ?",
      now,
      now,
      chatId,
    );
  }

  listGroups(): ReferenceGroupRecord[] {
    return this.sql
      .exec<GroupRow & { niche_count: number; sent_count: number; pending_count: number }>(
        `SELECT g.*,
          (SELECT COUNT(*) FROM ref4_group_niches gn WHERE gn.group_chat_id = g.chat_id) AS niche_count,
          (SELECT COUNT(*) FROM ref4_deliveries d WHERE d.group_chat_id = g.chat_id AND d.status = 'sent') AS sent_count,
          (SELECT COUNT(*) FROM ref4_deliveries d WHERE d.group_chat_id = g.chat_id AND d.status IN ('pending', 'leased')) AS pending_count
         FROM ref4_groups g
         WHERE g.deleted_at IS NULL
         ORDER BY g.active DESC, g.name COLLATE NOCASE ASC`,
      )
      .toArray()
      .map((row) => ({
        chatId: row.chat_id,
        name: row.name,
        active: row.active === 1,
        nicheCount: Number(row.niche_count ?? 0),
        sentCount: Number(row.sent_count ?? 0),
        pendingCount: Number(row.pending_count ?? 0),
        niches: [],
      }));
  }

  getGroup(chatIdValue: string): ReferenceGroupRecord {
    const chatId = normalizeChatId(chatIdValue);
    const row = this.sql.exec<GroupRow>("SELECT * FROM ref4_groups WHERE chat_id = ? AND deleted_at IS NULL", chatId).toArray()[0];
    if (!row) throw new Error("Группа референсов не найдена");
    return this.mapGroup(row);
  }

  listCategories(chatIdValue: string): ReferenceCategoryRecord[] {
    const chatId = normalizeChatId(chatIdValue);
    const selected = new Set(this.getGroup(chatId).niches);
    return REFERENCE_CATEGORIES.map((category) => ({
      key: category.key,
      title: category.title,
      count: category.count,
      selectedCount: REFERENCE_CATALOG.filter(
        (item) => item.category === category.key && selected.has(item.slug),
      ).length,
    }));
  }

  setGroupNiche(
    chatIdValue: string,
    slugValue: string,
    enabled: boolean,
  ): { enabled: boolean; queued: number } {
    const chatId = normalizeChatId(chatIdValue);
    const slug = normalizeCatalogSlug(slugValue);
    this.getGroup(chatId);
    const exists = Boolean(this.sql
      .exec<{ value: number }>(
        "SELECT 1 AS value FROM ref4_group_niches WHERE group_chat_id = ? AND niche_slug = ?",
        chatId,
        slug,
      )
      .toArray()[0]);
    const now = Date.now();
    if (!enabled) {
      if (exists) {
        this.sql.exec("DELETE FROM ref4_group_niches WHERE group_chat_id = ? AND niche_slug = ?", chatId, slug);
        this.prunePendingDeliveriesForGroup(chatId);
      }
      return { enabled: false, queued: 0 };
    }
    if (exists) return { enabled: true, queued: 0 };
    this.sql.exec(
      "INSERT INTO ref4_group_niches (group_chat_id, niche_slug, created_at) VALUES (?, ?, ?)",
      chatId,
      slug,
      now,
    );
    const before = this.pendingDeliveriesForGroup(chatId);
    this.queueBackfillForNiche(chatId, slug, now);
    return { enabled: true, queued: Math.max(0, this.pendingDeliveriesForGroup(chatId) - before) };
  }

  toggleGroupNiche(chatIdValue: string, slugValue: string): { enabled: boolean; queued: number } {
    const chatId = normalizeChatId(chatIdValue);
    const slug = normalizeCatalogSlug(slugValue);
    const exists = Boolean(this.sql
      .exec<{ value: number }>(
        "SELECT 1 AS value FROM ref4_group_niches WHERE group_chat_id = ? AND niche_slug = ?",
        chatId,
        slug,
      )
      .toArray()[0]);
    return this.setGroupNiche(chatId, slug, !exists);
  }

  setGroupCategory(
    chatIdValue: string,
    categoryValue: string,
    enabled: boolean,
  ): { selected: number; queued: number } {
    const chatId = normalizeChatId(chatIdValue);
    const category = cleanText(categoryValue, 40);
    const items = REFERENCE_CATALOG.filter((item) => item.category === category);
    if (items.length === 0) throw new Error("Категория не найдена");
    this.getGroup(chatId);
    const now = Date.now();
    const before = this.pendingDeliveriesForGroup(chatId);
    if (enabled) {
      for (const item of items) {
        this.sql.exec(
          "INSERT OR IGNORE INTO ref4_group_niches (group_chat_id, niche_slug, created_at) VALUES (?, ?, ?)",
          chatId,
          item.slug,
          now,
        );
      }
      this.queueBackfillForCategory(chatId, category, now);
    } else {
      for (const item of items) {
        this.sql.exec("DELETE FROM ref4_group_niches WHERE group_chat_id = ? AND niche_slug = ?", chatId, item.slug);
      }
      this.prunePendingDeliveriesForGroup(chatId);
    }
    return {
      selected: enabled ? items.length : 0,
      queued: Math.max(0, this.pendingDeliveriesForGroup(chatId) - before),
    };
  }

  stats(): ReferenceStats {
    this.releaseExpiredLeases();
    const row = this.sql
      .exec<{
        groups_count: number;
        active_groups: number;
        stored_media: number;
        pending_uploads: number;
        pending_deliveries: number;
        sent_deliveries: number;
        catalog_stored_niches: number;
        failed_niches: number;
        failed_uploads: number;
        failed_deliveries: number;
        last_scan_at: number | null;
      }>(
        `SELECT
          (SELECT COUNT(*) FROM ref4_groups WHERE deleted_at IS NULL) AS groups_count,
          (SELECT COUNT(*) FROM ref4_groups WHERE active = 1 AND deleted_at IS NULL) AS active_groups,
          (SELECT COUNT(*) FROM ref4_media WHERE upload_status = 'stored'
            AND warehouse_chat_id IS NOT NULL AND warehouse_message_id IS NOT NULL) AS stored_media,
          (SELECT COUNT(*) FROM ref4_media WHERE upload_status IN ('pending', 'leased')) AS pending_uploads,
          (SELECT COUNT(*) FROM ref4_deliveries WHERE status IN ('pending', 'leased')) AS pending_deliveries,
          (SELECT COUNT(*) FROM ref4_deliveries WHERE status = 'sent') AS sent_deliveries,
          (SELECT COUNT(*) FROM ref4_catalog) AS catalog_stored_niches,
          (SELECT COUNT(*) FROM ref4_niche_runtime WHERE last_scan_error IS NOT NULL) AS failed_niches,
          (SELECT COUNT(*) FROM ref4_media WHERE upload_status = 'failed') AS failed_uploads,
          (SELECT COUNT(*) FROM ref4_deliveries WHERE status = 'failed') AS failed_deliveries,
          (SELECT MAX(last_scanned_at) FROM ref4_niche_runtime) AS last_scan_at`,
      )
      .one();
    const catalogStoredNiches = Number(row.catalog_stored_niches ?? 0);
    const catalogReady =
      catalogStoredNiches === REFERENCE_CATALOG_COUNT
      && this.getMeta("catalog_version") === REFERENCE_CATALOG_VERSION
      && this.getMeta("catalog_count") === String(REFERENCE_CATALOG_COUNT);
    return {
      enabled: this.isEnabled(),
      groups: Number(row.groups_count ?? 0),
      activeGroups: Number(row.active_groups ?? 0),
      catalogNiches: REFERENCE_CATALOG_COUNT,
      catalogVersion: REFERENCE_CATALOG_VERSION,
      catalogStoredNiches,
      catalogReady,
      storedMedia: Number(row.stored_media ?? 0),
      pendingUploads: Number(row.pending_uploads ?? 0),
      pendingDeliveries: Number(row.pending_deliveries ?? 0),
      sentDeliveries: Number(row.sent_deliveries ?? 0),
      failedNiches: Number(row.failed_niches ?? 0),
      failedUploads: Number(row.failed_uploads ?? 0),
      failedDeliveries: Number(row.failed_deliveries ?? 0),
      ...(row.last_scan_at !== null ? { lastScanAt: Number(row.last_scan_at) } : {}),
    };
  }

  retryFailures(): { niches: number; uploads: number; deliveries: number } {
    const now = Date.now();
    const niches = Number(this.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM ref4_niche_runtime WHERE last_scan_error IS NOT NULL",
    ).one().count ?? 0);
    const uploads = Number(this.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM ref4_media WHERE upload_status = 'failed' AND warehouse_message_id IS NULL",
    ).one().count ?? 0);
    const deliveries = Number(this.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ref4_deliveries d
       JOIN ref4_groups g ON g.chat_id = d.group_chat_id
       JOIN ref4_media m ON m.id = d.media_id
       WHERE d.status = 'failed' AND g.active = 1 AND g.deleted_at IS NULL
         AND m.upload_status = 'stored'`,
    ).one().count ?? 0);

    this.sql.exec(
      `UPDATE ref4_niche_runtime SET last_scan_error = NULL, next_scan_at = ?
       WHERE last_scan_error IS NOT NULL`,
      now,
    );
    this.sql.exec(
      `UPDATE ref4_media SET upload_status = 'pending', upload_attempt_count = 0,
        upload_available_at = ?, upload_error = NULL, updated_at = ?
       WHERE upload_status = 'failed' AND warehouse_message_id IS NULL`,
      now,
      now,
    );
    this.sql.exec(
      `UPDATE ref4_deliveries SET status = 'pending', attempt_count = 0,
        available_at = ?, error = NULL, updated_at = ?
       WHERE status = 'failed' AND EXISTS (
         SELECT 1 FROM ref4_groups g
         JOIN ref4_media m ON m.id = ref4_deliveries.media_id
         WHERE g.chat_id = ref4_deliveries.group_chat_id
           AND g.active = 1 AND g.deleted_at IS NULL
           AND m.upload_status = 'stored'
       )`,
      now,
      now,
    );
    return { niches, uploads, deliveries };
  }

  leaseScan(agentIdValue: string): ReferenceScanLease | null {
    this.releaseExpiredLeases();
    if (!this.isEnabled()) return null;
    const agentId = cleanText(agentIdValue, 80);
    const now = Date.now();
    const nextGlobalLeaseAt = Number(this.getMeta("next_scan_lease_at") ?? 0);
    if (Number.isFinite(nextGlobalLeaseAt) && nextGlobalLeaseAt > now) return null;
    const row = this.sql
      .exec<NicheRuntimeRow>(
        `SELECT * FROM ref4_niche_runtime
         WHERE next_scan_at <= ?
           AND (scan_lease_expires_at IS NULL OR scan_lease_expires_at <= ?)
         ORDER BY next_scan_at ASC, slug ASC LIMIT 1`,
        now,
        now,
      )
      .toArray()[0];
    if (!row) return null;
    const catalog = referenceCatalogBySlug(row.slug);
    if (!catalog) {
      this.sql.exec("DELETE FROM ref4_niche_runtime WHERE slug = ?", row.slug);
      return null;
    }
    const leaseToken = randomSecret(24);
    this.sql.exec(
      `UPDATE ref4_niche_runtime SET
        scan_lease_owner = ?, scan_lease_token = ?, scan_lease_expires_at = ?,
        last_scan_started_at = ?
       WHERE slug = ?`,
      agentId,
      leaseToken,
      now + SCAN_LEASE_MS,
      now,
      row.slug,
    );
    this.setMeta("next_scan_lease_at", String(now + SCAN_SPACING_MS));
    return { slug: row.slug, title: catalog.title, leaseToken };
  }

  completeScan(agentIdValue: string, slugValue: string, leaseTokenValue: string): boolean {
    const row = this.validScanLease(agentIdValue, slugValue, leaseTokenValue);
    if (!row) return false;
    const now = Date.now();
    const next = now + HOUR_MS;
    this.sql.exec(
      `UPDATE ref4_niche_runtime SET
        last_scanned_at = ?, last_scan_error = NULL, next_scan_at = ?,
        scan_lease_owner = NULL, scan_lease_token = NULL, scan_lease_expires_at = NULL
       WHERE slug = ?`,
      now,
      next,
      row.slug,
    );
    return true;
  }

  failScan(agentIdValue: string, slugValue: string, leaseTokenValue: string, errorValue: string): boolean {
    const row = this.validScanLease(agentIdValue, slugValue, leaseTokenValue);
    if (!row) return false;
    const now = Date.now();
    this.sql.exec(
      `UPDATE ref4_niche_runtime SET
        last_scan_error = ?, next_scan_at = ?,
        scan_lease_owner = NULL, scan_lease_token = NULL, scan_lease_expires_at = NULL
       WHERE slug = ?`,
      cleanText(errorValue, 1000),
      now + 10 * 60 * 1000,
      row.slug,
    );
    return true;
  }

  discover(
    agentIdValue: string,
    nicheSlugValue: string,
    leaseTokenValue: string,
    items: ReferenceDiscoveredItem[],
  ): ReferenceUploadTask[] {
    const lease = this.validScanLease(agentIdValue, nicheSlugValue, leaseTokenValue);
    if (!lease) throw new Error("Scan lease expired");
    const nicheSlug = normalizeCatalogSlug(nicheSlugValue);
    const now = Date.now();
    const uploads = new Map<string, ReferenceUploadTask>();

    for (const raw of items.slice(0, 10)) {
      const id = normalizeMediaId(raw.id);
      if (!id) continue;
      const sourceUrl = cleanText(raw.sourceUrl, 700) || `https://www.redgifs.com/watch/${id}`;
      const downloadUrl = cleanOptional(raw.downloadUrl, 1400) ?? null;
      const description = cleanOptional(raw.description, 3000) ?? null;
      const hashtags = normalizeStringArray(raw.hashtags, 80, 80);
      const author = cleanOptional(raw.author, 120) ?? null;
      const views = optionalNonNegativeInteger(raw.views);
      const likes = optionalNonNegativeInteger(raw.likes);
      const duration = optionalNonNegativeInteger(raw.duration);
      const hotRank = optionalPositiveInteger(raw.hotRank);

      this.sql.exec(
        `INSERT INTO ref4_media (
          id, source_url, download_url, description, hashtags_json, author,
          views, likes, duration, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          source_url = excluded.source_url,
          download_url = COALESCE(excluded.download_url, ref4_media.download_url),
          description = COALESCE(excluded.description, ref4_media.description),
          hashtags_json = CASE WHEN excluded.hashtags_json != '[]'
            THEN excluded.hashtags_json ELSE ref4_media.hashtags_json END,
          author = COALESCE(excluded.author, ref4_media.author),
          views = COALESCE(excluded.views, ref4_media.views),
          likes = COALESCE(excluded.likes, ref4_media.likes),
          duration = COALESCE(excluded.duration, ref4_media.duration),
          upload_status = CASE
            WHEN ref4_media.upload_status = 'failed' AND ref4_media.warehouse_message_id IS NULL
              THEN 'pending' ELSE ref4_media.upload_status END,
          upload_attempt_count = CASE
            WHEN ref4_media.upload_status = 'failed' AND ref4_media.warehouse_message_id IS NULL
              THEN 0 ELSE ref4_media.upload_attempt_count END,
          upload_available_at = CASE
            WHEN ref4_media.upload_status = 'failed' AND ref4_media.warehouse_message_id IS NULL
              THEN excluded.updated_at ELSE ref4_media.upload_available_at END,
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

      this.upsertMediaNiche(id, nicheSlug, hotRank, now);
      for (const niche of normalizeMetadataNiches(raw.niches)) {
        this.upsertMediaNiche(id, niche, niche === nicheSlug ? hotRank : null, now);
      }

      const row = this.sql.exec<MediaRow>("SELECT * FROM ref4_media WHERE id = ?", id).one();
      if (row.upload_status === "stored" && row.warehouse_message_id) {
        this.queueDeliveriesForMedia(id, now);
      } else {
        uploads.set(id, this.uploadTask(id));
      }
    }
    return [...uploads.values()];
  }

  enrich(mediaIdValue: string, raw: ReferenceDiscoveredItem): ReferenceUploadTask | null {
    const id = normalizeMediaId(mediaIdValue || raw.id);
    if (!id) throw new Error("Некорректный RedGIFs ID");
    const existing = this.sql.exec<MediaRow>("SELECT * FROM ref4_media WHERE id = ?", id).toArray()[0];
    if (!existing) return null;
    const now = Date.now();
    const hashtags = normalizeStringArray(raw.hashtags, 80, 80);
    this.sql.exec(
      `UPDATE ref4_media SET
        source_url = COALESCE(?, source_url),
        download_url = COALESCE(?, download_url),
        description = COALESCE(?, description),
        hashtags_json = CASE WHEN ? != '[]' THEN ? ELSE hashtags_json END,
        author = COALESCE(?, author),
        views = COALESCE(?, views), likes = COALESCE(?, likes), duration = COALESCE(?, duration),
        updated_at = ?
       WHERE id = ?`,
      cleanOptional(raw.sourceUrl, 700) ?? null,
      cleanOptional(raw.downloadUrl, 1400) ?? null,
      cleanOptional(raw.description, 3000) ?? null,
      JSON.stringify(hashtags),
      JSON.stringify(hashtags),
      cleanOptional(raw.author, 120) ?? null,
      optionalNonNegativeInteger(raw.views),
      optionalNonNegativeInteger(raw.likes),
      optionalNonNegativeInteger(raw.duration),
      now,
      id,
    );
    for (const niche of normalizeMetadataNiches(raw.niches)) {
      this.upsertMediaNiche(id, niche, null, now);
    }
    return this.uploadTask(id);
  }

  leaseUpload(agentIdValue: string, warehouseChatIdValue: string): ReferenceUploadLease | null {
    this.releaseExpiredLeases();
    if (!this.isEnabled()) return null;
    const agentId = cleanText(agentIdValue, 80);
    const warehouseChatId = normalizeChatId(warehouseChatIdValue);
    const now = Date.now();
    const row = this.sql
      .exec<MediaRow>(
        `SELECT * FROM ref4_media
         WHERE upload_status = 'pending' AND warehouse_message_id IS NULL
           AND upload_available_at <= ? AND upload_attempt_count < ?
         ORDER BY created_at ASC, id ASC LIMIT 1`,
        now,
        MAX_ATTEMPTS,
      )
      .toArray()[0];
    if (!row) return null;
    const leaseToken = randomSecret(24);
    this.sql.exec(
      `UPDATE ref4_media SET
        upload_status = 'leased', upload_attempt_count = upload_attempt_count + 1,
        upload_lease_owner = ?, upload_lease_token = ?, upload_lease_expires_at = ?,
        upload_target_chat_id = ?, updated_at = ?
       WHERE id = ? AND upload_status = 'pending'`,
      agentId,
      leaseToken,
      now + UPLOAD_LEASE_MS,
      warehouseChatId,
      now,
      row.id,
    );
    const leased = this.sql.exec<MediaRow>("SELECT * FROM ref4_media WHERE id = ?", row.id).one();
    return leased.upload_status === "leased" && leased.upload_lease_token === leaseToken
      ? { ...this.uploadTask(row.id), leaseToken }
      : null;
  }

  completeUpload(
    agentIdValue: string,
    mediaIdValue: string,
    leaseTokenValue: string,
    fileIdValue: string,
    fileUniqueIdValue: string | undefined,
    warehouseChatIdValue: string,
    warehouseMessageIdValue: string,
  ): { queuedDeliveries: number } | null {
    const row = this.validUploadLease(agentIdValue, mediaIdValue, leaseTokenValue);
    if (!row) return null;
    const fileId = cleanText(fileIdValue, 600);
    const warehouseChatId = normalizeChatId(warehouseChatIdValue);
    const warehouseMessageId = cleanText(warehouseMessageIdValue, 80);
    if (!fileId || !warehouseMessageId) throw new Error("Telegram warehouse data is incomplete");
    if (row.upload_target_chat_id !== warehouseChatId) {
      throw new Error("Upload receipt does not match the leased warehouse");
    }
    const now = Date.now();
    this.sql.exec(
      `UPDATE ref4_media SET
        file_id = ?, file_unique_id = ?, warehouse_chat_id = ?, warehouse_message_id = ?,
        upload_status = 'stored', upload_error = NULL, stored_at = ?, updated_at = ?,
        upload_lease_owner = NULL, upload_lease_token = NULL, upload_lease_expires_at = NULL
       WHERE id = ?`,
      fileId,
      cleanOptional(fileUniqueIdValue, 600) ?? null,
      warehouseChatId,
      warehouseMessageId,
      now,
      now,
      row.id,
    );
    return { queuedDeliveries: this.queueDeliveriesForMedia(row.id, now) };
  }

  failUpload(
    agentIdValue: string,
    mediaIdValue: string,
    leaseTokenValue: string,
    errorValue: string,
    retryAfterSecondsValue: number,
  ): boolean {
    const row = this.validUploadLease(agentIdValue, mediaIdValue, leaseTokenValue);
    if (!row) return false;
    const now = Date.now();
    const retry = row.upload_attempt_count < MAX_ATTEMPTS;
    const delay = Math.max(60, Math.min(3600, Math.round(retryAfterSecondsValue || 300)));
    this.sql.exec(
      `UPDATE ref4_media SET
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

  reconcileUpload(
    mediaIdValue: string,
    fileIdValue: string,
    fileUniqueIdValue: string | undefined,
    warehouseChatIdValue: string,
    warehouseMessageIdValue: string,
  ): { queuedDeliveries: number; alreadyStored: boolean } {
    const mediaId = normalizeMediaId(mediaIdValue);
    if (!mediaId) throw new Error("Некорректный RedGIFs ID");
    const row = this.sql.exec<MediaRow>("SELECT * FROM ref4_media WHERE id = ?", mediaId).toArray()[0];
    if (!row) throw new Error("Reference not found");
    const fileId = cleanText(fileIdValue, 600);
    const warehouseChatId = normalizeChatId(warehouseChatIdValue);
    const warehouseMessageId = cleanText(warehouseMessageIdValue, 80);
    if (!fileId || !warehouseMessageId) throw new Error("Telegram warehouse data is incomplete");
    if (row.upload_status === "stored" && row.warehouse_message_id) {
      return { queuedDeliveries: this.queueDeliveriesForMedia(mediaId, Date.now()), alreadyStored: true };
    }
    if (row.upload_target_chat_id !== warehouseChatId) {
      throw new Error("Upload receipt does not match the leased warehouse");
    }
    const now = Date.now();
    this.sql.exec(
      `UPDATE ref4_media SET
        file_id = ?, file_unique_id = ?, warehouse_chat_id = ?, warehouse_message_id = ?,
        upload_status = 'stored', upload_error = NULL, stored_at = ?, updated_at = ?,
        upload_lease_owner = NULL, upload_lease_token = NULL, upload_lease_expires_at = NULL
       WHERE id = ?`,
      fileId,
      cleanOptional(fileUniqueIdValue, 600) ?? null,
      warehouseChatId,
      warehouseMessageId,
      now,
      now,
      mediaId,
    );
    return { queuedDeliveries: this.queueDeliveriesForMedia(mediaId, now), alreadyStored: false };
  }

  reconcileDelivery(deliveryIdValue: string, telegramMessageIdValue: string): boolean {
    const deliveryId = cleanText(deliveryIdValue, 120);
    const telegramMessageId = cleanText(telegramMessageIdValue, 80);
    if (!deliveryId || !telegramMessageId) throw new Error("Delivery receipt is incomplete");
    const row = this.sql.exec<DeliveryRow>(
      "SELECT * FROM ref4_deliveries WHERE id = ?",
      deliveryId,
    ).toArray()[0];
    if (!row) return false;
    if (row.status === "sent") return true;
    const now = Date.now();
    this.sql.exec(
      `UPDATE ref4_deliveries SET
        status = 'sent', sent_at = ?, updated_at = ?, telegram_message_id = ?, error = NULL,
        lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
       WHERE id = ?`,
      now,
      now,
      telegramMessageId,
      deliveryId,
    );
    return true;
  }

  leaseDelivery(agentIdValue: string): ReferenceDeliveryLease | null {
    this.releaseExpiredLeases();
    if (!this.isEnabled()) return null;
    const agentId = cleanText(agentIdValue, 80);
    const now = Date.now();
    const row = this.sql
      .exec<DeliveryRow>(
        `SELECT d.* FROM ref4_deliveries d
         JOIN ref4_media m ON m.id = d.media_id
         JOIN ref4_groups g ON g.chat_id = d.group_chat_id
         WHERE d.status = 'pending' AND d.available_at <= ?
           AND d.attempt_count < ? AND g.active = 1 AND g.deleted_at IS NULL
           AND m.upload_status = 'stored'
           AND m.warehouse_chat_id IS NOT NULL AND m.warehouse_message_id IS NOT NULL
         ORDER BY d.created_at ASC, d.id ASC LIMIT 1`,
        now,
        MAX_ATTEMPTS,
      )
      .toArray()[0];
    if (!row) return null;
    const leaseToken = randomSecret(24);
    this.sql.exec(
      `UPDATE ref4_deliveries SET
        status = 'leased', attempt_count = attempt_count + 1,
        lease_owner = ?, lease_token = ?, lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
      agentId,
      leaseToken,
      now + DELIVERY_LEASE_MS,
      now,
      row.id,
    );
    const leased = this.sql.exec<DeliveryRow>("SELECT * FROM ref4_deliveries WHERE id = ?", row.id).one();
    if (leased.status !== "leased" || leased.lease_token !== leaseToken) return null;
    const media = this.sql.exec<MediaRow>("SELECT * FROM ref4_media WHERE id = ?", leased.media_id).one();
    const group = this.sql.exec<GroupRow>("SELECT * FROM ref4_groups WHERE chat_id = ?", leased.group_chat_id).one();
    if (!media.warehouse_chat_id || !media.warehouse_message_id) return null;
    return {
      id: leased.id,
      leaseToken,
      groupChatId: group.chat_id,
      groupName: group.name,
      mediaId: media.id,
      warehouseChatId: media.warehouse_chat_id,
      warehouseMessageId: media.warehouse_message_id,
    };
  }

  completeDelivery(
    agentIdValue: string,
    deliveryIdValue: string,
    leaseTokenValue: string,
    telegramMessageIdValue: string,
  ): boolean {
    const row = this.validDeliveryLease(agentIdValue, deliveryIdValue, leaseTokenValue);
    if (!row) return false;
    const now = Date.now();
    this.sql.exec(
      `UPDATE ref4_deliveries SET
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

  failDelivery(
    agentIdValue: string,
    deliveryIdValue: string,
    leaseTokenValue: string,
    errorValue: string,
    retryAfterSecondsValue: number,
  ): boolean {
    const row = this.validDeliveryLease(agentIdValue, deliveryIdValue, leaseTokenValue);
    if (!row) return false;
    const now = Date.now();
    const retry = row.attempt_count < MAX_ATTEMPTS;
    const delay = Math.max(30, Math.min(3600, Math.round(retryAfterSecondsValue || 120)));
    this.sql.exec(
      `UPDATE ref4_deliveries SET
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

  private seedCatalog(): void {
    const currentVersion = this.getMeta("catalog_version");
    const currentCount = Number(
      this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM ref4_catalog").one().count ?? 0,
    );
    if (currentVersion === REFERENCE_CATALOG_VERSION && currentCount === REFERENCE_CATALOG_COUNT) return;
    const now = Date.now();
    this.sql.exec("DELETE FROM ref4_catalog");
    const chunkSize = 100;
    for (let offset = 0; offset < REFERENCE_CATALOG.length; offset += chunkSize) {
      const chunk = REFERENCE_CATALOG.slice(offset, offset + chunkSize);
      const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
      const bindings: Array<string | number> = [];
      for (const item of chunk) {
        bindings.push(item.slug, item.id, item.title, item.category, item.description, item.id);
      }
      this.sql.exec(
        `INSERT INTO ref4_catalog (slug, catalog_id, title, category, description, sort_order)
         VALUES ${placeholders}`,
        ...bindings,
      );
    }

    this.sql.exec(
      `DELETE FROM ref4_group_niches
       WHERE niche_slug NOT IN (SELECT slug FROM ref4_catalog)`,
    );
    this.sql.exec(
      `DELETE FROM ref4_media_niches
       WHERE niche_slug NOT IN (SELECT slug FROM ref4_catalog)`,
    );
    this.sql.exec(
      `DELETE FROM ref4_niche_runtime
       WHERE slug NOT IN (SELECT slug FROM ref4_catalog)`,
    );
    this.sql.exec(
      `DELETE FROM ref4_deliveries
       WHERE status != 'sent' AND NOT EXISTS (
         SELECT 1 FROM ref4_media_niches mn
         JOIN ref4_group_niches gn ON gn.niche_slug = mn.niche_slug
         WHERE mn.media_id = ref4_deliveries.media_id
           AND gn.group_chat_id = ref4_deliveries.group_chat_id
       )`,
    );
    this.sql.exec(
      `DELETE FROM ref4_media
       WHERE upload_status != 'stored' AND NOT EXISTS (
         SELECT 1 FROM ref4_media_niches mn WHERE mn.media_id = ref4_media.id
       )`,
    );

    for (const item of REFERENCE_CATALOG) {
      this.sql.exec(
        `INSERT INTO ref4_niche_runtime (slug, next_scan_at)
         VALUES (?, ?)
         ON CONFLICT(slug) DO NOTHING`,
        item.slug,
        now + (item.id - 1) * SCAN_SPACING_MS,
      );
    }
    this.setMeta("catalog_version", REFERENCE_CATALOG_VERSION);
    this.setMeta("catalog_count", String(REFERENCE_CATALOG_COUNT));
  }

  private uploadTask(id: string): ReferenceUploadTask {
    const row = this.sql.exec<MediaRow>("SELECT * FROM ref4_media WHERE id = ?", id).one();
    const niches = this.sql
      .exec<{ slug: string; title: string }>(
        `SELECT c.slug, c.title FROM ref4_media_niches mn
         JOIN ref4_catalog c ON c.slug = mn.niche_slug
         WHERE mn.media_id = ?
         ORDER BY c.sort_order ASC`,
        id,
      )
      .toArray();
    return {
      id: row.id,
      sourceUrl: row.source_url,
      ...(row.download_url ? { downloadUrl: row.download_url } : {}),
      ...(row.description ? { description: row.description } : {}),
      hashtags: parseStringArray(row.hashtags_json),
      niches,
      ...(row.author ? { author: row.author } : {}),
      ...(row.views !== null ? { views: Number(row.views) } : {}),
      ...(row.likes !== null ? { likes: Number(row.likes) } : {}),
      ...(row.duration !== null ? { duration: Number(row.duration) } : {}),
    };
  }

  private mapGroup(row: GroupRow): ReferenceGroupRecord {
    const niches = this.sql
      .exec<{ niche_slug: string }>(
        `SELECT gn.niche_slug FROM ref4_group_niches gn
         JOIN ref4_catalog c ON c.slug = gn.niche_slug
         WHERE gn.group_chat_id = ? ORDER BY c.sort_order`,
        row.chat_id,
      )
      .toArray()
      .map((item) => item.niche_slug);
    const counts = this.sql
      .exec<{ sent_count: number; pending_count: number }>(
        `SELECT
          SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent_count,
          SUM(CASE WHEN status IN ('pending', 'leased') THEN 1 ELSE 0 END) AS pending_count
         FROM ref4_deliveries WHERE group_chat_id = ?`,
        row.chat_id,
      )
      .one();
    return {
      chatId: row.chat_id,
      name: row.name,
      active: row.active === 1,
      nicheCount: niches.length,
      sentCount: Number(counts.sent_count ?? 0),
      pendingCount: Number(counts.pending_count ?? 0),
      niches,
    };
  }

  private upsertMediaNiche(mediaId: string, slug: string, hotRank: number | null, now: number): void {
    if (!isReferenceCatalogSlug(slug)) return;
    this.sql.exec(
      `INSERT INTO ref4_media_niches (media_id, niche_slug, hot_rank, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(media_id, niche_slug) DO UPDATE SET
         hot_rank = COALESCE(excluded.hot_rank, ref4_media_niches.hot_rank),
         last_seen_at = excluded.last_seen_at`,
      mediaId,
      slug,
      hotRank,
      now,
      now,
    );
  }

  private queueDeliveriesForMedia(mediaId: string, now: number): number {
    const before = this.totalPendingDeliveries();
    this.sql.exec(
      `INSERT OR IGNORE INTO ref4_deliveries (
        id, group_chat_id, media_id, status, attempt_count, available_at, created_at, updated_at
      )
      SELECT 'rd_' || hex(randomblob(12)), g.chat_id, ?, 'pending', 0, ?, ?, ?
      FROM ref4_groups g
      WHERE g.active = 1 AND g.deleted_at IS NULL AND EXISTS (
        SELECT 1 FROM ref4_group_niches gn
        JOIN ref4_media_niches mn ON mn.niche_slug = gn.niche_slug
        WHERE gn.group_chat_id = g.chat_id AND mn.media_id = ?
      )`,
      mediaId,
      now,
      now,
      now,
      mediaId,
    );
    return Math.max(0, this.totalPendingDeliveries() - before);
  }

  private queueBackfillForNiche(chatId: string, slug: string, now: number): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO ref4_deliveries (
        id, group_chat_id, media_id, status, attempt_count, available_at, created_at, updated_at
      )
      SELECT 'rd_' || hex(randomblob(12)), ?, m.id, 'pending', 0, ?, ?, ?
      FROM ref4_media m
      JOIN ref4_media_niches mn ON mn.media_id = m.id
      WHERE mn.niche_slug = ? AND m.upload_status = 'stored'
        AND m.warehouse_chat_id IS NOT NULL AND m.warehouse_message_id IS NOT NULL`,
      chatId,
      now,
      now,
      now,
      slug,
    );
  }

  private queueBackfillForCategory(chatId: string, category: string, now: number): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO ref4_deliveries (
        id, group_chat_id, media_id, status, attempt_count, available_at, created_at, updated_at
      )
      SELECT DISTINCT 'rd_' || hex(randomblob(12)), ?, m.id, 'pending', 0, ?, ?, ?
      FROM ref4_media m
      JOIN ref4_media_niches mn ON mn.media_id = m.id
      JOIN ref4_catalog c ON c.slug = mn.niche_slug
      WHERE c.category = ? AND m.upload_status = 'stored'
        AND m.warehouse_chat_id IS NOT NULL AND m.warehouse_message_id IS NOT NULL`,
      chatId,
      now,
      now,
      now,
      category,
    );
  }

  private queueBackfillForGroup(chatId: string, now: number): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO ref4_deliveries (
        id, group_chat_id, media_id, status, attempt_count, available_at, created_at, updated_at
      )
      SELECT DISTINCT 'rd_' || hex(randomblob(12)), ?, m.id, 'pending', 0, ?, ?, ?
      FROM ref4_media m
      JOIN ref4_media_niches mn ON mn.media_id = m.id
      JOIN ref4_group_niches gn ON gn.niche_slug = mn.niche_slug
      WHERE gn.group_chat_id = ? AND m.upload_status = 'stored'
        AND m.warehouse_chat_id IS NOT NULL AND m.warehouse_message_id IS NOT NULL`,
      chatId,
      now,
      now,
      now,
      chatId,
    );
  }

  private prunePendingDeliveriesForGroup(chatId: string): void {
    this.sql.exec(
      `DELETE FROM ref4_deliveries
       WHERE group_chat_id = ? AND status = 'pending'
         AND NOT EXISTS (
           SELECT 1 FROM ref4_media_niches mn
           JOIN ref4_group_niches gn ON gn.niche_slug = mn.niche_slug
           WHERE mn.media_id = ref4_deliveries.media_id
             AND gn.group_chat_id = ref4_deliveries.group_chat_id
         )`,
      chatId,
    );
  }

  private pendingDeliveriesForGroup(chatId: string): number {
    return Number(this.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM ref4_deliveries WHERE group_chat_id = ? AND status = 'pending'",
      chatId,
    ).one().count ?? 0);
  }

  private totalPendingDeliveries(): number {
    return Number(this.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM ref4_deliveries WHERE status IN ('pending', 'leased')",
    ).one().count ?? 0);
  }

  private validScanLease(agentIdValue: string, slugValue: string, tokenValue: string): NicheRuntimeRow | null {
    const slug = normalizeCatalogSlug(slugValue);
    return this.sql
      .exec<NicheRuntimeRow>(
        `SELECT * FROM ref4_niche_runtime
         WHERE slug = ? AND scan_lease_owner = ? AND scan_lease_token = ?
           AND scan_lease_expires_at > ? LIMIT 1`,
        slug,
        cleanText(agentIdValue, 80),
        cleanText(tokenValue, 160),
        Date.now(),
      )
      .toArray()[0] ?? null;
  }

  private validUploadLease(agentIdValue: string, mediaIdValue: string, tokenValue: string): MediaRow | null {
    return this.sql
      .exec<MediaRow>(
        `SELECT * FROM ref4_media
         WHERE id = ? AND upload_status = 'leased' AND warehouse_message_id IS NULL
           AND upload_lease_owner = ? AND upload_lease_token = ?
           AND upload_lease_expires_at > ? LIMIT 1`,
        normalizeMediaId(mediaIdValue),
        cleanText(agentIdValue, 80),
        cleanText(tokenValue, 160),
        Date.now(),
      )
      .toArray()[0] ?? null;
  }

  private validDeliveryLease(agentIdValue: string, deliveryIdValue: string, tokenValue: string): DeliveryRow | null {
    return this.sql
      .exec<DeliveryRow>(
        `SELECT * FROM ref4_deliveries
         WHERE id = ? AND status = 'leased' AND lease_owner = ? AND lease_token = ?
           AND lease_expires_at > ? LIMIT 1`,
        cleanText(deliveryIdValue, 120),
        cleanText(agentIdValue, 80),
        cleanText(tokenValue, 160),
        Date.now(),
      )
      .toArray()[0] ?? null;
  }

  private releaseExpiredLeases(): void {
    const now = Date.now();
    this.sql.exec(
      `UPDATE ref4_niche_runtime SET
        scan_lease_owner = NULL, scan_lease_token = NULL, scan_lease_expires_at = NULL,
        next_scan_at = ?
       WHERE scan_lease_expires_at IS NOT NULL AND scan_lease_expires_at <= ?`,
      now,
      now,
    );
    this.sql.exec(
      `UPDATE ref4_media SET
        upload_status = CASE WHEN upload_attempt_count < ? THEN 'pending' ELSE 'failed' END,
        upload_available_at = ?, updated_at = ?,
        upload_lease_owner = NULL, upload_lease_token = NULL, upload_lease_expires_at = NULL,
        upload_error = COALESCE(upload_error, 'Desktop disconnected during warehouse upload')
       WHERE upload_status = 'leased' AND upload_lease_expires_at <= ?`,
      MAX_ATTEMPTS,
      now + 60_000,
      now,
      now,
    );
    this.sql.exec(
      `UPDATE ref4_deliveries SET
        status = CASE WHEN attempt_count < ? THEN 'pending' ELSE 'failed' END,
        available_at = ?, updated_at = ?,
        lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
        error = COALESCE(error, 'Desktop disconnected during delivery')
       WHERE status = 'leased' AND lease_expires_at <= ?`,
      MAX_ATTEMPTS,
      now + 60_000,
      now,
      now,
    );
  }

  private getMeta(key: string): string | null {
    return this.sql.exec<{ value: string }>("SELECT value FROM ref4_meta WHERE key = ?", key).toArray()[0]?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec(
      `INSERT INTO ref4_meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      value,
      Date.now(),
    );
  }

  private ensureMeta(key: string, value: string): void {
    if (this.getMeta(key) === null) this.setMeta(key, value);
  }
}

function normalizeChatId(value: unknown): string {
  const chatId = cleanText(value, 40);
  if (!/^-?\d+$/u.test(chatId)) throw new Error("Некорректный Telegram chat id");
  return chatId;
}

function normalizeCatalogSlug(value: unknown): string {
  const slug = cleanText(value, 120).toLowerCase();
  if (!isReferenceCatalogSlug(slug)) throw new Error("Ниша отсутствует в утверждённом каталоге");
  return slug;
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

function normalizeMetadataNiches(value: unknown): string[] {
  const source = Array.isArray(value) ? value : [];
  const output: string[] = [];
  const seen = new Set<string>();
  for (const item of source) {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : null;
    const slug = cleanText(record?.slug ?? item, 120).toLowerCase();
    if (!isReferenceCatalogSlug(slug) || seen.has(slug)) continue;
    seen.add(slug);
    output.push(slug);
  }
  return output;
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
