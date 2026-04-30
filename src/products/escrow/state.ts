import crypto from "node:crypto";
import { runMigrations, getDb } from "../../core/persist.js";

/**
 * Persistence for /escrow.
 *
 * An escrow is a server-issued *attestation* that some condition was met (or
 * the deadline passed without it). We do not custody funds — downstream
 * contracts can honour the signed receipts, but for the v1 demo the value
 * being escrowed is the buyer's seed payment plus the descriptive payload.
 */

export const ESCROW_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS escrow_holdings (
     id              TEXT PRIMARY KEY,
     buyer           TEXT NOT NULL,
     recipient       TEXT NOT NULL,
     amount_usdc     TEXT NOT NULL,
     condition_kind  TEXT NOT NULL CHECK (condition_kind IN ('block_height','timestamp','passport_binding','commit_revealed')),
     condition_value TEXT NOT NULL,
     deadline        TEXT NOT NULL,
     memo            TEXT,
     state           TEXT NOT NULL CHECK (state IN ('open','released','refunded')),
     resolution      TEXT,
     resolved_at     TEXT,
     created_at      TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS escrow_buyer_idx ON escrow_holdings(buyer, state)`,
  `CREATE INDEX IF NOT EXISTS escrow_recipient_idx ON escrow_holdings(recipient, state)`,
  `CREATE INDEX IF NOT EXISTS escrow_state_idx ON escrow_holdings(state, deadline)`,
];

export function ensureEscrowTables(): void {
  runMigrations(ESCROW_MIGRATIONS);
}

export type EscrowConditionKind =
  | "block_height"
  | "timestamp"
  | "passport_binding"
  | "commit_revealed";

export type EscrowState = "open" | "released" | "refunded";

export interface EscrowRow {
  id: string;
  buyer: string;
  recipient: string;
  amount_usdc: string;
  condition_kind: EscrowConditionKind;
  condition_value: string;
  deadline: string;
  memo: string | null;
  state: EscrowState;
  resolution: string | null;
  resolved_at: string | null;
  created_at: string;
}

export function createEscrow(input: {
  buyer: string;
  recipient: string;
  amount_usdc: string;
  condition_kind: EscrowConditionKind;
  condition_value: string;
  deadline: string;
  memo?: string;
}): EscrowRow {
  const id = crypto.randomUUID();
  const created_at = new Date().toISOString();
  const row: EscrowRow = {
    id,
    buyer: input.buyer.toLowerCase(),
    recipient: input.recipient.toLowerCase(),
    amount_usdc: input.amount_usdc,
    condition_kind: input.condition_kind,
    condition_value: input.condition_value,
    deadline: input.deadline,
    memo: input.memo ?? null,
    state: "open",
    resolution: null,
    resolved_at: null,
    created_at,
  };
  getDb()
    .prepare(
      `INSERT INTO escrow_holdings
        (id, buyer, recipient, amount_usdc, condition_kind, condition_value, deadline, memo, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
    )
    .run(
      row.id,
      row.buyer,
      row.recipient,
      row.amount_usdc,
      row.condition_kind,
      row.condition_value,
      row.deadline,
      row.memo,
      row.created_at,
    );
  return row;
}

export function getEscrow(id: string): EscrowRow | null {
  return (
    (getDb().prepare(`SELECT * FROM escrow_holdings WHERE id = ?`).get(id) as
      | EscrowRow
      | undefined) ?? null
  );
}

export function listEscrowsByBuyer(buyer: string): EscrowRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM escrow_holdings WHERE buyer = ? ORDER BY created_at DESC LIMIT 200`,
    )
    .all(buyer.toLowerCase()) as EscrowRow[];
}

export function listEscrowsByRecipient(recipient: string): EscrowRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM escrow_holdings WHERE recipient = ? ORDER BY created_at DESC LIMIT 200`,
    )
    .all(recipient.toLowerCase()) as EscrowRow[];
}

export function markReleased(id: string, resolution: string): EscrowRow | null {
  const now = new Date().toISOString();
  const result = getDb()
    .prepare(
      `UPDATE escrow_holdings SET state = 'released', resolution = ?, resolved_at = ?
        WHERE id = ? AND state = 'open'`,
    )
    .run(resolution, now, id);
  if (result.changes === 0) return null;
  return getEscrow(id);
}

export function markRefunded(id: string, resolution: string): EscrowRow | null {
  const now = new Date().toISOString();
  const result = getDb()
    .prepare(
      `UPDATE escrow_holdings SET state = 'refunded', resolution = ?, resolved_at = ?
        WHERE id = ? AND state = 'open'`,
    )
    .run(resolution, now, id);
  if (result.changes === 0) return null;
  return getEscrow(id);
}
