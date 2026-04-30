import crypto from "node:crypto";
import { canonicalJson } from "./help.js";

/**
 * Server-signed attestations.
 *
 * Used by /passport (bindings, anti-captcha passes), /escrow (release/refund
 * receipts), /agora/auction (auction-result attestations), and any future
 * product that needs to issue verifiable receipts to downstream consumers.
 *
 * Uses HMAC-SHA256 with SIGNING_SECRET (or legacy PASSPORT_SECRET, or a
 * per-process random default for dev/test). HMAC is sufficient because
 * there's a single trusted issuer (this server). For cross-server verification
 * swap to EIP-712 signatures with a configured EOA.
 */

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

export function signClaim(payload: Record<string, unknown>): string {
  const json = canonicalJson(payload);
  const mac = crypto.createHmac("sha256", getSecret()).update(json).digest("hex");
  return mac;
}

export function verifyClaim(payload: Record<string, unknown>, signature: string): boolean {
  const expected = signClaim(payload);
  // Constant-time compare.
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
}
