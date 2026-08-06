import { webcrypto } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { CreativeQueueRepository } from "../src/creative-queue.ts";

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
        if (rows.length !== 1) throw new Error(`Expected one row, got ${rows.length}`);
        return rows[0];
      },
    };
  }
}

describe("Telegram durable update inbox", () => {
  it("leases each update once, marks success and releases failures", () => {
    const db = new DatabaseSync(":memory:");
    const repo = new CreativeQueueRepository(new SqlAdapter(db));
    repo.init();

    const first = repo.leaseTelegramUpdate(1001);
    expect(first).toBeTruthy();
    expect(repo.leaseTelegramUpdate(1001)).toBeNull();
    expect(repo.completeTelegramUpdate(1001, first)).toBe(true);
    expect(repo.leaseTelegramUpdate(1001)).toBeNull();

    const failed = repo.leaseTelegramUpdate(1002);
    expect(failed).toBeTruthy();
    repo.failTelegramUpdate(1002, failed);
    const retried = repo.leaseTelegramUpdate(1002);
    expect(retried).toBeTruthy();
    expect(retried).not.toBe(failed);
  });
});
