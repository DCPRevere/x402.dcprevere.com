import crypto from "node:crypto";
import { PostHog } from "posthog-node";
import { config } from "./config.js";

let client: PostHog | null = null;

if (config.posthogKey) {
  client = new PostHog(config.posthogKey, {
    host: config.posthogHost,
    flushAt: 1,
    flushInterval: 5000,
  });
}

/**
 * Event taxonomy — actor_action, present-tense.
 *
 * Funnel joins (request → paywall → settled → delivered) work because the
 * analytics middleware aliases the per-request anonymous id to the payer's
 * hashed wallet on the paid retry. PostHog `alias` collapses both ids into
 * one PostHog person.
 *
 * Renamed in fix #31:
 *   payment_required_sent → paywall_returned
 *   product_rendered      → product_delivered
 *   validation_error      → validation_failed
 *   error                 → request_errored
 */
export type EventName =
  | "request_received"
  | "paywall_returned"
  | "payment_settled"
  | "product_delivered"
  | "validation_failed"
  | "request_errored";

export function capture(
  distinctId: string,
  event: EventName,
  properties: Record<string, unknown> = {},
) {
  if (!client) return;
  client.capture({
    distinctId,
    event,
    properties: {
      service: "x402.aegent.dev",
      network: config.network,
      ...properties,
    },
  });
}

/**
 * Tell PostHog that two distinct_ids are the same person. Used so an
 * unpaid first-touch (anon-XXXX) gets stitched onto the paid retry's
 * hashed-payer id, making the request → paywall → settled funnel work.
 *
 * Fixes review item #21.
 */
export function alias(distinctId: string, alsoKnownAs: string) {
  if (!client) return;
  client.alias({ distinctId, alias: alsoKnownAs });
}

export async function shutdown() {
  if (!client) return;
  await client.shutdown();
}

export function hashPayer(addr: string): string {
  return crypto.createHash("sha256").update(addr.toLowerCase()).digest("hex").slice(0, 12);
}

export function newDistinctId(): string {
  return `anon-${crypto.randomBytes(6).toString("hex")}`;
}

/**
 * Stable per-(IP, UA) anonymous id, so an unpaid 402 request and the same
 * client's paid retry seconds later share a distinct_id. PostHog will then
 * alias this to the hashed payer on the paid retry, joining the funnel.
 */
export function clientFingerprint(ip: string | undefined, userAgent: string | undefined): string {
  const material = `${ip ?? "unknown-ip"}|${userAgent ?? "unknown-ua"}`;
  return "fp-" + crypto.createHash("sha256").update(material).digest("hex").slice(0, 12);
}
