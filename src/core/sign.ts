import crypto from "node:crypto";
import { canonicalJson } from "./json.js";

/**
 * Server-issued attestation MACs.
 *
 * Used by /passport, /escrow, /agora/auction (and any future product) to
 * issue verifiable receipts to downstream consumers.
 *
 * This is HMAC-SHA256, not a public-key signature: the server is the only
 * issuer. Functions are named `attestMac` / `verifyMac` for honesty (review
 * item #19); `signClaim` / `verifyClaim` are kept as legacy aliases.
 *
 * Every claim is wrapped in a `{claim_version: N, payload: {...}}` envelope
 * so we can change a payload's meaning without producing colliding MACs
 * across schema versions (review item #18).
 *
 * Reads SIGNING_SECRET (or legacy PASSPORT_SECRET, or a per-process random
 * default for dev/test). For cross-server verification, swap to EIP-712 with
 * a configured EOA private key.
 */

export const CLAIM_VERSION = 1;

let cachedSecret: Buffer | null = null;

function getSecret(): Buffer {
  if (cachedSecret) return cachedSecret;
  const env = process.env.SIGNING_SECRET ?? process.env.PASSPORT_SECRET;
  if (env && env.length >= 16) {
    cachedSecret = Buffer.from(env, "utf8");
  } else {
    // Per-process random secret. Survives process lifetime; tokens issued in
    // one process cannot be verified by another. Fine for dev and tests.
    cachedSecret = crypto.randomBytes(32);
  }
  return cachedSecret;
}

export function resetSecretForTesting(secret?: string): void {
  cachedSecret = secret ? Buffer.from(secret, "utf8") : null;
}

interface VersionedClaim {
  claim_version: number;
  payload: Record<string, unknown>;
}

function envelope(payload: Record<string, unknown>): VersionedClaim {
  return { claim_version: CLAIM_VERSION, payload };
}

export function attestMac(payload: Record<string, unknown>): string {
  const json = canonicalJson(envelope(payload));
  return crypto.createHmac("sha256", getSecret()).update(json).digest("hex");
}

export function verifyMac(payload: Record<string, unknown>, mac: string): boolean {
  const expected = attestMac(payload);
  if (expected.length !== mac.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(mac, "hex"));
  } catch {
    return false;
  }
}

// Legacy aliases — kept so existing callers and tests keep working without
// having to touch every site at once.
export const signClaim = attestMac;
export const verifyClaim = verifyMac;
