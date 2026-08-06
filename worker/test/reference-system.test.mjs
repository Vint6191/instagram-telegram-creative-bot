import { webcrypto } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ReferenceQueueRepository } from "../src/reference-queue.ts";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.btoa) {
  globalThis.btoa = (value) => Buffer.from(value, "binary").toString("base64");
}

class SqlAdapter {
  constructor(db) {
    this.db = db;
  }

  exec(query, ...bindings) {
    const trimmed = query.trim();
    let rows = [];
    if (bindings.length === 0 && trimmed.includes(";")) {
      this.db.exec(query);
    } else {
      const statement = this.db.prepare(query);
      if (/^(SELECT|WITH|PRAGMA)\b/iu.test(trimmed)) rows = statement.all(...bindings);
      else statement.run(...bindings);
    }
    return {
      toArray: () => rows,
      one: () => {
        if (rows.length !== 1) {
          throw new Error(`Expected one row, got ${rows.length}: ${trimmed.slice(0, 100)}`);
        }
        return rows[0];
      },
    };
  }
}

describe("reference repository integration", () => {
  it("isolates old data, filters niches, warehouses once and copies idempotently", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE reference_models(chat_id TEXT PRIMARY KEY, name TEXT, active INTEGER);
      CREATE TABLE reference_model_niches(model_chat_id TEXT, niche_slug TEXT);
      INSERT INTO reference_models VALUES('-100999', 'OLD GARBAGE', 1);
      INSERT INTO reference_model_niches VALUES('-100999', '3d-porn');
    `);
    const repo = new ReferenceQueueRepository(new SqlAdapter(db));
    repo.init();

    expect(repo.stats().catalogNiches).toBe(473);
    expect(repo.listGroups()).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name='reference_models'").get().count).toBe(0);
    expect(db.prepare("SELECT COUNT(*) count FROM ref4_catalog WHERE slug='3d-porn'").get().count).toBe(0);

    const group = repo.registerGroup("-100200", "Model A");
    repo.toggleGroupNiche(group.chatId, "3-somes");
    repo.setEnabled(true);

    db.prepare("UPDATE ref4_niche_runtime SET next_scan_at=0 WHERE slug='3-somes'").run();
    const scan = repo.leaseScan("agent");
    expect(scan?.slug).toBe("3-somes");
    expect(repo.leaseScan("agent")).toBeNull();
    const uploads = repo.discover("agent", scan.slug, scan.leaseToken, [{
      id: "media001",
      sourceUrl: "https://www.redgifs.com/watch/media001",
      niches: [
        { slug: "3d-porn", title: "excluded" },
        { slug: "3-somes", title: "approved" },
      ],
      hotRank: 1,
    }]);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].niches.map((item) => item.slug)).toEqual(["3-somes"]);
    expect(repo.completeScan("agent", scan.slug, scan.leaseToken)).toBe(true);

    const upload = repo.leaseUpload("agent", "-100300");
    expect(upload).not.toBeNull();
    expect(() => repo.completeUpload(
      "agent", upload.id, upload.leaseToken, "file", "unique", "-100301", "10",
    )).toThrow(/leased warehouse/);
    const stored = repo.completeUpload(
      "agent", upload.id, upload.leaseToken, "file", "unique", "-100300", "10",
    );
    expect(stored?.queuedDeliveries).toBe(1);

    const delivery = repo.leaseDelivery("agent");
    expect(delivery?.warehouseChatId).toBe("-100300");
    expect(delivery?.warehouseMessageId).toBe("10");
    expect(repo.reconcileDelivery(delivery.id, "55")).toBe(true);
    expect(repo.reconcileDelivery(delivery.id, "55")).toBe(true);

    const second = repo.registerGroup("-100201", "Model B");
    expect(repo.toggleGroupNiche(second.chatId, "3-somes").queued).toBe(1);
    const inFlight = repo.leaseDelivery("agent");
    repo.removeGroup(second.chatId);
    expect(repo.listGroups().some((item) => item.chatId === second.chatId)).toBe(false);
    expect(repo.reconcileDelivery(inFlight.id, "56")).toBe(true);
  });
});
