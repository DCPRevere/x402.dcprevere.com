/**
 * Shared regex + type guards for the formats every product validates.
 *
 * Centralising these means a typo can't ship in one place and not another,
 * and the regex is exactly one place to change if Ethereum ever moves to a
 * different address format.
 */

export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
/** 32 bytes of hex, no 0x prefix. */
export const HEX32_NO_PREFIX_RE = /^[0-9a-fA-F]{64}$/;
/** 32 bytes of hex with optional 0x prefix. */
export const HEX32_RE = /^0x?[0-9a-fA-F]{64}$/;
export const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAddress(s: unknown): s is `0x${string}` {
  return typeof s === "string" && ADDRESS_RE.test(s);
}

/** Strip an optional 0x prefix and validate the rest is 64 hex chars. */
export function parseHex32(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const cleaned = s.replace(/^0x/, "");
  return HEX32_NO_PREFIX_RE.test(cleaned) ? cleaned.toLowerCase() : null;
}

export function isUuidV4(s: unknown): s is string {
  return typeof s === "string" && UUID_V4_RE.test(s);
}
