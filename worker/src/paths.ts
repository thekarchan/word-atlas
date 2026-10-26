/**
 * Pure helpers for the asset proxy. Kept separate from the Worker entry so the
 * rules can be unit-tested without a runtime.
 */

/** Longest object key we will ever look up (R2 allows 1024, we stay well under). */
const MAX_KEY = 512;

/**
 * Turn a request path into an R2 object key, or null when the path is not
 * something we are willing to look up.
 *
 * The charset is deliberately narrow: every key in this bucket is built from
 * word slugs (`[a-z0-9-]`), folder names and a file extension. Anything else —
 * percent-escapes, backslashes, dots that could climb a directory, control
 * characters — is rejected rather than "cleaned up", because a sanitiser that
 * rewrites input is how traversal bugs get through.
 */
export function toObjectKey(pathname: string): string | null {
  if (!pathname.startsWith("/")) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null; // malformed percent-encoding
  }

  // Decoding once means "%252e%252e" becomes "%2e%2e" and then fails the
  // charset check below, instead of surviving as "..".
  if (decoded.includes("..")) return null;
  if (decoded.includes("\\") || decoded.includes("\0")) return null;

  const key = decoded.slice(1);
  if (!key || key.length > MAX_KEY) return null;
  if (key.endsWith("/") || key.includes("//")) return null;
  if (!/^[A-Za-z0-9._\-/]+$/.test(key)) return null;

  return key;
}

/** Content types for the extensions this bucket actually holds. */
const TYPES: Record<string, string> = {
  webp: "image/webp",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  json: "application/json; charset=utf-8",
};

/** Fall back to the extension so a missing R2 metadata field cannot serve octets. */
export function contentTypeFor(key: string, stored?: string | null): string {
  if (stored && stored !== "application/octet-stream") return stored;
  const ext = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
  return TYPES[ext] || "application/octet-stream";
}

/** `YYYY-MM` in UTC — the billing period the counter rolls over on. */
export function utcPeriod(now: number = Date.now()): string {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Seconds until the current UTC month ends, for the Retry-After header. */
export function secondsUntilNextPeriod(now: number = Date.now()): number {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0);
  return Math.max(1, Math.ceil((next - now) / 1000));
}
