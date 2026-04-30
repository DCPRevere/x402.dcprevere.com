import { describe, it, expect, beforeEach, afterAll } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { setDbForTesting, runMigrations, closeDb } from "../src/core/persist.js";
import { RANDOM_MIGRATIONS } from "../src/products/random/state.js";
import {
  randomProduct,
  setSortitionSeedForTesting,
  resetSortitionSeedForTesting,
} from "../src/products/random/router.js";

function freshApp(): Express {
  const app = express();
  app.use(express.json({ limit: "16kb" }));
  app.use("/random", randomProduct.router());
  return app;
}

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const C = "0x3333333333333333333333333333333333333333";

describe("/random/sortition (router)", () => {
  beforeEach(() => {
    closeDb();
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    setDbForTesting(db);
    runMigrations(RANDOM_MIGRATIONS);
    resetSortitionSeedForTesting();
  });

  afterAll(() => {
    closeDb();
  });

  it("rejects commitment shorter than 32 bytes (review #3)", async () => {
    const app = freshApp();
    const res = await request(app).post("/random/commit").send({
      commitment: "0xabcd",
      deadline: "2030-01-01T00:00:00Z",
    });
    expect(res.status).toBe(400);
  });

  it("rejects commitment with extra hex characters", async () => {
    const app = freshApp();
    const res = await request(app).post("/random/commit").send({
      commitment: "0x" + "ab".repeat(33), // 66 hex chars instead of 64
      deadline: "2030-01-01T00:00:00Z",
    });
    expect(res.status).toBe(400);
  });

  it("accepts commitment with or without 0x prefix", async () => {
    const app = freshApp();
    const sixtyFour = "ab".repeat(32);
    const a = await request(app).post("/random/commit").send({
      commitment: sixtyFour,
      deadline: "2030-01-01T00:00:00Z",
    });
    const b = await request(app).post("/random/commit").send({
      commitment: "0x" + sixtyFour,
      deadline: "2030-01-01T00:00:00Z",
    });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
  });

  it("uses the injected block-hash seed to draw (review #5)", async () => {
    const app = freshApp();
    // 32-byte deterministic seed.
    const fixedSeed = Buffer.alloc(32, 0xab);
    setSortitionSeedForTesting(async () => fixedSeed);

    const create = await request(app).post("/random/sortition").send({
      pool_name: "demo",
      draw_at_block: 999999,
      count: 2,
    });
    expect(create.status).toBe(201);
    const id = create.body.id;
    await request(app).post(`/random/sortition/${id}/register`).send({ wallet: A });
    await request(app).post(`/random/sortition/${id}/register`).send({ wallet: B });
    await request(app).post(`/random/sortition/${id}/register`).send({ wallet: C });

    const drawA = await request(app).post(`/random/sortition/${id}/draw`);
    expect(drawA.status).toBe(200);
    expect(drawA.body.seed).toBe(fixedSeed.toString("hex"));
    expect(drawA.body.seed_source).toBe("block_hash(999999)");
    expect(drawA.body.drawn.length).toBe(2);
  });

  it("returns 503 when block hash is unavailable (block not yet mined)", async () => {
    const app = freshApp();
    setSortitionSeedForTesting(async () => {
      throw new Error("block 999999 has no hash (not yet mined?)");
    });

    const create = await request(app).post("/random/sortition").send({
      pool_name: "future",
      draw_at_block: 999999,
      count: 1,
    });
    const id = create.body.id;
    await request(app).post(`/random/sortition/${id}/register`).send({ wallet: A });

    const draw = await request(app).post(`/random/sortition/${id}/draw`);
    expect(draw.status).toBe(503);
    expect(draw.body.retry_when).toContain("999999");
  });
});
