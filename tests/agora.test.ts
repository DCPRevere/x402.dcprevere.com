import { describe, it, expect, beforeEach, afterAll } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { setDbForTesting, runMigrations, closeDb } from "../src/core/persist.js";
import { AGORA_MIGRATIONS } from "../src/products/agora/state.js";
import {
  agoraProduct,
  agoraPreValidator,
  bidCommitment,
  setClockForTesting,
  resetClockForTesting,
} from "../src/products/agora/router.js";
import { resetSecretForTesting, verifyClaim } from "../src/core/sign.js";

const SELLER = "0x1111111111111111111111111111111111111111";
const ALICE = "0x2222222222222222222222222222222222222222";
const BOB = "0x3333333333333333333333333333333333333333";
const CAROL = "0x4444444444444444444444444444444444444444";

function freshApp(): Express {
  const app = express();
  app.use(express.json({ limit: "16kb" }));
  app.use("/agora", agoraPreValidator);
  app.use("/agora", agoraProduct.router());
  return app;
}

describe("/agora", () => {
  beforeEach(() => {
    closeDb();
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    setDbForTesting(db);
    runMigrations(AGORA_MIGRATIONS);
    resetSecretForTesting("test-secret-of-sufficient-length");
    resetClockForTesting();
  });

  afterAll(() => {
    closeDb();
  });

  // ===== /agora/board =================================================
  describe("board", () => {
    it("rejects post with bad author", async () => {
      const app = freshApp();
      const res = await request(app)
        .post("/agora/board/post")
        .send({ author: "not-an-address", body: "hi" });
      expect(res.status).toBe(400);
    });

    it("rejects post with empty body", async () => {
      const app = freshApp();
      const res = await request(app)
        .post("/agora/board/post")
        .send({ author: SELLER, body: "" });
      expect(res.status).toBe(400);
    });

    it("rejects oversized body", async () => {
      const app = freshApp();
      const res = await request(app)
        .post("/agora/board/post")
        .send({ author: SELLER, body: "x".repeat(513) });
      expect(res.status).toBe(400);
    });

    it("posts and lists in reverse-chrono order", async () => {
      const app = freshApp();
      const a = await request(app)
        .post("/agora/board/post")
        .send({ author: SELLER, body: "first" });
      expect(a.status).toBe(201);
      const b = await request(app)
        .post("/agora/board/post")
        .send({ author: SELLER, body: "second" });
      expect(b.status).toBe(201);
      const list = await request(app).get("/agora/board");
      expect(list.status).toBe(200);
      expect(list.body.posts.length).toBe(2);
      // Reverse-chrono: newest first.
      expect(list.body.posts[0].body).toBe("second");
    });

    it("respects ?limit", async () => {
      const app = freshApp();
      for (let i = 0; i < 3; i++) {
        await request(app).post("/agora/board/post").send({ author: SELLER, body: `m${i}` });
      }
      const res = await request(app).get("/agora/board?limit=2");
      expect(res.body.posts.length).toBe(2);
    });

    it("rejects limit outside 1..100", async () => {
      const app = freshApp();
      const a = await request(app).get("/agora/board?limit=0");
      expect(a.status).toBe(400);
      const b = await request(app).get("/agora/board?limit=999");
      expect(b.status).toBe(400);
    });

    it("returns single post by id", async () => {
      const app = freshApp();
      const created = await request(app)
        .post("/agora/board/post")
        .send({ author: SELLER, body: "hello" });
      const got = await request(app).get(`/agora/board/${created.body.post.id}`);
      expect(got.status).toBe(200);
      expect(got.body.post.body).toBe("hello");
    });

    it("404 for unknown post", async () => {
      const app = freshApp();
      const res = await request(app).get("/agora/board/does-not-exist");
      expect(res.status).toBe(404);
    });
  });

  // ===== /agora/auction ===============================================
  describe("auction", () => {
    const FAR_FUTURE_BID = "2030-06-01T00:00:00Z";
    const FAR_FUTURE_REVEAL = "2030-07-01T00:00:00Z";

    function validAuction(overrides: Record<string, unknown> = {}) {
      return {
        seller: SELLER,
        description: "A widget",
        min_bid_usdc: "1000",
        bid_deadline: FAR_FUTURE_BID,
        reveal_deadline: FAR_FUTURE_REVEAL,
        ...overrides,
      };
    }

    it("creates an auction in bidding state", async () => {
      const app = freshApp();
      const res = await request(app).post("/agora/auction/create").send(validAuction());
      expect(res.status).toBe(201);
      expect(res.body.auction.state).toBe("bidding");
    });

    it("rejects reveal_deadline <= bid_deadline", async () => {
      const app = freshApp();
      const res = await request(app)
        .post("/agora/auction/create")
        .send(validAuction({ reveal_deadline: FAR_FUTURE_BID }));
      expect(res.status).toBe(400);
    });

    it("rejects past bid_deadline", async () => {
      const app = freshApp();
      const res = await request(app)
        .post("/agora/auction/create")
        .send(validAuction({ bid_deadline: "2020-01-01T00:00:00Z" }));
      expect(res.status).toBe(400);
    });

    it("rejects bid with bad commitment", async () => {
      const app = freshApp();
      const auc = await request(app).post("/agora/auction/create").send(validAuction());
      const res = await request(app)
        .post(`/agora/auction/${auc.body.auction.id}/bid`)
        .send({ bidder: ALICE, commitment: "short" });
      expect(res.status).toBe(400);
    });

    it("places a sealed bid", async () => {
      const app = freshApp();
      const auc = await request(app).post("/agora/auction/create").send(validAuction());
      const commitment = bidCommitment("5000", "salt-a", ALICE);
      const res = await request(app)
        .post(`/agora/auction/${auc.body.auction.id}/bid`)
        .send({ bidder: ALICE, commitment });
      expect(res.status).toBe(201);
      expect(res.body.bid.state).toBe("sealed");
    });

    it("forbids duplicate bids from same wallet", async () => {
      const app = freshApp();
      const auc = await request(app).post("/agora/auction/create").send(validAuction());
      const c1 = bidCommitment("5000", "salt-a", ALICE);
      const c2 = bidCommitment("6000", "salt-b", ALICE);
      await request(app).post(`/agora/auction/${auc.body.auction.id}/bid`).send({ bidder: ALICE, commitment: c1 });
      const second = await request(app)
        .post(`/agora/auction/${auc.body.auction.id}/bid`)
        .send({ bidder: ALICE, commitment: c2 });
      expect(second.status).toBe(409);
    });

    it("forbids the seller from bidding", async () => {
      const app = freshApp();
      const auc = await request(app).post("/agora/auction/create").send(validAuction());
      const c = bidCommitment("5000", "s", SELLER);
      const res = await request(app)
        .post(`/agora/auction/${auc.body.auction.id}/bid`)
        .send({ bidder: SELLER, commitment: c });
      expect(res.status).toBe(400);
    });

    it("rejects bid after bid_deadline", async () => {
      const app = freshApp();
      const auc = await request(app).post("/agora/auction/create").send(validAuction());
      // Advance the clock past the bid deadline.
      setClockForTesting(() => new Date("2030-06-15T00:00:00Z"));
      const c = bidCommitment("5000", "s", ALICE);
      const res = await request(app)
        .post(`/agora/auction/${auc.body.auction.id}/bid`)
        .send({ bidder: ALICE, commitment: c });
      expect(res.status).toBe(400);
    });

    it("reveals a bid in the reveal window", async () => {
      const app = freshApp();
      const auc = await request(app).post("/agora/auction/create").send(validAuction());
      const c = bidCommitment("5000", "salt-a", ALICE);
      await request(app).post(`/agora/auction/${auc.body.auction.id}/bid`).send({ bidder: ALICE, commitment: c });
      // Step into the reveal window.
      setClockForTesting(() => new Date("2030-06-15T00:00:00Z"));
      const reveal = await request(app)
        .post(`/agora/auction/${auc.body.auction.id}/reveal`)
        .send({ bidder: ALICE, amount_usdc: "5000", salt: "salt-a" });
      expect(reveal.status).toBe(200);
      expect(reveal.body.bid.state).toBe("revealed");
      expect(reveal.body.bid.amount_usdc).toBe("5000");
    });

    it("marks reveal invalid on commitment mismatch", async () => {
      const app = freshApp();
      const auc = await request(app).post("/agora/auction/create").send(validAuction());
      const c = bidCommitment("5000", "salt-a", ALICE);
      await request(app).post(`/agora/auction/${auc.body.auction.id}/bid`).send({ bidder: ALICE, commitment: c });
      setClockForTesting(() => new Date("2030-06-15T00:00:00Z"));
      const reveal = await request(app)
        .post(`/agora/auction/${auc.body.auction.id}/reveal`)
        .send({ bidder: ALICE, amount_usdc: "9999", salt: "wrong-salt" });
      expect(reveal.status).toBe(400);
      expect(reveal.body.bid.state).toBe("invalid");
    });

    it("finalizes after reveal window picking the highest bid, with attestation", async () => {
      const app = freshApp();
      const auc = await request(app).post("/agora/auction/create").send(validAuction());
      const id = auc.body.auction.id;

      const cAlice = bidCommitment("5000", "sa", ALICE);
      const cBob = bidCommitment("8000", "sb", BOB);
      const cCarol = bidCommitment("100", "sc", CAROL); // below min_bid
      await request(app).post(`/agora/auction/${id}/bid`).send({ bidder: ALICE, commitment: cAlice });
      await request(app).post(`/agora/auction/${id}/bid`).send({ bidder: BOB, commitment: cBob });
      await request(app).post(`/agora/auction/${id}/bid`).send({ bidder: CAROL, commitment: cCarol });

      setClockForTesting(() => new Date("2030-06-15T00:00:00Z"));
      await request(app)
        .post(`/agora/auction/${id}/reveal`)
        .send({ bidder: ALICE, amount_usdc: "5000", salt: "sa" });
      await request(app)
        .post(`/agora/auction/${id}/reveal`)
        .send({ bidder: BOB, amount_usdc: "8000", salt: "sb" });
      await request(app)
        .post(`/agora/auction/${id}/reveal`)
        .send({ bidder: CAROL, amount_usdc: "100", salt: "sc" });

      // After reveal window
      setClockForTesting(() => new Date("2030-08-01T00:00:00Z"));
      const finalised = await request(app).post(`/agora/auction/${id}/finalize`);
      expect(finalised.status).toBe(200);
      expect(finalised.body.auction.state).toBe("finalized");
      expect(finalised.body.auction.winner).toBe(BOB.toLowerCase());
      expect(finalised.body.auction.winning_bid).toBe("8000");
      expect(verifyClaim(finalised.body.attestation.claim, finalised.body.attestation.signature)).toBe(true);
    });

    it("finalize is idempotent", async () => {
      const app = freshApp();
      const auc = await request(app).post("/agora/auction/create").send(validAuction());
      const id = auc.body.auction.id;
      const c = bidCommitment("5000", "s", ALICE);
      await request(app).post(`/agora/auction/${id}/bid`).send({ bidder: ALICE, commitment: c });
      setClockForTesting(() => new Date("2030-06-15T00:00:00Z"));
      await request(app)
        .post(`/agora/auction/${id}/reveal`)
        .send({ bidder: ALICE, amount_usdc: "5000", salt: "s" });
      setClockForTesting(() => new Date("2030-08-01T00:00:00Z"));
      const a = await request(app).post(`/agora/auction/${id}/finalize`);
      const b = await request(app).post(`/agora/auction/${id}/finalize`);
      expect(a.body.auction.winner).toBe(b.body.auction.winner);
    });

    it("finalize with no valid reveals returns null winner", async () => {
      const app = freshApp();
      const auc = await request(app).post("/agora/auction/create").send(validAuction());
      const id = auc.body.auction.id;
      // Two bids, both below min.
      const cAlice = bidCommitment("100", "sa", ALICE);
      await request(app).post(`/agora/auction/${id}/bid`).send({ bidder: ALICE, commitment: cAlice });
      setClockForTesting(() => new Date("2030-06-15T00:00:00Z"));
      await request(app)
        .post(`/agora/auction/${id}/reveal`)
        .send({ bidder: ALICE, amount_usdc: "100", salt: "sa" });
      setClockForTesting(() => new Date("2030-08-01T00:00:00Z"));
      const finalised = await request(app).post(`/agora/auction/${id}/finalize`);
      expect(finalised.body.auction.winner).toBeNull();
      expect(finalised.body.auction.winning_bid).toBeNull();
    });

    it("rejects finalize before reveal window closes", async () => {
      const app = freshApp();
      const auc = await request(app).post("/agora/auction/create").send(validAuction());
      const id = auc.body.auction.id;
      // Set clock to AFTER bid_deadline but BEFORE reveal_deadline.
      setClockForTesting(() => new Date("2030-06-15T00:00:00Z"));
      const res = await request(app).post(`/agora/auction/${id}/finalize`);
      expect(res.status).toBe(400);
    });

    // Review item #10: GET on a finalized auction includes the signed
    // attestation, so anyone (not just whoever called /finalize) can fetch
    // the receipt.
    it("GET on a finalized auction includes the attestation", async () => {
      const app = freshApp();
      const auc = await request(app).post("/agora/auction/create").send(validAuction());
      const id = auc.body.auction.id;
      const c = bidCommitment("5000", "s", ALICE);
      await request(app).post(`/agora/auction/${id}/bid`).send({ bidder: ALICE, commitment: c });
      setClockForTesting(() => new Date("2030-06-15T00:00:00Z"));
      await request(app)
        .post(`/agora/auction/${id}/reveal`)
        .send({ bidder: ALICE, amount_usdc: "5000", salt: "s" });
      setClockForTesting(() => new Date("2030-08-01T00:00:00Z"));
      const finalised = await request(app).post(`/agora/auction/${id}/finalize`);
      const fetched = await request(app).get(`/agora/auction/${id}`);
      expect(fetched.body.attestation.signature).toBe(finalised.body.attestation.signature);
    });

    // Review item #8: finalize during the bid window must NOT mutate state
    // before returning 400. Confirm by reading state back.
    it("400 finalize during bidding does not advance state", async () => {
      const app = freshApp();
      const auc = await request(app).post("/agora/auction/create").send(validAuction());
      const id = auc.body.auction.id;
      const res = await request(app).post(`/agora/auction/${id}/finalize`);
      expect(res.status).toBe(400);
      const state = await request(app).get(`/agora/auction/${id}`);
      expect(state.body.auction.state).toBe("bidding");
    });

    it("hides the bid book during the bidding phase, exposes during reveal", async () => {
      const app = freshApp();
      const auc = await request(app).post("/agora/auction/create").send(validAuction());
      const id = auc.body.auction.id;
      const c = bidCommitment("5000", "s", ALICE);
      await request(app).post(`/agora/auction/${id}/bid`).send({ bidder: ALICE, commitment: c });

      const duringBid = await request(app).get(`/agora/auction/${id}`);
      expect(duringBid.body.bids).toBeUndefined();

      setClockForTesting(() => new Date("2030-06-15T00:00:00Z"));
      await request(app)
        .post(`/agora/auction/${id}/reveal`)
        .send({ bidder: ALICE, amount_usdc: "5000", salt: "s" });

      const duringReveal = await request(app).get(`/agora/auction/${id}`);
      expect(Array.isArray(duringReveal.body.bids)).toBe(true);
    });
  });

  // ===== /agora/bar ===================================================
  describe("bar", () => {
    it("speaks a line and tails the bar", async () => {
      const app = freshApp();
      const a = await request(app).post("/agora/bar/say").send({ speaker: SELLER, line: "first" });
      expect(a.status).toBe(201);
      const tail = await request(app).get("/agora/bar?limit=10");
      expect(tail.body.lines.length).toBe(1);
      expect(tail.body.lines[0].line).toBe("first");
    });

    it("rejects line longer than 256 chars", async () => {
      const app = freshApp();
      const res = await request(app)
        .post("/agora/bar/say")
        .send({ speaker: SELLER, line: "x".repeat(257) });
      expect(res.status).toBe(400);
    });

    it("rejects bad speaker address", async () => {
      const app = freshApp();
      const res = await request(app)
        .post("/agora/bar/say")
        .send({ speaker: "bad", line: "hi" });
      expect(res.status).toBe(400);
    });

    it("returns lines newer than ?since cursor", async () => {
      const app = freshApp();
      const a = await request(app).post("/agora/bar/say").send({ speaker: SELLER, line: "a" });
      const cursor = a.body.line.id;
      await request(app).post("/agora/bar/say").send({ speaker: SELLER, line: "b" });
      await request(app).post("/agora/bar/say").send({ speaker: SELLER, line: "c" });
      const since = await request(app).get(`/agora/bar?since=${cursor}`);
      expect(since.status).toBe(200);
      expect(since.body.lines.length).toBe(2);
      expect(since.body.lines.map((l: { line: string }) => l.line)).toEqual(["b", "c"]);
    });

    it("rejects bad since cursor", async () => {
      const app = freshApp();
      const res = await request(app).get("/agora/bar?since=-5");
      expect(res.status).toBe(400);
    });

    it("rejects limit outside 1..500", async () => {
      const app = freshApp();
      const a = await request(app).get("/agora/bar?limit=0");
      expect(a.status).toBe(400);
      const b = await request(app).get("/agora/bar?limit=999");
      expect(b.status).toBe(400);
    });

    // Review item #24: a single chatty wallet can't monopolise the buffer.
    it("enforces a per-speaker quota of 60 lines/minute", async () => {
      const app = freshApp();
      // 60 sayings should succeed.
      for (let i = 0; i < 60; i++) {
        const res = await request(app).post("/agora/bar/say").send({ speaker: SELLER, line: `m${i}` });
        expect(res.status).toBe(201);
      }
      // 61st should be 429.
      const blocked = await request(app)
        .post("/agora/bar/say")
        .send({ speaker: SELLER, line: "one too many" });
      expect(blocked.status).toBe(429);
      // A different speaker is unaffected.
      const other = await request(app)
        .post("/agora/bar/say")
        .send({ speaker: ALICE, line: "I am new" });
      expect(other.status).toBe(201);
    });
  });
});
