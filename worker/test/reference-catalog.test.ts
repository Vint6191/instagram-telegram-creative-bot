import { describe, expect, it } from "vitest";
import {
  REFERENCE_CATALOG,
  REFERENCE_CATALOG_COUNT,
  REFERENCE_CATALOG_VERSION,
  REFERENCE_CATEGORIES,
  isReferenceCatalogSlug,
  referenceCatalogById,
} from "../src/reference-catalog";
import { keyboard } from "../src/bot/ui";

describe("approved reference catalog", () => {
  it("contains exactly the curated XLSX set", () => {
    expect(REFERENCE_CATALOG_COUNT).toBe(473);
    expect(REFERENCE_CATALOG).toHaveLength(473);
    expect(new Set(REFERENCE_CATALOG.map((item) => item.slug)).size).toBe(473);
    expect(REFERENCE_CATALOG_VERSION).toBe("abf4c06a0ce79a66");
    expect(isReferenceCatalogSlug("3-somes")).toBe(true);
    expect(isReferenceCatalogSlug("3d-porn")).toBe(false);
  });

  it("has stable numeric IDs and category totals", () => {
    expect(REFERENCE_CATALOG.every((item, index) => item.id === index + 1)).toBe(true);
    expect(referenceCatalogById(1)?.slug).toBe(REFERENCE_CATALOG[0]?.slug);
    expect(REFERENCE_CATEGORIES.reduce((sum, item) => sum + item.count, 0)).toBe(473);
  });
});

describe("Telegram menu callbacks", () => {
  it("accepts the longest callbacks produced by the menus", () => {
    expect(() => keyboard([[{
      text: "test",
      callback_data: "r:nset:-1001234567890:473:1:7:999",
    }]])).not.toThrow();
  });

  it("rejects callback_data over Telegram's 64-byte limit", () => {
    expect(() => keyboard([[{ text: "bad", callback_data: "x".repeat(65) }]])).toThrow(/64 bytes/);
  });
});
