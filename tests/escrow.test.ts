import { describe, it, expect, beforeEach, afterAll } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { setDbForTesting, runMigrations, closeDb } from "../src/core/persist.js";
import { ESCROW_MIGRATIONS } from "../src/products/escrow/state.js";
import { PASSPORT_MIGRATIONS } from "../src/products/passport/state.js";
import { RANDOM_MIGRATIONS } from "../src/products/random/state.js";
import {
  escrowProduct,
  escrowPreValidator,
  setContextProviderForTesting,
  resetContextProviderForTesting,
} from "../src/products/escrow/router.js";
import { resetSecretForTesting, verifyClaim } from "../src/core/sign.js";

const BUYER = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";

function freshApp(now: Date = new Date()): Express {
  const app = express();
  app.use(express.json({ limit: "16kb" }));
  app.use("/escrow", escrowPreValidator);
  app.use("/escrow", escrowProduct.router());
  setContextProviderForTesting(async () => ({ now, currentBlock: 100n }));
  return app;
}

const FUTURE = "2030-01-01T00:00:00Z";
const FAR_FUTURE = "2030-12-31T23:59:59Z";

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    buyer: BUYER,
    recipient: RECIPIENT,
    amount_usdc: "1000000",
    condition_kind: "timestamp",
    condition_value: FUTURE,
    deadline: FAR_FUTURE,
    ...overrides,
  };
}

