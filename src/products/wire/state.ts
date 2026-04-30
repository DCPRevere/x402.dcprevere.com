import crypto from "node:crypto";
import { runMigrations, getDb } from "../../core/persist.js";

/**
 * Persistence for /wire — paid messaging inboxes.
 *
 * Owner authentication: on inbox creation we generate a 32-byte token, return
 * it to the caller, and store *only its sha256 hash* in the DB. A DB dump
 * doesn't reveal any owner_token, fixing review item #13.
 *
 * Polling is atomic: the dequeue uses `UPDATE ... WHERE id IN (subquery)
 * RETURNING *` semantics emulated through a single transaction so two
 * concurrent pollers can't double-deliver the same messages (review item #23).
 */

export const WIRE_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS wire_inboxes (
     id            TEXT PRIMARY KEY,
     owner_wallet  TEXT NOT NULL,
     owner_token_hash TEXT NOT NULL,
     state         TEXT NOT NULL CHECK (state IN ('open','closed')),
     created_at    TEXT NOT NULL,
     closed_at     TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS wire_inbox_owner_idx ON wire_inboxes(owner_wallet)`,
  `CREATE TABLE IF NOT EXISTS wire_messages (
     id           TEXT PRIMARY KEY,
     inbox_id     TEXT NOT NULL,
     sender       TEXT NOT NULL,
     body         TEXT NOT NULL,
     reply_to     TEXT,
     state        TEXT NOT NULL CHECK (state IN ('queued','delivered')),
     queued_at    TEXT NOT NULL,
     delivered_at TEXT,
     FOREIGN KEY (inbox_id) REFERENCES wire_inboxes(id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS wire_messages_idx ON wire_messages(inbox_id, state, queued_at)`,
];

export function ensureWireTables(): void {
  runMigrations(WIRE_MIGRATIONS);
}

export type InboxState = "open" | "closed";

export interface InboxRow {
  id: string;
  owner_wallet: string;
  owner_token_hash: string;
  state: InboxState;
  created_at: string;
  closed_at: string | null;
}

export type PublicInbox = Omit<InboxRow, "owner_token_hash">;

export type MessageState = "queued" | "delivered";

export interface MessageRow {
  id: string;
  inbox_id: string;
  sender: string;
  body: string;
  reply_to: string | null;
  state: MessageState;
  queued_at: string;
  delivered_at: string | null;
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token, "hex").digest("hex");
}

export function createInbox(input: { owner_wallet: string }): {
  inbox: PublicInbox;
  owner_token: string;
} {
  const id = crypto.randomUUID();
  const owner_token = crypto.randomBytes(32).toString("hex");
  const created_at = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO wire_inboxes (id, owner_wallet, owner_token_hash, state, created_at)
       VALUES (?, ?, ?, 'open', ?)`,
    )
    .run(id, input.owner_wallet.toLowerCase(), hashToken(owner_token), created_at);
  return {
    inbox: {
      id,
      owner_wallet: input.owner_wallet.toLowerCase(),
      state: "open",
      created_at,
      closed_at: null,
    },
    owner_token,
  };
}

export function getInboxRow(id: string): InboxRow | null {
  return (
    (getDb().prepare(`SELECT * FROM wire_inboxes WHERE id = ?`).get(id) as
      | InboxRow
      | undefined) ?? null
  );
}

export function getInboxPublic(id: string): PublicInbox | null {
  const row = getInboxRow(id);
  if (!row) return null;
  const { owner_token_hash, ...rest } = row;
  void owner_token_hash; // documented exclusion; intentionally unused
  return rest;
}

export function authenticateOwner(inboxId: string, presentedToken: string): InboxRow | null {
  const row = getInboxRow(inboxId);
  if (!row) return null;
  const expectedHash = row.owner_token_hash;
  let presentedHash: string;
  try {
    presentedHash = hashToken(presentedToken);
  } catch {
    return null;
  }
  try {
    if (
      !crypto.timingSafeEqual(Buffer.from(expectedHash, "hex"), Buffer.from(presentedHash, "hex"))
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return row;
}

export function closeInbox(id: string): InboxRow | null {
  const now = new Date().toISOString();
  const result = getDb()
    .prepare(`UPDATE wire_inboxes SET state = 'closed', closed_at = ? WHERE id = ? AND state = 'open'`)
    .run(now, id);
  if (result.changes === 0) return null;
  return getInboxRow(id);
}

export function enqueueMessage(input: {
  inbox_id: string;
  sender: string;
  body: string;
  reply_to?: string;
}): MessageRow {
  const id = crypto.randomUUID();
  const queued_at = new Date().toISOString();
  const row: MessageRow = {
    id,
    inbox_id: input.inbox_id,
    sender: input.sender.toLowerCase(),
    body: input.body,
    reply_to: input.reply_to ?? null,
    state: "queued",
    queued_at,
    delivered_at: null,
  };
  getDb()
    .prepare(
      `INSERT INTO wire_messages (id, inbox_id, sender, body, reply_to, state, queued_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?)`,
    )
    .run(row.id, row.inbox_id, row.sender, row.body, row.reply_to, row.queued_at);
  return row;
}

export function countQueued(inboxId: string): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM wire_messages WHERE inbox_id = ? AND state = 'queued'`)
    .get(inboxId) as { n: number };
  return row.n;
}

/**
 * Drain up to `max` queued messages atomically. The SELECT + UPDATE runs in a
 * single transaction so two concurrent pollers can't both claim the same
 * rows. Each row is moved from `queued` to `delivered` and returned.
 */
export function pollMessages(inboxId: string, max: number): MessageRow[] {
  const db = getDb();
  return db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT * FROM wire_messages WHERE inbox_id = ? AND state = 'queued'
          ORDER BY queued_at ASC LIMIT ?`,
      )
      .all(inboxId, max) as MessageRow[];
    if (rows.length === 0) return [];
    const now = new Date().toISOString();
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    db
      .prepare(
        `UPDATE wire_messages SET state = 'delivered', delivered_at = ?
          WHERE id IN (${placeholders}) AND state = 'queued'`,
      )
      .run(now, ...ids);
    return rows.map((r) => ({ ...r, state: "delivered" as const, delivered_at: now }));
  })();
}
