import { describe, it, expect, beforeEach, afterAll } from "vitest";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { setDbForTesting, runMigrations, closeDb } from "../src/core/persist.js";
import {
  RANDOM_MIGRATIONS,
  createCommit,
  revealCommit,
  createSeal,
  tryUnlockSeal,
  createPool,
  registerForPool,
  listPoolMembers,
  recordPoolDraw,
} from "../src/products/random/state.js";

describe("random/state — sqlite-backed", () => {
  beforeEach(() => {
    closeDb();
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    setDbForTesting(db);
    runMigrations(RANDOM_MIGRATIONS);
  });

  afterAll(() => {
    closeDb();
  });

  describe("commit-reveal", () => {
    function commitFor(value: string, salt: string): string {
      return crypto
        .createHash("sha256")
        .update(Buffer.concat([Buffer.from(value, "utf8"), Buffer.from(salt, "utf8")]))
        .digest("hex");
    }

    it("creates a commit and rejects reveal with wrong preimage", () => {
      const c = createCommit({
        commitment: commitFor("hello", "saltA"),
        deadline: new Date(Date.now() + 60_000).toISOString(),
      });
      expect(c.state).toBe("committed");
      const r = revealCommit(c.id, "hello", "saltB"); // wrong salt
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/mismatch/);
    });

    it("accepts the correct preimage", () => {
      const c = createCommit({
        commitment: commitFor("hello", "saltA"),
        deadline: new Date(Date.now() + 60_000).toISOString(),
      });
      const r = revealCommit(c.id, "hello", "saltA");
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.row.state).toBe("revealed");
        expect(r.row.value).toBe("hello");
      }
    });

    it("rejects reveal after the deadline", () => {
      const c = createCommit({
        commitment: commitFor("v", "s"),
        deadline: new Date(Date.now() - 1_000).toISOString(),
      });
      const r = revealCommit(c.id, "v", "s");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/deadline/);
    });

    it("rejects double reveal", () => {
      const c = createCommit({
        commitment: commitFor("once", "salt"),
        deadline: new Date(Date.now() + 60_000).toISOString(),
      });
      const a = revealCommit(c.id, "once", "salt");
      const b = revealCommit(c.id, "once", "salt");
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(false);
    });

    // Review item #1: stored deadlines that are malformed must NOT be
    // treated as "in the past" (which would let revealers slip through).
    it("treats malformed stored deadline as not-yet-expired", () => {
      const c = createCommit({
        commitment: commitFor("v", "s"),
        deadline: "not-a-date",
      });
      const r = revealCommit(c.id, "v", "s");
      // Should NOT silently fail with "deadline passed" — the deadline check
      // bails out for unparsable values, and the commitment is valid, so the
      // reveal succeeds.
      expect(r.ok).toBe(true);
    });
  });

  describe("seal", () => {
    it("seals on timestamp condition; unlocks when time passes", () => {
      const past = new Date(Date.now() - 1_000).toISOString();
      const seal = createSeal({ ciphertext: "abc", unlock_kind: "timestamp", unlock_value: past });
      expect(seal.state).toBe("sealed");
      const unlocked = tryUnlockSeal(seal.id);
      expect(unlocked?.state).toBe("unlocked");
      expect(unlocked?.unlock_key).toBeTruthy();
    });

    it("does not unlock on future timestamp", () => {
      const future = new Date(Date.now() + 60_000).toISOString();
      const seal = createSeal({ ciphertext: "abc", unlock_kind: "timestamp", unlock_value: future });
      const result = tryUnlockSeal(seal.id);
      expect(result?.state).toBe("sealed");
      expect(result?.unlock_key).toBeNull();
    });

    it("unlocks block_height when currentBlock >= unlock_value", () => {
      const seal = createSeal({ ciphertext: "abc", unlock_kind: "block_height", unlock_value: "100" });
      expect(tryUnlockSeal(seal.id, { currentBlock: 50n })?.state).toBe("sealed");
      expect(tryUnlockSeal(seal.id, { currentBlock: 100n })?.state).toBe("unlocked");
    });

    // Review item #2: second concurrent tryUnlockSeal returns the already-
    // unlocked row idempotently rather than racing to a duplicate UPDATE.
    it("second tryUnlockSeal returns the already-unlocked row idempotently", () => {
      const past = new Date(Date.now() - 1_000).toISOString();
      const seal = createSeal({ ciphertext: "abc", unlock_kind: "timestamp", unlock_value: past });
      const a = tryUnlockSeal(seal.id);
      const b = tryUnlockSeal(seal.id);
      expect(a?.state).toBe("unlocked");
      expect(b?.state).toBe("unlocked");
      expect(b?.unlock_key).toBe(a?.unlock_key);
    });

    it("malformed unlock_value does not crash tryUnlockSeal", () => {
      const seal = createSeal({
        ciphertext: "abc",
        unlock_kind: "block_height",
        unlock_value: "not-a-number",
      });
      const r = tryUnlockSeal(seal.id, { currentBlock: 100n });
      expect(r?.state).toBe("sealed");
    });
  });

  describe("sortition", () => {
    it("creates a pool, registers members, and draws N", () => {
      const pool = createPool({ pool_name: "test", draw_at_block: 12345, count: 2 });
      const a = registerForPool(pool.id, "0x1111111111111111111111111111111111111111");
      const b = registerForPool(pool.id, "0x2222222222222222222222222222222222222222");
      const c = registerForPool(pool.id, "0x3333333333333333333333333333333333333333");
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      expect(c.ok).toBe(true);
      const members = listPoolMembers(pool.id);
      expect(members.length).toBe(3);
      const drawn = ["0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222"];
      const updated = recordPoolDraw(pool.id, drawn);
      expect(updated?.state).toBe("drawn");
      expect(JSON.parse(updated!.drawn_members!)).toEqual(drawn);
    });

    it("rejects duplicate registration", () => {
      const pool = createPool({ pool_name: "dup", draw_at_block: 1, count: 1 });
      const a = registerForPool(pool.id, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      const b = registerForPool(pool.id, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(false);
    });
  });
});
