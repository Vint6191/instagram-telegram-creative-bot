const ALLOWED_HOSTS = new Set([
  "instagram.com",
  "www.instagram.com",
  "m.instagram.com",
  "instagr.am",
  "www.instagr.am",
]);

const ALLOWED_PREFIXES = ["/reel/", "/reels/", "/p/", "/tv/"];

export function extractInstagramUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>]+/giu) ?? [];
  const unique = new Set<string>();

  for (const raw of matches) {
    const trimmed = raw.replace(/[),.!?;:]+$/u, "");
    const canonical = canonicalizeInstagramUrl(trimmed);
    if (canonical) unique.add(canonical);
  }

  return [...unique];
}

export function canonicalizeInstagramUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) return null;
  if (!ALLOWED_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return null;

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const type = parts[0] === "reels" ? "reel" : parts[0];
  const shortcode = parts[1]!;
  if (!/^[A-Za-z0-9_-]+$/u.test(shortcode)) return null;

  return `https://www.instagram.com/${type}/${shortcode}/`;
}
