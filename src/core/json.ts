import crypto from "node:crypto";

/**
 * Canonical JSON serialisation: keys sorted alphabetically at every depth.
 *
 * Used by /help (etag stability across map iteration order) and /core/sign
 * (HMAC determinism — two semantically-equal claims must hash to the same
 * MAC regardless of how the caller spelled the object literal).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** sha256(json) wrapped in W3C strong-etag double quotes. */
export function etagFor(json: string): string {
  return `"${crypto.createHash("sha256").update(json).digest("hex")}"`;
}
