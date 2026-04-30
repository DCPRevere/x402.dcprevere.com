import { describe, it, expect, beforeEach, afterAll } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import Database from "better-sqlite3";
import {
  setDbForTesting,
  runMigrations,
  closeDb,
} from "../src/core/persist.js";
import {
  PASSPORT_MIGRATIONS,
} from "../src/products/passport/state.js";
import {
  passportProduct,
  setVerifierForTesting,
} from "../src/products/passport/router.js";
import { resetSecretForTesting, verifyClaim } from "../src/core/sign.js";
import { checkSolution } from "../src/products/passport/captcha.js";
import { mineSolution } from "./helpers/mine.js";

function freshApp(): Express {
  const app = express();
  app.use("/passport", passportProduct.router());
  return app;
}

const WALLET = "0x1111111111111111111111111111111111111111";

describe("/passport", () => {
  beforeEach(() => {
    closeDb();
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    setDbForTesting(db);
    runMigrations(PASSPORT_MIGRATIONS);
    resetSecretForTesting("test-secret-of-sufficient-length");
  });

  afterAll(() => {
    closeDb();
  });

  describe("bind", () => {
    it("rejects non-address wallet", async () => {
      const app = freshApp();
      const res = await request(app).post("/passport/bind").send({
        wallet: "not-an-address",
        anchor_kind: "ens",
        anchor_value: "foo.eth",
      });
      expect(res.status).toBe(400);
    });

    it("records an unverified binding when no verifier confirms", async () => {
      setVerifierForTesting(async () => ({ verified: false, detail: "no resolver" }));
      const app = freshApp();
      const res = await request(app).post("/passport/bind").send({
        wallet: WALLET,
        anchor_kind: "ens",
        anchor_value: "foo.eth",
      });
      expect(res.status).toBe(201);
      expect(res.body.binding.verified).toBe(0);
      expect(res.body.binding.signature).toMatch(/^[0-9a-f]{64}$/);
    });

    it("issues a signed verified binding when verifier confirms", async () => {
      setVerifierForTesting(async () => ({ verified: true, detail: "ok" }));
      const app = freshApp();
      const res = await request(app).post("/passport/bind").send({
        wallet: WALLET,
        anchor_kind: "ens",
        anchor_value: "foo.eth",
      });
      expect(res.status).toBe(201);
      expect(res.body.binding.verified).toBe(1);

      const claim = {
        wallet: WALLET.toLowerCase(),
        anchor_kind: "ens",
        anchor_value: "foo.eth",
        verified: 1,
        issued_at: res.body.binding.issued_at,
        expires_at: res.body.binding.expires_at,
      };
      expect(verifyClaim(claim, res.body.binding.signature)).toBe(true);
    });

    it("returns the active bindings for a wallet", async () => {
      setVerifierForTesting(async () => ({ verified: true, detail: "ok" }));
      const app = freshApp();
      await request(app).post("/passport/bind").send({
        wallet: WALLET,
        anchor_kind: "ens",
        anchor_value: "foo.eth",
      });
      const res = await request(app).get(`/passport/bind/${WALLET}`);
      expect(res.status).toBe(200);
      expect(res.body.bindings.length).toBe(1);
      expect(res.body.bindings[0].anchor_value).toBe("foo.eth");
    });
  });

  describe("anti-captcha", () => {
    it("issues a challenge with the requested difficulty", async () => {
      const app = freshApp();
      const res = await request(app)
        .post("/passport/anti-captcha/challenge")
        .send({ wallet: WALLET, difficulty: 14 });
      expect(res.status).toBe(201);
      expect(res.body.difficulty).toBe(14);
      expect(typeof res.body.nonce).toBe("string");
    });

    it("rejects difficulty outside [12, 28]", async () => {
      const app = freshApp();
      const a = await request(app)
        .post("/passport/anti-captcha/challenge")
        .send({ wallet: WALLET, difficulty: 5 });
      const b = await request(app)
        .post("/passport/anti-captcha/challenge")
        .send({ wallet: WALLET, difficulty: 60 });
      expect(a.status).toBe(400);
      expect(b.status).toBe(400);
    });

    it("rejects an invalid solution", async () => {
      const app = freshApp();
      const issue = await request(app)
        .post("/passport/anti-captcha/challenge")
        .send({ wallet: WALLET, difficulty: 12 });
      const solve = await request(app)
        .post("/passport/anti-captcha/solve")
        .send({ challenge_id: issue.body.id, solution: "garbage" });
      expect(solve.status).toBe(400);
    });

    it("issues a signed pass for a valid solution", async () => {
      const app = freshApp();
      // Use difficulty 12 — keeps mining fast in CI.
      const issue = await request(app)
        .post("/passport/anti-captcha/challenge")
        .send({ wallet: WALLET, difficulty: 12 });
      const solution = mineSolution(issue.body.nonce, 12);
      expect(checkSolution(issue.body.nonce, solution, 12)).toBe(true);

      const solve = await request(app)
        .post("/passport/anti-captcha/solve")
        .send({ challenge_id: issue.body.id, solution });
      expect(solve.status).toBe(201);
      expect(solve.body.pass.signature).toMatch(/^[0-9a-f]{64}$/);
      expect(verifyClaim(solve.body.claim, solve.body.pass.signature)).toBe(true);
    });

    it("rejects a second solve of the same challenge", async () => {
      const app = freshApp();
      const issue = await request(app)
        .post("/passport/anti-captcha/challenge")
        .send({ wallet: WALLET, difficulty: 12 });
      const solution = mineSolution(issue.body.nonce, 12);
      await request(app)
        .post("/passport/anti-captcha/solve")
        .send({ challenge_id: issue.body.id, solution });
      const second = await request(app)
        .post("/passport/anti-captcha/solve")
        .send({ challenge_id: issue.body.id, solution });
      expect(second.status).toBe(400);
    });

    it("lists active passes for the wallet", async () => {
      const app = freshApp();
      const issue = await request(app)
        .post("/passport/anti-captcha/challenge")
        .send({ wallet: WALLET, difficulty: 12 });
      const solution = mineSolution(issue.body.nonce, 12);
      await request(app)
        .post("/passport/anti-captcha/solve")
        .send({ challenge_id: issue.body.id, solution });
      const list = await request(app).get(`/passport/anti-captcha/passes/${WALLET}`);
      expect(list.status).toBe(200);
      expect(list.body.passes.length).toBe(1);
    });
  });
});

describe("captcha primitives", () => {
  it("checkSolution rejects below-target hashes", () => {
    expect(checkSolution("00".repeat(16), "x", 8)).toBe(false);
  });

  it("mineSolution finds a valid solution at moderate difficulty", () => {
    const nonce = "deadbeef".repeat(4);
    const sol = mineSolution(nonce, 12);
    expect(checkSolution(nonce, sol, 12)).toBe(true);
  });
});
