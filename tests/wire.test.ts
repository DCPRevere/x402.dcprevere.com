import { describe, it, expect, beforeEach, afterAll } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { setDbForTesting, runMigrations, closeDb } from "../src/core/persist.js";
import { WIRE_MIGRATIONS } from "../src/products/wire/state.js";
import { wireProduct, wirePreValidator } from "../src/products/wire/router.js";

const OWNER = "0x1111111111111111111111111111111111111111";
const SENDER = "0x2222222222222222222222222222222222222222";

function freshApp(): Express {
  const app = express();
  app.use(express.json({ limit: "16kb" }));
  app.use("/wire", wirePreValidator);
  app.use("/wire", wireProduct.router());
  return app;
}

async function makeInbox(app: Express) {
  const res = await request(app).post("/wire/inbox").send({ owner_wallet: OWNER });
  return { id: res.body.inbox.id as string, token: res.body.owner_token as string };
}

describe("/wire", () => {
  beforeEach(() => {
    closeDb();
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    setDbForTesting(db);
    runMigrations(WIRE_MIGRATIONS);
  });

  afterAll(() => {
    closeDb();
  });

  describe("inbox creation", () => {
    it("creates an inbox with a hex owner_token", async () => {
      const app = freshApp();
      const res = await request(app).post("/wire/inbox").send({ owner_wallet: OWNER });
      expect(res.status).toBe(201);
      expect(res.body.inbox.state).toBe("open");
      expect(res.body.owner_token).toMatch(/^[0-9a-f]{64}$/);
    });

    it("rejects bad owner_wallet", async () => {
      const app = freshApp();
      const res = await request(app)
        .post("/wire/inbox")
        .send({ owner_wallet: "not-an-address" });
      expect(res.status).toBe(400);
    });

    it("does not leak owner_secret in GET", async () => {
      const app = freshApp();
      const { id } = await makeInbox(app);
      const res = await request(app).get(`/wire/inbox/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.inbox.owner_secret).toBeUndefined();
      expect(res.body.queued).toBe(0);
    });

    it("returns 404 for unknown inbox", async () => {
      const app = freshApp();
      const res = await request(app).get("/wire/inbox/does-not-exist");
      expect(res.status).toBe(404);
    });
  });

  describe("send (paid validation)", () => {
    it("rejects send without body", async () => {
      const app = freshApp();
      const { id } = await makeInbox(app);
      const res = await request(app).post(`/wire/inbox/${id}/send`).send();
      expect(res.status).toBe(400);
    });

    it("rejects send with bad sender", async () => {
      const app = freshApp();
      const { id } = await makeInbox(app);
      const res = await request(app)
        .post(`/wire/inbox/${id}/send`)
        .send({ from: "bad", body: "hi" });
      expect(res.status).toBe(400);
    });

    it("rejects oversized body", async () => {
      const app = freshApp();
      const { id } = await makeInbox(app);
      const big = "x".repeat(8 * 1024 + 1);
      const res = await request(app)
        .post(`/wire/inbox/${id}/send`)
        .send({ from: SENDER, body: big });
      expect(res.status).toBe(400);
    });

    it("rejects send to unknown inbox", async () => {
      const app = freshApp();
      const res = await request(app)
        .post("/wire/inbox/does-not-exist/send")
        .send({ from: SENDER, body: "hi" });
      expect(res.status).toBe(404);
    });

    it("accepts a valid send and queues the message", async () => {
      const app = freshApp();
      const { id } = await makeInbox(app);
      const res = await request(app)
        .post(`/wire/inbox/${id}/send`)
        .send({ from: SENDER, body: "hello" });
      expect(res.status).toBe(201);
      expect(typeof res.body.message.id).toBe("string");
      const meta = await request(app).get(`/wire/inbox/${id}`);
      expect(meta.body.queued).toBe(1);
    });
  });

  describe("poll", () => {
    it("rejects poll without owner token", async () => {
      const app = freshApp();
      const { id } = await makeInbox(app);
      const res = await request(app).post(`/wire/inbox/${id}/poll`).send({});
      expect(res.status).toBe(401);
    });

    it("rejects poll with wrong token", async () => {
      const app = freshApp();
      const { id } = await makeInbox(app);
      const res = await request(app)
        .post(`/wire/inbox/${id}/poll`)
        .set("X-Wire-Owner-Token", "0".repeat(64))
        .send({});
      expect(res.status).toBe(403);
    });

    it("returns queued messages and marks them delivered", async () => {
      const app = freshApp();
      const { id, token } = await makeInbox(app);
      await request(app)
        .post(`/wire/inbox/${id}/send`)
        .send({ from: SENDER, body: "first" });
      await request(app)
        .post(`/wire/inbox/${id}/send`)
        .send({ from: SENDER, body: "second" });

      const drain = await request(app)
        .post(`/wire/inbox/${id}/poll`)
        .set("X-Wire-Owner-Token", token)
        .send({});
      expect(drain.status).toBe(200);
      expect(drain.body.messages.length).toBe(2);
      expect(drain.body.messages[0].body).toBe("first");
      expect(drain.body.messages[1].body).toBe("second");
      expect(drain.body.remaining).toBe(0);

      const drainAgain = await request(app)
        .post(`/wire/inbox/${id}/poll`)
        .set("X-Wire-Owner-Token", token)
        .send({});
      expect(drainAgain.body.messages.length).toBe(0);
    });

    it("respects max", async () => {
      const app = freshApp();
      const { id, token } = await makeInbox(app);
      for (let i = 0; i < 5; i++) {
        await request(app)
          .post(`/wire/inbox/${id}/send`)
          .send({ from: SENDER, body: `m${i}` });
      }
      const first = await request(app)
        .post(`/wire/inbox/${id}/poll`)
        .set("X-Wire-Owner-Token", token)
        .send({ max: 2 });
      expect(first.body.messages.length).toBe(2);
      expect(first.body.remaining).toBe(3);
    });

    it("rejects max outside 1..100", async () => {
      const app = freshApp();
      const { id, token } = await makeInbox(app);
      const a = await request(app)
        .post(`/wire/inbox/${id}/poll`)
        .set("X-Wire-Owner-Token", token)
        .send({ max: 0 });
      expect(a.status).toBe(400);
      const b = await request(app)
        .post(`/wire/inbox/${id}/poll`)
        .set("X-Wire-Owner-Token", token)
        .send({ max: 101 });
      expect(b.status).toBe(400);
    });
  });

  describe("close", () => {
    it("closes the inbox and rejects further sends with 410", async () => {
      const app = freshApp();
      const { id, token } = await makeInbox(app);
      const close = await request(app)
        .post(`/wire/inbox/${id}/close`)
        .set("X-Wire-Owner-Token", token)
        .send({});
      expect(close.status).toBe(200);
      expect(close.body.inbox.state).toBe("closed");

      const send = await request(app)
        .post(`/wire/inbox/${id}/send`)
        .send({ from: SENDER, body: "rejected" });
      expect(send.status).toBe(410);
    });

    it("idempotent close returns the closed inbox", async () => {
      const app = freshApp();
      const { id, token } = await makeInbox(app);
      await request(app)
        .post(`/wire/inbox/${id}/close`)
        .set("X-Wire-Owner-Token", token)
        .send({});
      const second = await request(app)
        .post(`/wire/inbox/${id}/close`)
        .set("X-Wire-Owner-Token", token)
        .send({});
      expect(second.status).toBe(200);
      expect(second.body.inbox.state).toBe("closed");
    });

    it("close requires owner token", async () => {
      const app = freshApp();
      const { id } = await makeInbox(app);
      const res = await request(app).post(`/wire/inbox/${id}/close`).send({});
      expect(res.status).toBe(401);
    });
  });
});
