import { describe, expect, it } from "vitest";
import { canonicalizeInstagramUrl, extractInstagramUrls } from "../src/instagram-url";

describe("instagram URL validation", () => {
  it("canonicalizes reels", () => {
    expect(
      canonicalizeInstagramUrl("https://instagram.com/reel/ABC_123/?igsh=hello"),
    ).toBe("https://www.instagram.com/reel/ABC_123/");
  });

  it("canonicalizes posts", () => {
    expect(canonicalizeInstagramUrl("https://www.instagram.com/p/Ab-c_1/"))
      .toBe("https://www.instagram.com/p/Ab-c_1/");
  });

  it("rejects lookalike hosts", () => {
    expect(canonicalizeInstagramUrl("https://instagram.com.evil.test/reel/ABC/"))
      .toBeNull();
  });

  it("extracts one unique URL", () => {
    expect(
      extractInstagramUrls(
        "вот https://instagram.com/reel/ABC/?x=1 и снова https://www.instagram.com/reel/ABC/",
      ),
    ).toEqual(["https://www.instagram.com/reel/ABC/"]);
  });
});
