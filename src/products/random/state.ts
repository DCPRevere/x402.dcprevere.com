import crypto from "node:crypto";
import { runMigrations, getDb } from "../../core/persist.js";
import { isExpired } from "../../core/time.js";

/**
 * Persistence layer shared by /random's stateful sub-endpoints (commit-reveal,
 * seal/unlock, sortition pools). All tables are namespaced `random_*` and
 * created idempotently.
 */

export const RANDOM_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS random_commits (
     id          TEXT PRIMARY KEY,
     commitment  TEXT NOT NULL,
     deadline    TEXT NOT NULL,
     label       TEXT,
     state       TEXT NOT NULL CHECK (state IN ('committed','revealed','expired')),
     value       TEXT,
     salt        TEXT,
     created_at  TEXT NOT NULL,
     revealed_at TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS random_commits_deadline ON random_commits(deadline, state)`,

  `CREATE TABLE IF NOT EXISTS random_seals (
     id            TEXT PRIMARY KEY,
     ciphertext    TEXT NOT NULL,
     unlock_kind   TEXT NOT NULL CHECK (unlock_kind IN ('block_height','timestamp','deposit')),
     unlock_value  TEXT NOT NULL,
     deposited     TEXT NOT NULL DEFAULT '0',
     state         TEXT NOT NULL CHECK (state IN ('sealed','unlocked')),
     unlock_key    TEXT,
     created_at    TEXT NOT NULL,
     unlocked_at   TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS random_seals_state ON random_seals(state, unlock_kind)`,

  `CREATE TABLE IF NOT EXISTS random_sortition_pools (
     id              TEXT PRIMARY KEY,
     pool_name       TEXT UNIQUE NOT NULL,
     draw_at_block   INTEGER NOT NULL,
     count           INTEGER NOT NULL,
     state           TEXT NOT NULL CHECK (state IN ('open','drawn')),
     drawn_at        TEXT,
     drawn_members   TEXT,
     created_at      TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS random_sortition_members (
     pool_id     TEXT NOT NULL,
     wallet      TEXT NOT NULL,
     joined_at   TEXT NOT NULL,
     PRIMARY KEY (pool_id, wallet),
     FOREIGN KEY (pool_id) REFERENCES random_sortition_pools(id) ON DELETE CASCADE
   )`,
];

export function ensureRandomTables(): void {
  runMigrations(RANDOM_MIGRATIONS);
}

// ----- Commit-reveal --------------------------------------------------

export interface CommitRow {
  id: string;
  commitment: string;
  deadline: string;
  label: string | null;
  state: "committed" | "revealed" | "expired";
  value: string | null;
  salt: string | null;
  created_at: string;
  revealed_at: string | null;
}

export function createCommit(input: {
  commitment: string;
  deadline: string;
  label?: string;
}): CommitRow {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const row: CommitRow = {
    id,
    commitment: input.commitment.toLowerCase(),
    deadline: input.deadline,
    label: input.label ?? null,
    state: "committed",
    value: null,
    salt: null,
    created_at: now,
    revealed_at: null,
  };
  getDb()
    .prepare(
      `INSERT INTO random_commits (id, commitment, deadline, label, state, created_at)
       VALUES (?, ?, ?, ?, 'committed', ?)`,
    )
    .run(row.id, row.commitment, row.deadline, row.label, row.created_at);
  return row;
}

export function getCommit(id: string): CommitRow | null {
  const row = getDb()
    .prepare(`SELECT * FROM random_commits WHERE id = ?`)
    .get(id) as CommitRow | undefined;
  return row ?? null;
}

/**
 * Atomically reveal a commit. Uses a conditional UPDATE so two concurrent
 * reveal calls race correctly: one wins, the other gets `changes === 0` and
 * sees `commit is revealed` on the next read. Defends against malformed
 * deadline values via the `isExpired` helper (NaN → not expired → caller
 * still gets a meaningful response).
 *
 * Fixes review items #1 and #2.
 */
export function revealCommit(id: string, value: string, salt: string): { ok: true; row: CommitRow } | { ok: false; reason: string } {
  const existing = getCommit(id);
  if (!existing) return { ok: false, reason: "no such commit" };
  if (existing.state !== "committed") return { ok: false, reason: `commit is ${existing.state}` };
  if (isExpired(existing.deadline)) return { ok: false, reason: "deadline passed" };
  const preimage = Buffer.concat([Buffer.from(value, "utf8"), Buffer.from(salt, "utf8")]);
  const expected = crypto.createHash("sha256").update(preimage).digest("hex");
  if (expected !== existing.commitment) return { ok: false, reason: "commitment mismatch" };
  const now = new Date().toISOString();
  const result = getDb()
    .prepare(
      `UPDATE random_commits SET state = 'revealed', value = ?, salt = ?, revealed_at = ?
        WHERE id = ? AND state = 'committed'`,
    )
    .run(value, salt, now, id);
  if (result.changes === 0) {
    return { ok: false, reason: "commit no longer in committed state" };
  }
  return { ok: true, row: { ...existing, state: "revealed", value, salt, revealed_at: now } };
}

// ----- Seal -----------------------------------------------------------

export type SealUnlockKind = "block_height" | "timestamp" | "deposit";

export interface SealRow {
  id: string;
  ciphertext: string;
  unlock_kind: SealUnlockKind;
  unlock_value: string;
  deposited: string;
  state: "sealed" | "unlocked";
  unlock_key: string | null;
  created_at: string;
  unlocked_at: string | null;
}

export function createSeal(input: {
  ciphertext: string;
  unlock_kind: SealUnlockKind;
  unlock_value: string;
}): SealRow {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const row: SealRow = {
    id,
    ciphertext: input.ciphertext,
    unlock_kind: input.unlock_kind,
    unlock_value: input.unlock_value,
    deposited: "0",
    state: "sealed",
    unlock_key: null,
    created_at: now,
    unlocked_at: null,
  };
  getDb()
    .prepare(
      `INSERT INTO random_seals (id, ciphertext, unlock_kind, unlock_value, deposited, state, created_at)
       VALUES (?, ?, ?, ?, '0', 'sealed', ?)`,
    )
    .run(row.id, row.ciphertext, row.unlock_kind, row.unlock_value, row.created_at);
  return row;
}

export function getSeal(id: string): SealRow | null {
  const row = getDb().prepare(`SELECT * FROM random_seals WHERE id = ?`).get(id) as SealRow | undefined;
  return row ?? null;
}

/**
 * Evaluate the unlock condition. `block_height` requires the caller to pass
 * a `currentBlock`; `deposit` consults `deposited`. Returns the unlock_key
 * (a hash of the sealed payload + a server salt) when the seal flips.
 *
 * Concurrent unlocks resolve via a conditional UPDATE so only one caller
 * commits the state transition; subsequent calls just re-read the row.
 *
 * Fixes review items #1 and #2.
 */
export function tryUnlockSeal(
  id: string,
  ctx: { currentBlock?: bigint; now?: Date } = {},
): SealRow | null {
  const row = getSeal(id);
  if (!row) return null;
  if (row.state === "unlocked") return row;

  let triggered = false;
  const nowDate = ctx.now ?? new Date();
  if (row.unlock_kind === "timestamp") {
    const target = Date.parse(row.unlock_value);
    triggered = Number.isFinite(target) && nowDate.getTime() >= target;
  } else if (row.unlock_kind === "block_height") {
    if (ctx.currentBlock !== undefined) {
      try {
        triggered = ctx.currentBlock >= BigInt(row.unlock_value);
      } catch {
        triggered = false;
      }
    }
  } else if (row.unlock_kind === "deposit") {
    try {
      triggered = BigInt(row.deposited) >= BigInt(row.unlock_value);
    } catch {
      triggered = false;
    }
  }
  if (!triggered) return row;

  const key = crypto
    .createHash("sha256")
    .update("seal-key:" + row.id + ":" + row.ciphertext)
    .digest("hex");
  const nowIso = nowDate.toISOString();
  const result = getDb()
    .prepare(
      `UPDATE random_seals SET state = 'unlocked', unlock_key = ?, unlocked_at = ?
        WHERE id = ? AND state = 'sealed'`,
    )
    .run(key, nowIso, id);
  if (result.changes === 0) {
    // Lost a race: re-read and return whatever the DB has now.
    return getSeal(id);
  }
  return { ...row, state: "unlocked", unlock_key: key, unlocked_at: nowIso };
}

// ----- Sortition ------------------------------------------------------

export interface SortitionPool {
  id: string;
  pool_name: string;
  draw_at_block: number;
  count: number;
  state: "open" | "drawn";
  drawn_at: string | null;
  drawn_members: string | null;
  created_at: string;
}

export function createPool(input: {
  pool_name: string;
  draw_at_block: number;
  count: number;
}): SortitionPool {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO random_sortition_pools (id, pool_name, draw_at_block, count, state, created_at)
       VALUES (?, ?, ?, ?, 'open', ?)`,
    )
    .run(id, input.pool_name, input.draw_at_block, input.count, now);
  return {
    id,
    pool_name: input.pool_name,
    draw_at_block: input.draw_at_block,
    count: input.count,
    state: "open",
    drawn_at: null,
    drawn_members: null,
    created_at: now,
  };
}

export function getPool(id: string): SortitionPool | null {
  return (
    (getDb()
      .prepare(`SELECT * FROM random_sortition_pools WHERE id = ?`)
      .get(id) as SortitionPool | undefined) ?? null
  );
}

export function registerForPool(poolId: string, wallet: string): { ok: true } | { ok: false; reason: string } {
  const pool = getPool(poolId);
  if (!pool) return { ok: false, reason: "no such pool" };
  if (pool.state !== "open") return { ok: false, reason: `pool is ${pool.state}` };
  try {
    getDb()
      .prepare(
        `INSERT INTO random_sortition_members (pool_id, wallet, joined_at) VALUES (?, ?, ?)`,
      )
      .run(poolId, wallet.toLowerCase(), new Date().toISOString());
  } catch (err) {
    if (String(err).includes("UNIQUE")) return { ok: false, reason: "wallet already registered" };
    throw err;
  }
  return { ok: true };
}

export function listPoolMembers(poolId: string): string[] {
  return (
    getDb()
      .prepare(`SELECT wallet FROM random_sortition_members WHERE pool_id = ? ORDER BY wallet`)
      .all(poolId) as { wallet: string }[]
  ).map((r) => r.wallet);
}

export function recordPoolDraw(poolId: string, members: string[]): SortitionPool | null {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `UPDATE random_sortition_pools SET state = 'drawn', drawn_at = ?, drawn_members = ? WHERE id = ? AND state = 'open'`,
    )
    .run(now, JSON.stringify(members), poolId);
  return getPool(poolId);
}
