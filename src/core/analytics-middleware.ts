import type { Request, Response, NextFunction } from "express";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import {
  alias,
  capture,
  clientFingerprint,
  hashPayer,
  newDistinctId,
  type EventName,
} from "./analytics.js";

interface AnalyticsLocals {
  distinctId: string;
  startedAt: number;
  product: string;
  payerAddress: string | null;
}

/**
 * Pulls the payer's wallet address out of an X-PAYMENT header so we can
 * use it as a stable distinct_id across the buyer's request → 402 → retry
 * → settled flow.
 *
 * The header is a base64-encoded PaymentPayload. For the `exact` EVM scheme
 * (the only one we serve), the EIP-3009 / Permit2 authorization carries the
 * payer in `payload.payload.authorization.from`. We avoid coupling to the
 * scheme's full type by reading defensively — if the shape isn't what we
 * expect, the caller falls back to a fresh anonymous id rather than emitting
 * a misleading hash.
 */
export function extractPayerAddress(header: string | undefined): string | null {
  if (!header) return null;
  try {
    const decoded = decodePaymentSignatureHeader(header);
    const inner = (decoded.payload ?? {}) as { authorization?: { from?: unknown } };
    const from = inner.authorization?.from;
    return typeof from === "string" && /^0x[0-9a-fA-F]{40}$/.test(from) ? from : null;
  } catch {
    return null;
  }
}

/**
 * Per-product analytics middleware factory.
 *
 * Identity strategy (fixes review item #21 — funnel joins):
 *   - On every request, derive a stable client fingerprint from (IP, UA).
 *     This is the distinct_id we emit for the unpaid first-touch and any
 *     subsequent unpaid request.
 *   - When the paid retry arrives carrying X-PAYMENT, derive the hashed
 *     payer address and alias the fingerprint id to it. PostHog now treats
 *     the unpaid 402 and the paid 200 as the same person.
 *   - All events for the paid retry use the hashed-payer id, so dashboards
 *     keyed by payer get clean attribution.
 */
export function analyticsMiddleware(product: string) {
  return function (req: Request, res: Response, next: NextFunction) {
    const paymentHeader = req.header("x-payment");
    const payerAddress = extractPayerAddress(paymentHeader);
    const fingerprint = clientFingerprint(req.ip, req.header("user-agent"));
    const distinctId = payerAddress ? hashPayer(payerAddress) : fingerprint;

    if (payerAddress) {
      // Stitch the prior unpaid request(s) (which were captured under the
      // fingerprint id) onto the now-known payer hash.
      alias(distinctId, fingerprint);
    }

    const locals = res.locals as { analytics?: AnalyticsLocals };
    locals.analytics = { distinctId, startedAt: Date.now(), product, payerAddress };

    capture(distinctId, "request_received", {
      product,
      route: req.path,
      has_payment_header: paymentHeader !== undefined,
    });

    res.on("finish", () => {
      const latency_ms = Date.now() - locals.analytics!.startedAt;
      const status = res.statusCode;

      let event: EventName | null = null;
      if (status === 402) event = "paywall_returned";
      else if (status === 400) event = "validation_failed";
      else if (status >= 500) event = "request_errored";
      else if (status >= 200 && status < 300 && paymentHeader) event = "payment_settled";

      if (!event) return;

      capture(distinctId, event, {
        product,
        route: req.path,
        status,
        latency_ms,
      });
    });

    next();
  };
}

/**
 * Anonymous fingerprinting helper used by tests of the unpaid-first-touch
 * flow without going through the middleware itself.
 */
export function newDistinctIdLegacy(): string {
  return newDistinctId();
}
