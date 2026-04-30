import crypto from "node:crypto";
import { runMigrations, getDb } from "../../core/persist.js";

/**
 * Persistence for /agora — public square. Three independent sub-surfaces share
 * one product slot:
 *
 *   board   — paid pinboard, append-only, public reads
 *   auction — sealed-bid auction with commit-reveal-finalize
 *   bar     — paid chatroom with rolling N-line history
 */

export const AGORA_MIGRATIONS = [
  // ----- Board -------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS agora_board_posts (
     id          TEXT PRIMARY KEY,
     author      TEXT NOT NULL,
     body        TEXT NOT NULL,
     posted_at   TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS agora_board_posted_idx ON agora_board_posts(posted_at)`,

  // ----- Auction -----------------------------------------------------
  `CREATE TABLE IF NOT EXISTS agora_auctions (
     id              TEXT PRIMARY KEY,
     seller          TEXT NOT NULL,
     description     TEXT NOT NULL,
     min_bid_usdc    TEXT NOT NULL,
     bid_deadline    TEXT NOT NULL,
     reveal_deadline TEXT NOT NULL,
     state           TEXT NOT NULL CHECK (state IN ('bidding','revealing','finalized','cancelled')),
     winner          TEXT,
     winning_bid     TEXT,
     finalized_at    TEXT,
     created_at      TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS agora_auctions_state_idx ON agora_auctions(state, bid_deadline)`,
  `CREATE TABLE IF NOT EXISTS agora_auction_bids (
     id           TEXT PRIMARY KEY,
     auction_id   TEXT NOT NULL,
     bidder       TEXT NOT NULL,
     commitment   TEXT NOT NULL,
     amount_usdc  TEXT,
     salt         TEXT,
     state        TEXT NOT NULL CHECK (state IN ('sealed','revealed','invalid')),
     placed_at    TEXT NOT NULL,
     revealed_at  TEXT,
     FOREIGN KEY (auction_id) REFERENCES agora_auctions(id) ON DELETE CASCADE,
     UNIQUE(auction_id, bidder)
   )`,
  `CREATE INDEX IF NOT EXISTS agora_bids_auction_idx ON agora_auction_bids(auction_id, state)`,

  // ----- Bar ---------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS agora_bar_lines (
     id        INTEGER PRIMARY KEY AUTOINCREMENT,
     speaker   TEXT NOT NULL,
     line      TEXT NOT NULL,
     spoken_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS agora_bar_id_idx ON agora_bar_lines(id)`,
];

export function ensureAgoraTables(): void {
  runMigrations(AGORA_MIGRATIONS);
}

// ----- Board ----------------------------------------------------------

export interface BoardPost {
  id: string;
  author: string;
  body: string;
  posted_at: string;
}

const MAX_BOARD_LIST = 100;

export function insertBoardPost(input: { author: string; body: string }): BoardPost {
  const id = crypto.randomUUID();
  const posted_at = new Date().toISOString();
  const row: BoardPost = {
    id,
    author: input.author.toLowerCase(),
    body: input.body,
    posted_at,
  };
  getDb()
    .prepare(`INSERT INTO agora_board_posts (id, author, body, posted_at) VALUES (?, ?, ?, ?)`)
    .run(row.id, row.author, row.body, row.posted_at);
  return row;
}

export function listBoardPosts(limit = 50): BoardPost[] {
  const n = Math.max(1, Math.min(MAX_BOARD_LIST, Math.floor(limit)));
  return getDb()
    .prepare(`SELECT * FROM agora_board_posts ORDER BY posted_at DESC LIMIT ?`)
    .all(n) as BoardPost[];
}

export function getBoardPost(id: string): BoardPost | null {
  return (
    (getDb().prepare(`SELECT * FROM agora_board_posts WHERE id = ?`).get(id) as
      | BoardPost
      | undefined) ?? null
  );
}

// ----- Auction --------------------------------------------------------

export type AuctionState = "bidding" | "revealing" | "finalized" | "cancelled";

export interface AuctionRow {
  id: string;
  seller: string;
  description: string;
  min_bid_usdc: string;
  bid_deadline: string;
  reveal_deadline: string;
  state: AuctionState;
  winner: string | null;
  winning_bid: string | null;
  finalized_at: string | null;
  created_at: string;
}

export type BidState = "sealed" | "revealed" | "invalid";

export interface BidRow {
  id: string;
  auction_id: string;
  bidder: string;
  commitment: string;
  amount_usdc: string | null;
  salt: string | null;
  state: BidState;
  placed_at: string;
  revealed_at: string | null;
}

export function createAuction(input: {
  seller: string;
  description: string;
  min_bid_usdc: string;
  bid_deadline: string;
  reveal_deadline: string;
}): AuctionRow {
  const id = crypto.randomUUID();
  const created_at = new Date().toISOString();
  const row: AuctionRow = {
    id,
    seller: input.seller.toLowerCase(),
    description: input.description,
    min_bid_usdc: input.min_bid_usdc,
    bid_deadline: input.bid_deadline,
    reveal_deadline: input.reveal_deadline,
    state: "bidding",
    winner: null,
    winning_bid: null,
    finalized_at: null,
    created_at,
  };
  getDb()
    .prepare(
      `INSERT INTO agora_auctions
        (id, seller, description, min_bid_usdc, bid_deadline, reveal_deadline, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'bidding', ?)`,
    )
    .run(
      row.id,
      row.seller,
      row.description,
      row.min_bid_usdc,
      row.bid_deadline,
      row.reveal_deadline,
      row.created_at,
    );
  return row;
}

export function getAuction(id: string): AuctionRow | null {
  return (
    (getDb().prepare(`SELECT * FROM agora_auctions WHERE id = ?`).get(id) as
      | AuctionRow
      | undefined) ?? null
  );
}

export function setAuctionState(id: string, state: AuctionState): AuctionRow | null {
  getDb().prepare(`UPDATE agora_auctions SET state = ? WHERE id = ?`).run(state, id);
  return getAuction(id);
}

/**
 * Atomically cancel an auction iff it's still in the bidding phase. Returns
 * the updated row, or null if the auction has already advanced (or doesn't
 * exist).
 */
export function cancelAuctionIfBidding(id: string): AuctionRow | null {
  const result = getDb()
    .prepare(`UPDATE agora_auctions SET state = 'cancelled' WHERE id = ? AND state = 'bidding'`)
    .run(id);
  if (result.changes === 0) return null;
  return getAuction(id);
}

export function placeBid(input: {
  auction_id: string;
  bidder: string;
  commitment: string;
}): { ok: true; bid: BidRow } | { ok: false; reason: string } {
  const id = crypto.randomUUID();
  const placed_at = new Date().toISOString();
  const row: BidRow = {
    id,
    auction_id: input.auction_id,
    bidder: input.bidder.toLowerCase(),
    commitment: input.commitment.toLowerCase(),
    amount_usdc: null,
    salt: null,
    state: "sealed",
    placed_at,
    revealed_at: null,
  };
  try {
    getDb()
      .prepare(
        `INSERT INTO agora_auction_bids (id, auction_id, bidder, commitment, state, placed_at)
         VALUES (?, ?, ?, ?, 'sealed', ?)`,
      )
      .run(row.id, row.auction_id, row.bidder, row.commitment, row.placed_at);
  } catch (err) {
    if (String(err).includes("UNIQUE")) {
      return { ok: false, reason: "bidder already has a bid in this auction" };
    }
    throw err;
  }
  return { ok: true, bid: row };
}

export function getBid(auctionId: string, bidder: string): BidRow | null {
  return (
    (getDb()
      .prepare(`SELECT * FROM agora_auction_bids WHERE auction_id = ? AND bidder = ?`)
      .get(auctionId, bidder.toLowerCase()) as BidRow | undefined) ?? null
  );
}

export function listBids(auctionId: string): BidRow[] {
  return getDb()
    .prepare(`SELECT * FROM agora_auction_bids WHERE auction_id = ? ORDER BY placed_at`)
    .all(auctionId) as BidRow[];
}

export function recordReveal(input: {
  auction_id: string;
  bidder: string;
  amount_usdc: string;
  salt: string;
  valid: boolean;
}): BidRow | null {
  const now = new Date().toISOString();
  const newState: BidState = input.valid ? "revealed" : "invalid";
  const result = getDb()
    .prepare(
      `UPDATE agora_auction_bids
        SET state = ?, amount_usdc = ?, salt = ?, revealed_at = ?
        WHERE auction_id = ? AND bidder = ? AND state = 'sealed'`,
    )
    .run(newState, input.amount_usdc, input.salt, now, input.auction_id, input.bidder.toLowerCase());
  if (result.changes === 0) return null;
  return getBid(input.auction_id, input.bidder);
}

export function finalizeAuction(input: {
  id: string;
  winner: string | null;
  winning_bid: string | null;
}): AuctionRow | null {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `UPDATE agora_auctions
        SET state = 'finalized', winner = ?, winning_bid = ?, finalized_at = ?
        WHERE id = ? AND state IN ('bidding','revealing')`,
    )
    .run(input.winner, input.winning_bid, now, input.id);
  return getAuction(input.id);
}