describe("/escrow", () => {
  beforeEach(() => {
    closeDb();
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    setDbForTesting(db);
    runMigrations(ESCROW_MIGRATIONS);
    runMigrations(PASSPORT_MIGRATIONS);
    runMigrations(RANDOM_MIGRATIONS);
    resetSecretForTesting("test-secret-of-sufficient-length");
    resetContextProviderForTesting();
  });

  afterAll(() => {
    closeDb();
  });

  describe("validation (preValidator)", () => {
    it("rejects missing JSON body", async () => {
      const app = freshApp();
      const res = await request(app).post("/escrow/create").send();
      expect(res.status).toBe(400);
    });

    it("rejects bad buyer address", async () => {
      const app = freshApp();
      const res = await request(app)
        .post("/escrow/create")
        .send(validBody({ buyer: "not-an-address" }));
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/buyer/);
    });

    it("rejects buyer === recipient", async () => {
      const app = freshApp();
      const res = await request(app).post("/escrow/create").send(validBody({ recipient: BUYER }));
      expect(res.status).toBe(400);
    });

    it("rejects non-positive amount", async () => {
      const app = freshApp();
      const res = await request(app).post("/escrow/create").send(validBody({ amount_usdc: "0" }));
      expect(res.status).toBe(400);
    });

    it("rejects unknown condition_kind", async () => {
      const app = freshApp();
      const res = await request(app)
        .post("/escrow/create")
        .send(validBody({ condition_kind: "made_up" }));
      expect(res.status).toBe(400);
    });

    it("rejects past deadline", async () => {
      const app = freshApp();
      const res = await request(app)
        .post("/escrow/create")
        .send(validBody({ deadline: "2020-01-01T00:00:00Z" }));
      expect(res.status).toBe(400);
    });

    it("rejects oversized memo", async () => {
      const app = freshApp();
      const res = await request(app)
        .post("/escrow/create")
        .send(validBody({ memo: "x".repeat(257) }));
      expect(res.status).toBe(400);
    });

    it("rejects malformed timestamp condition_value", async () => {
      const app = freshApp();
      const res = await request(app)
        .post("/escrow/create")
        .send(validBody({ condition_value: "not-a-date" }));
      expect(res.status).toBe(400);
    });

    it("rejects malformed passport_binding selector", async () => {
      const app = freshApp();
      const res = await request(app)
        .post("/escrow/create")
        .send(
          validBody({
            condition_kind: "passport_binding",
            condition_value: "not-a-selector",
          }),
        );
      expect(res.status).toBe(400);
    });

    it("accepts a valid create body", async () => {
      const app = freshApp();
      const res = await request(app).post("/escrow/create").send(validBody());
      expect(res.status).toBe(201);
      expect(res.body.escrow.state).toBe("open");
      expect(res.body.escrow.buyer).toBe(BUYER.toLowerCase());
      expect(res.body.escrow.recipient).toBe(RECIPIENT.toLowerCase());
    });
  });

  describe("get + listing", () => {
    it("returns 404 for unknown id", async () => {
      const app = freshApp();
      const res = await request(app).get("/escrow/00000000-0000-0000-0000-000000000000");
      expect(res.status).toBe(404);
    });

    it("returns the escrow by id", async () => {
      const app = freshApp();
      const created = await request(app).post("/escrow/create").send(validBody());
      const fetched = await request(app).get(`/escrow/${created.body.escrow.id}`);
      expect(fetched.status).toBe(200);
      expect(fetched.body.escrow.id).toBe(created.body.escrow.id);
    });

    it("lists by buyer", async () => {
      const app = freshApp();
      await request(app).post("/escrow/create").send(validBody());
      await request(app).post("/escrow/create").send(validBody({ memo: "second" }));
      const list = await request(app).get(`/escrow/by-buyer/${BUYER}`);
      expect(list.status).toBe(200);
      expect(list.body.escrows.length).toBe(2);
    });

    it("lists by recipient", async () => {
      const app = freshApp();
      await request(app).post("/escrow/create").send(validBody());
      const list = await request(app).get(`/escrow/by-recipient/${RECIPIENT}`);
      expect(list.status).toBe(200);
      expect(list.body.escrows.length).toBe(1);
    });
  });

  describe("release / refund", () => {
    it("refuses release when condition unmet", async () => {
      const app = freshApp(new Date("2025-01-01T00:00:00Z"));
      const created = await request(app).post("/escrow/create").send(validBody());
      const rel = await request(app).post(`/escrow/${created.body.escrow.id}/release`);
      expect(rel.status).toBe(400);
      expect(rel.body.error).toMatch(/condition not met/);
    });

    it("releases and emits a verifiable attestation when timestamp passes", async () => {
      const after = new Date("2030-06-01T00:00:00Z");
      const app = freshApp(after);
      const created = await request(app).post("/escrow/create").send(validBody());
      const rel = await request(app).post(`/escrow/${created.body.escrow.id}/release`);
      expect(rel.status).toBe(200);
      expect(rel.body.escrow.state).toBe("released");
      expect(verifyClaim(rel.body.attestation.claim, rel.body.attestation.signature)).toBe(true);
      expect(rel.body.attestation.claim.resolution).toBe("release");
    });

    it("releases on block_height when current block reaches target", async () => {
      const app = freshApp(new Date("2030-01-01T00:00:00Z"));
      setContextProviderForTesting(async () => ({
        now: new Date("2030-01-01T00:00:00Z"),
        currentBlock: 9999n,
      }));
      const created = await request(app)
        .post("/escrow/create")
        .send(
          validBody({
            condition_kind: "block_height",
            condition_value: "5000",
          }),
        );
      const rel = await request(app).post(`/escrow/${created.body.escrow.id}/release`);
      expect(rel.status).toBe(200);
      expect(rel.body.escrow.state).toBe("released");
    });

    it("refuses block_height release if currentBlock unknown", async () => {
      const app = freshApp(new Date("2030-01-01T00:00:00Z"));
      setContextProviderForTesting(async () => ({
        now: new Date("2030-01-01T00:00:00Z"),
      }));
      const created = await request(app)
        .post("/escrow/create")
        .send(
          validBody({
            condition_kind: "block_height",
            condition_value: "5000",
          }),
        );
      const rel = await request(app).post(`/escrow/${created.body.escrow.id}/release`);
      expect(rel.status).toBe(400);
    });

    it("releases on passport_binding when binding present", async () => {
      const app = freshApp(new Date("2030-01-01T00:00:00Z"));
      setContextProviderForTesting(async () => ({
        now: new Date("2030-01-01T00:00:00Z"),
        hasPassportBinding: () => true,
      }));
      const created = await request(app)
        .post("/escrow/create")
        .send(
          validBody({
            condition_kind: "passport_binding",
            condition_value: `${RECIPIENT}:ens:foo.eth`,
          }),
        );
      const rel = await request(app).post(`/escrow/${created.body.escrow.id}/release`);
      expect(rel.status).toBe(200);
    });

    it("refuses passport_binding release when binding absent", async () => {
      const app = freshApp(new Date("2030-01-01T00:00:00Z"));
      setContextProviderForTesting(async () => ({
        now: new Date("2030-01-01T00:00:00Z"),
        hasPassportBinding: () => false,
      }));
      const created = await request(app)
        .post("/escrow/create")
        .send(
          validBody({
            condition_kind: "passport_binding",
            condition_value: `${RECIPIENT}:ens:foo.eth`,
          }),
        );
      const rel = await request(app).post(`/escrow/${created.body.escrow.id}/release`);
      expect(rel.status).toBe(400);
    });

    it("refunds after deadline if not released, with verifiable attestation", async () => {
      const after = new Date("2031-01-01T00:00:00Z");
      const app = freshApp(after);
      const created = await request(app).post("/escrow/create").send(validBody());
      const ref = await request(app).post(`/escrow/${created.body.escrow.id}/refund`);
      expect(ref.status).toBe(200);
      expect(ref.body.escrow.state).toBe("refunded");
      expect(verifyClaim(ref.body.attestation.claim, ref.body.attestation.signature)).toBe(true);
      expect(ref.body.attestation.claim.resolution).toBe("refund");
    });

    it("refuses refund before deadline", async () => {
      const before = new Date("2025-01-01T00:00:00Z");
      const app = freshApp(before);
      const created = await request(app).post("/escrow/create").send(validBody());
      const ref = await request(app).post(`/escrow/${created.body.escrow.id}/refund`);
      expect(ref.status).toBe(400);
    });

    it("refuses double release", async () => {
      const after = new Date("2030-06-01T00:00:00Z");
      const app = freshApp(after);
      const created = await request(app).post("/escrow/create").send(validBody());
      await request(app).post(`/escrow/${created.body.escrow.id}/release`);
      const second = await request(app).post(`/escrow/${created.body.escrow.id}/release`);
      expect(second.status).toBe(400);
      expect(second.body.error).toMatch(/released/);
    });

    it("returns 404 for release of unknown escrow", async () => {
      const app = freshApp();
      const res = await request(app).post("/escrow/00000000-0000-0000-0000-000000000000/release");
      expect(res.status).toBe(404);
    });
  });
});
