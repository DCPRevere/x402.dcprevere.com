import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import {
  analyticsMiddleware,
  extractPayerAddress,
} from "../src/core/analytics-middleware.js";
import * as analytics from "../src/core/analytics.js";

const PAYER = "0x1111111111111111111111111111111111111111";
const OTHER_PAYER = "0x2222222222222222222222222222222222222222";

function fakePaymentHeader(from: string): string {
  return encodePaymentSignatureHeader({
    x402Version: 1,
    accepted: {
      scheme: "exact",
      network: "eip155:84532",
      asset: "0x0000000000000000000000000000000000000000",
      amount: "100000",
      payTo: "0x000000000000000000000000000000000000dEaD",
      maxTimeoutSeconds: 60,
      extra: {},
    },
    payload: {
      authorization: {
        from,
        to: "0x000000000000000000000000000000000000dEaD",
        value: "100000",
        validAfter: "0",
        validBefore: "9999999999",
        nonce: "0x" + "0".repeat(64),
      },
      signature: "0x" + "0".repeat(130),
    },
  });
}

describe("extractPayerAddress", () => {
  it("returns null when no header is provided", () => {
    expect(extractPayerAddress(undefined)).toBeNull();
  });

  it("returns null on a malformed header", () => {
    expect(extractPayerAddress("not-base64!!!")).toBeNull();
  });

  it("returns null when the decoded payload has no authorization.from", () => {
    const header = encodePaymentSignatureHeader({
      x402Version: 1,
      accepted: {
        scheme: "exact",
        network: "eip155:84532",
        asset: "0x0000000000000000000000000000000000000000",
        amount: "0",
        payTo: "0x000000000000000000000000000000000000dEaD",
        maxTimeoutSeconds: 0,
        extra: {},
      },
      payload: { something: "else" },
    });
    expect(extractPayerAddress(header)).toBeNull();
  });

  it("extracts the payer address from a well-formed EIP-3009 payload", () => {
    expect(extractPayerAddress(fakePaymentHeader(PAYER))).toBe(PAYER);
  });
});

describe("analyticsMiddleware", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function harness() {
    const captured: { id: string; props: Record<string, unknown> }[] = [];
    vi.spyOn(analytics, "capture").mockImplementation((id, _event, props) => {
      captured.push({ id, props: { _event, ...(props ?? {}) } });
    });
    const app = express();
    app.use("/figlet", analyticsMiddleware("figlet"));
    app.get("/figlet/render", (_req, res) => {
      res.status(402).type("text/plain").send("paywall");
    });
    app.get("/figlet/fonts", (_req, res) => {
      res.json({ ok: true });
    });
    return { app, captured };
  }

  it("emits request_received and payment_required_sent for an unpaid request", async () => {
    const { app, captured } = harness();
    const res = await request(app).get("/figlet/render?text=hi");
    expect(res.status).toBe(402);
    const events = captured.map((c) => c.props._event);
    expect(events).toContain("request_received");
    expect(events).toContain("payment_required_sent");
  });

  it("anonymous distinct_id when the request has no X-PAYMENT header", async () => {
    const { app, captured } = harness();
    await request(app).get("/figlet/render?text=hi");
    const id = captured[0]?.id ?? "";
    expect(id).toMatch(/^anon-/);
  });

  it("uses a stable hashed payer id when X-PAYMENT is present", async () => {
    const { app, captured } = harness();
    const header = fakePaymentHeader(PAYER);
    await request(app).get("/figlet/render?text=hi").set("X-PAYMENT", header);
    await request(app).get("/figlet/render?text=hi").set("X-PAYMENT", header);
    const ids = new Set(captured.map((c) => c.id));
    // Both requests should land on the same distinct_id, so we expect one
    // unique id across all events from the two calls.
    expect(ids.size).toBe(1);
    // And it should not be the anonymous fallback.
    const [theId] = [...ids];
    expect(theId.startsWith("anon-")).toBe(false);
  });

  it("different payers get different distinct_ids", async () => {
    const { app, captured } = harness();
    await request(app)
      .get("/figlet/render?text=hi")
      .set("X-PAYMENT", fakePaymentHeader(PAYER));
    await request(app)
      .get("/figlet/render?text=hi")
      .set("X-PAYMENT", fakePaymentHeader(OTHER_PAYER));
    const ids = new Set(captured.map((c) => c.id));
    expect(ids.size).toBe(2);
  });

  it("emits a 'payment_settled' event on a 2xx with X-PAYMENT", async () => {
    const captured: string[] = [];
    vi.spyOn(analytics, "capture").mockImplementation((_id, event) => {
      captured.push(event);
    });
    const app = express();
    app.use("/figlet", analyticsMiddleware("figlet"));
    app.get("/figlet/render", (_req, res) => res.status(200).send("ok"));
    await request(app)
      .get("/figlet/render?text=hi")
      .set("X-PAYMENT", fakePaymentHeader(PAYER));
    expect(captured).toContain("payment_settled");
    expect(captured).not.toContain("payment_required_sent");
  });

  it("emits 'validation_error' on 400 and 'error' on 5xx", async () => {
    const captured: string[] = [];
    vi.spyOn(analytics, "capture").mockImplementation((_id, event) => {
      captured.push(event);
    });
    const app = express();
    app.use("/figlet", analyticsMiddleware("figlet"));
    app.get("/figlet/bad", (_req, res) => res.status(400).send("bad"));
    app.get("/figlet/boom", (_req, res) => res.status(500).send("boom"));
    await request(app).get("/figlet/bad");
    await request(app).get("/figlet/boom");
    expect(captured).toContain("validation_error");
    expect(captured).toContain("error");
  });
});
