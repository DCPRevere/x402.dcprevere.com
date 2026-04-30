import crypto from "node:crypto";
import { runMigrations, getDb } from "../../core/persist.js";

/**
 * Persistence for /wire — paid messaging inboxes.
 *
 * An inbox is owned by a wallet that holds a server-issued `owner_token`.
 * Senders (anyone) pay to drop messages in. The owner polls to drain the
 * queue. Inboxes can be closed; closed inboxes reject sends with 410.
 *
 * Owner authentication uses an HMAC over the inbox id + a per-inbox secret —
 * presented as a bearer token. Server stores only the secret, not the token.
 */

export const WIRE_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS wire_inboxes (
     id            TEXT PRIMARY KEY,
     owner_wallet  TEXT NOT NULL,
     owner_secret  TEXT NOT NULL,
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
  owner_secret: string;
  state: InboxState;
  created_at: string;
  closed_at: string | null;
}

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

export function createInbox(input: { owner_wallet: string }): {
  inbox: Omit<InboxRow, "owner_secret">;
  owner_token: string;
} {
  const id = crypto.randomUUID();
  const secret = crypto.randomBytes(32).toString("hex");
  const created_at = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO wire_inboxes (id, owner_wallet, owner_secret, state, created_at)
       VALUES (?, ?, ?, 'open', ?)`,
    )
    .run(id, input.owner_wallet.toLowerCase(), secret, created_at);
  return {
    inbox: {
      id,
      owner_wallet: input.owner_wallet.toLowerCase(),
      state: "open",
      created_at,
      closed_at: null,
    },
    owner_token: deriveOwnerToken(id, secret),
  };
}

function deriveOwnerToken(inboxId: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(inboxId).digest("hex");
}

export function getInboxRow(id: string): InboxRow | null {
  return (
    (getDb().prepare(`SELECT * FROM wire_inboxes WHERE id = ?`).get(id) as
      | InboxRow
      | undefined) ?? null
  );
}

export function getInboxPublic(id: string): Omit<InboxRow, "owner_secret"> | null {
  const row = getInboxRow(id);
  if (!row) return null;
  // Strip the secret before returning to a non-owner.
  const { owner_secret: _omit, ...rest } = row;
  void _omit;
  return rest;
}

export function authenticateOwner(inboxId: string, presentedToken: string): InboxRow | null {
  const row = getInboxRow(inboxId);
  if (!row) return null;
  const expected = deriveOwnerToken(row.id, row.owner_secret);
  if (expected.length !== presentedToken.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(presentedToken, "hex"))) {
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

export function pollMessages(inboxId: string, max: number): MessageRow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM wire_messages WHERE inbox_id = ? AND state = 'queued'
        ORDER BY queued_at ASC LIMIT ?`,
    )
    .all(inboxId, max) as MessageRow[];
  if (rows.length === 0) return [];
  const now = new Date().toISOString();
  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => "?").join(",");
  getDb()
    .prepare(
      `UPDATE wire_messages SET state = 'delivered', delivered_at = ? WHERE id IN (${placeholders})`,
    )
    .run(now, ...ids);
  return rows.map((r) => ({ ...r, state: "delivered" as const, delivered_at: now }));
}