// ----- Bar ------------------------------------------------------------

export interface BarLine {
  id: number;
  speaker: string;
  line: string;
  spoken_at: string;
}

export function insertBarLine(input: { speaker: string; line: string }): BarLine {
  const spoken_at = new Date().toISOString();
  const result = getDb()
    .prepare(`INSERT INTO agora_bar_lines (speaker, line, spoken_at) VALUES (?, ?, ?)`)
    .run(input.speaker.toLowerCase(), input.line, spoken_at);
  return {
    id: Number(result.lastInsertRowid),
    speaker: input.speaker.toLowerCase(),
    line: input.line,
    spoken_at,
  };
}

export function listBarLinesSince(cursor: number, limit = 100): BarLine[] {
  const n = Math.max(1, Math.min(500, Math.floor(limit)));
  return getDb()
    .prepare(`SELECT * FROM agora_bar_lines WHERE id > ? ORDER BY id LIMIT ?`)
    .all(cursor, n) as BarLine[];
}

export function listBarLinesRecent(limit = 50): BarLine[] {
  const n = Math.max(1, Math.min(500, Math.floor(limit)));
  return getDb()
    .prepare(`SELECT * FROM agora_bar_lines ORDER BY id DESC LIMIT ?`)
    .all(n) as BarLine[];
}

export function pruneBarLines(keep: number): number {
  if (!Number.isInteger(keep) || keep <= 0) return 0;
  const result = getDb()
    .prepare(
      `DELETE FROM agora_bar_lines
        WHERE id <= (SELECT COALESCE(MAX(id) - ?, 0) FROM agora_bar_lines)`,
    )
    .run(keep);
  return result.changes;
}

/**
 * Per-speaker line count over the last `windowMs` ms. Used to enforce a
 * fairness quota so a single chatty wallet can't monopolise the bar buffer.
 *
 * Fixes review item #24.
 */
export function countBarLinesBySpeakerSince(speaker: string, sinceIso: string): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM agora_bar_lines WHERE speaker = ? AND spoken_at >= ?`)
    .get(speaker.toLowerCase(), sinceIso) as { n: number };
  return row.n;
}

export function totalBarLines(): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM agora_bar_lines`).get() as { n: number };
  return row.n;
}
