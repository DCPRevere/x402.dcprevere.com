import crypto from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import { signClaim } from "../../core/sign.js";
import {
  ensureAgoraTables,
  insertBoardPost,
  listBoardPosts,
  getBoardPost,
  createAuction,
  getAuction,
  setAuctionState,
  placeBid,
  getBid,
  listBids,
  recordReveal,
  finalizeAuction,
  insertBarLine,
  listBarLinesSince,
  listBarLinesRecent,
  pruneBarLines,
  countBarLinesBySpeakerSince,
  type AuctionRow,
} from "./state.js";
import { agoraHelp } from "./help.js";
import type { Product } from "../../core/product.js";

const SLUG = "agora";

const BOARD_BODY_MAX = 512;
const BAR_LINE_MAX = 256;
const BAR_KEEP = 5000;
const BAR_PRUNE_EVERY = 100;
const BAR_PER_SPEAKER_LIMIT = 60;
const BAR_PER_SPEAKER_WINDOW_MS = 60_000;
const AUCTION_DESCRIPTION_MAX = 1024;

let barInsertCounter = 0;

// ----- Pluggable clock (tests inject) ---------------------------------

let clock: () => Date = () => new Date();
export function setClockForTesting(fn: () => Date): void {
  clock = fn;
}
export function resetClockForTesting(): void {
  clock = () => new Date();
}

// ----- Pre-validator --------------------------------------------------

/**
 * Runs at app level (mounted under /agora). Pre-validates the three paid
 * endpoints so buyers never pay for malformed input. Path is product-relative
 * (i.e. doesn't include the `/agora` prefix when the validator runs after the
 * app.use mount with that prefix — verified by figpay's preValidator pattern).
 *
 * However, the figlet preValidator examined `req.path === "/figlet/render"` —
 * the FULL path, because the validator was registered with `app.use(v)` (no
 * mount path). Our server.ts uses `app.use("/<slug>", v)` for preValidators,
 * so `req.path` here is product-relative. Match accordingly.
 */
export function agoraPreValidator(req: Request, res: Response, next: NextFunction) {
  if (req.method === "POST" && req.path === "/board/post") {
    if (!req.body || typeof req.body !== "object") {
      res.status(400).json({ error: "JSON body required" });
      return;
    }
    const body = req.body as Record<string, unknown>;
    const author = typeof body.author === "string" ? body.author : "";
    const text = typeof body.body === "string" ? body.body : "";
    if (!/^0x[0-9a-fA-F]{40}$/.test(author)) {
      res.status(400).json({ error: "author must be a 0x-prefixed 20-byte hex address" });
      return;
    }
    if (!text || Buffer.byteLength(text, "utf8") > BOARD_BODY_MAX) {
      res.status(400).json({ error: `body required, max ${BOARD_BODY_MAX} bytes` });
      return;
    }
    return next();
  }
  if (req.method === "POST" && req.path === "/auction/create") {
    if (!req.body || typeof req.body !== "object") {
      res.status(400).json({ error: "JSON body required" });
      return;
    }
    const body = req.body as Record<string, unknown>;
    const seller = typeof body.seller === "string" ? body.seller : "";
    const description = typeof body.description === "string" ? body.description : "";
    const min_bid_usdc = typeof body.min_bid_usdc === "string" ? body.min_bid_usdc : "";
    const bid_deadline = typeof body.bid_deadline === "string" ? body.bid_deadline : "";
    const reveal_deadline = typeof body.reveal_deadline === "string" ? body.reveal_deadline : "";

    if (!/^0x[0-9a-fA-F]{40}$/.test(seller)) {
      res.status(400).json({ error: "seller must be a 0x-prefixed 20-byte hex address" });
      return;
    }
    if (!description || Buffer.byteLength(description, "utf8") > AUCTION_DESCRIPTION_MAX) {
      res.status(400).json({ error: `description required, max ${AUCTION_DESCRIPTION_MAX} bytes` });
      return;
    }
    if (!/^\d+$/.test(min_bid_usdc) || min_bid_usdc === "0") {
      res.status(400).json({ error: "min_bid_usdc must be a positive base-units integer" });
      return;
    }
    const bidMs = Date.parse(bid_deadline);
    const revealMs = Date.parse(reveal_deadline);
    if (!Number.isFinite(bidMs) || !Number.isFinite(revealMs)) {
      res.status(400).json({ error: "bid_deadline and reveal_deadline must be ISO 8601" });
      return;
    }
    if (bidMs <= clock().getTime()) {
      res.status(400).json({ error: "bid_deadline must be in the future" });
      return;
    }
    if (revealMs <= bidMs) {
      res.status(400).json({ error: "reveal_deadline must be after bid_deadline" });
      return;
    }
    return next();
  }

  const bidMatch = req.path.match(/^\/auction\/([^/]+)\/bid$/);
  if (req.method === "POST" && bidMatch) {
    if (!req.body || typeof req.body !== "object") {
      res.status(400).json({ error: "JSON body required" });
      return;
    }
    const body = req.body as Record<string, unknown>;
    const bidder = typeof body.bidder === "string" ? body.bidder : "";
    const commitment = typeof body.commitment === "string" ? body.commitment : "";

    if (!/^0x[0-9a-fA-F]{40}$/.test(bidder)) {
      res.status(400).json({ error: "bidder must be a 0x-prefixed 20-byte hex address" });
      return;
    }
    const cleaned = commitment.replace(/^0x/, "");
    if (!/^[0-9a-fA-F]{64}$/.test(cleaned)) {
      res.status(400).json({ error: "commitment must be 32 bytes of hex" });
      return;
    }
    const auction = getAuction(bidMatch[1]);
    if (!auction) {
      res.status(404).json({ error: "no such auction" });
      return;
    }
    if (auction.state !== "bidding") {
      res.status(400).json({ error: `auction is ${auction.state}` });
      return;
    }
    if (Date.parse(auction.bid_deadline) <= clock().getTime()) {
      res.status(400).json({ error: "bidding window closed" });
      return;
    }
    return next();
  }

  if (req.method === "POST" && req.path === "/bar/say") {
    if (!req.body || typeof req.body !== "object") {
      res.status(400).json({ error: "JSON body required" });
      return;
    }
    const body = req.body as Record<string, unknown>;
    const speaker = typeof body.speaker === "string" ? body.speaker : "";
    const line = typeof body.line === "string" ? body.line : "";
    if (!/^0x[0-9a-fA-F]{40}$/.test(speaker)) {
      res.status(400).json({ error: "speaker must be a 0x-prefixed 20-byte hex address" });
      return;
    }
    if (!line || line.length > BAR_LINE_MAX) {
      res.status(400).json({ error: `line required, max ${BAR_LINE_MAX} chars` });
      return;
    }
    return next();
  }

  next();
}

// ----- Board ----------------------------------------------------------

function boardPostHandler(req: Request, res: Response) {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const author = typeof body.author === "string" ? body.author : "";
  const text = typeof body.body === "string" ? body.body : "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(author)) {
    res.status(400).json({ error: "author must be a 0x-prefixed 20-byte hex address" });
    return;
  }
  if (!text || Buffer.byteLength(text, "utf8") > BOARD_BODY_MAX) {
    res.status(400).json({ error: `body required, max ${BOARD_BODY_MAX} bytes` });
    return;
  }
  const post = insertBoardPost({ author, body: text });
  res.status(201).json({ post });
}

function boardListHandler(req: Request, res: Response) {
  const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : 50;
  if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 100) {
    res.status(400).json({ error: "limit must be an integer in [1, 100]" });
    return;
  }
  res.json({ posts: listBoardPosts(limitRaw) });
}

function boardGetHandler(req: Request, res: Response) {
  const post = getBoardPost(req.params.id);
  if (!post) {
    res.status(404).json({ error: "no such post" });
    return;
  }
  res.json({ post });
}

// ----- Auction --------------------------------------------------------

function auctionCreateHandler(req: Request, res: Response) {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const seller = typeof body.seller === "string" ? body.seller : "";
  const description = typeof body.description === "string" ? body.description : "";
  const min_bid_usdc = typeof body.min_bid_usdc === "string" ? body.min_bid_usdc : "";
  const bid_deadline = typeof body.bid_deadline === "string" ? body.bid_deadline : "";
  const reveal_deadline = typeof body.reveal_deadline === "string" ? body.reveal_deadline : "";

  // Re-validate (defence-in-depth; preValidator ran already).
  if (!/^0x[0-9a-fA-F]{40}$/.test(seller)) {
    res.status(400).json({ error: "seller must be a 0x-prefixed 20-byte hex address" });
    return;
  }
  if (!description || Buffer.byteLength(description, "utf8") > AUCTION_DESCRIPTION_MAX) {
    res.status(400).json({ error: `description required, max ${AUCTION_DESCRIPTION_MAX} bytes` });
    return;
  }
  if (!/^\d+$/.test(min_bid_usdc) || min_bid_usdc === "0") {
    res.status(400).json({ error: "min_bid_usdc must be a positive base-units integer" });
    return;
  }
  if (Date.parse(reveal_deadline) <= Date.parse(bid_deadline)) {
    res.status(400).json({ error: "reveal_deadline must be after bid_deadline" });
    return;
  }
  const auction = createAuction({ seller, description, min_bid_usdc, bid_deadline, reveal_deadline });
  res.status(201).json({ auction });
}

function auctionGetHandler(req: Request, res: Response) {
  const auction = getAuction(req.params.id);
  if (!auction) {
    res.status(404).json({ error: "no such auction" });
    return;
  }
  // Bid book is only revealed once bidding closes (so we don't leak commitments
  // that haven't yet finished sealing). Once revealing or beyond, we expose
  // bidder + commitment + state for transparency.
  let bids: ReturnType<typeof listBids> | undefined;
  if (auction.state !== "bidding") {
    bids = listBids(auction.id);
  }
  // Fix #10: finalized auctions also surface the signed attestation, so
  // anyone (not just whoever called /finalize) can fetch the receipt.
  const body: Record<string, unknown> = { auction, bids };
  if (auction.state === "finalized") {
    body.attestation = attestationFor(auction);
  }
  res.json(body);
}

function auctionBidHandler(req: Request, res: Response) {
  const auction = getAuction(req.params.id);
  if (!auction) {
    res.status(404).json({ error: "no such auction" });
    return;
  }
  if (auction.state !== "bidding") {
    res.status(400).json({ error: `auction is ${auction.state}` });
    return;
  }
  if (Date.parse(auction.bid_deadline) <= clock().getTime()) {
    // Auto-flip to revealing on first late call.
    setAuctionState(auction.id, "revealing");
    res.status(400).json({ error: "bidding window closed" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const bidder = typeof body.bidder === "string" ? body.bidder : "";
  const commitment = typeof body.commitment === "string" ? body.commitment : "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(bidder)) {
    res.status(400).json({ error: "bidder must be a 0x-prefixed 20-byte hex address" });
    return;
  }
  const cleaned = commitment.replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(cleaned)) {
    res.status(400).json({ error: "commitment must be 32 bytes of hex" });
    return;
  }
  if (bidder.toLowerCase() === auction.seller) {
    res.status(400).json({ error: "seller cannot bid in their own auction" });
    return;
  }
  const placed = placeBid({ auction_id: auction.id, bidder, commitment: cleaned });
  if (!placed.ok) {
    res.status(409).json({ error: placed.reason });
    return;
  }
  res.status(201).json({ bid: placed.bid });
}

function auctionRevealHandler(req: Request, res: Response) {
  const auction = getAuction(req.params.id);
  if (!auction) {
    res.status(404).json({ error: "no such auction" });
    return;
  }
  const now = clock();
  if (auction.state === "bidding" && Date.parse(auction.bid_deadline) <= now.getTime()) {
    setAuctionState(auction.id, "revealing");
  }
  const refreshed = getAuction(auction.id)!;
  if (refreshed.state !== "revealing") {
    res.status(400).json({ error: `auction is ${refreshed.state}, not revealing` });
    return;
  }
  if (Date.parse(refreshed.reveal_deadline) <= now.getTime()) {
    res.status(400).json({ error: "reveal window closed" });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const bidder = typeof body.bidder === "string" ? body.bidder : "";
  const amount_usdc = typeof body.amount_usdc === "string" ? body.amount_usdc : "";
  const salt = typeof body.salt === "string" ? body.salt : "";

  if (!/^0x[0-9a-fA-F]{40}$/.test(bidder)) {
    res.status(400).json({ error: "bidder must be a 0x-prefixed 20-byte hex address" });
    return;
  }
  if (!/^\d+$/.test(amount_usdc) || amount_usdc === "0") {
    res.status(400).json({ error: "amount_usdc must be a positive base-units integer" });
    return;
  }
  if (!salt) {
    res.status(400).json({ error: "salt required" });
    return;
  }
  const existing = getBid(refreshed.id, bidder);
  if (!existing) {
    res.status(404).json({ error: "no such bid" });
    return;
  }
  if (existing.state !== "sealed") {
    res.status(400).json({ error: `bid is ${existing.state}` });
    return;
  }
  const expected = bidCommitment(amount_usdc, salt, bidder);
  const valid = expected === existing.commitment.toLowerCase();
  const updated = recordReveal({
    auction_id: refreshed.id,
    bidder,
    amount_usdc,
    salt,
    valid,
  });
  if (!updated) {
    res.status(409).json({ error: "bid no longer in sealed state" });
    return;
  }
  if (!valid) {
    res.status(400).json({ error: "commitment mismatch", bid: updated });
    return;
  }
  res.status(200).json({ bid: updated });
}

export function bidCommitment(amount_usdc: string, salt: string, bidder: string): string {
  const preimage = `${amount_usdc}:${salt}:${bidder.toLowerCase()}`;
  return crypto.createHash("sha256").update(preimage, "utf8").digest("hex");
}

function auctionFinalizeHandler(req: Request, res: Response) {
  const auction = getAuction(req.params.id);
  if (!auction) {
    res.status(404).json({ error: "no such auction" });
    return;
  }
  if (auction.state === "finalized") {
    res.status(200).json({ auction, attestation: attestationFor(auction) });
    return;
  }
  const now = clock();
  // Fix #8: don't mutate state on a path that's about to 400. Only flip
  // bidding → revealing if both (a) bid_deadline passed AND (b) we're on
  // a path that genuinely needs the new state. Finalize doesn't, so we
  // peek-only here.
  const bidWindowOver = Date.parse(auction.bid_deadline) <= now.getTime();
  const revealWindowOver = Date.parse(auction.reveal_deadline) <= now.getTime();
  if (auction.state === "bidding" && !bidWindowOver) {
    res.status(400).json({ error: `auction is bidding, cannot finalize` });
    return;
  }
  if (!revealWindowOver) {
    res.status(400).json({
      error: "reveal window still open",
      detail: `now ${now.toISOString()} < reveal_deadline ${auction.reveal_deadline}`,
    });
    return;
  }
  // Bid window over AND reveal window over: it's safe to advance state if
  // we haven't already.
  if (auction.state === "bidding") {
    setAuctionState(auction.id, "revealing");
  }
  const refreshed = getAuction(auction.id)!;

  const bids = listBids(refreshed.id);
  const valid = bids.filter((b) => b.state === "revealed" && b.amount_usdc !== null);
  let winner: string | null = null;
  let winningBid: bigint = 0n;
  for (const b of valid) {
    const amount = BigInt(b.amount_usdc!);
    if (amount < BigInt(refreshed.min_bid_usdc)) continue;
    if (amount > winningBid) {
      winningBid = amount;
      winner = b.bidder;
    }
  }
  const finalised = finalizeAuction({
    id: refreshed.id,
    winner,
    winning_bid: winner ? winningBid.toString() : null,
  });
  if (!finalised) {
    res.status(409).json({ error: "auction state changed during finalize" });
    return;
  }
  res.status(200).json({ auction: finalised, attestation: attestationFor(finalised) });
}

function attestationFor(auction: AuctionRow) {
  const claim = {
    auction_id: auction.id,
    seller: auction.seller,
    winner: auction.winner,
    winning_bid_usdc: auction.winning_bid,
    finalized_at: auction.finalized_at,
  };
  return { claim, signature: signClaim(claim) };
}

// ----- Bar ------------------------------------------------------------

function barSayHandler(req: Request, res: Response) {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const speaker = typeof body.speaker === "string" ? body.speaker : "";
  const line = typeof body.line === "string" ? body.line : "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(speaker)) {
    res.status(400).json({ error: "speaker must be a 0x-prefixed 20-byte hex address" });
    return;
  }
  if (!line || line.length > BAR_LINE_MAX) {
    res.status(400).json({ error: `line required, max ${BAR_LINE_MAX} chars` });
    return;
  }
  // Per-speaker fairness quota (review item #24): a single wallet can't
  // monopolise the bar's rolling buffer. The buyer paid $0.001 to send,
  // so we 429 instead of dropping silently.
  const since = new Date(clock().getTime() - BAR_PER_SPEAKER_WINDOW_MS).toISOString();
  if (countBarLinesBySpeakerSince(speaker, since) >= BAR_PER_SPEAKER_LIMIT) {
    res.status(429).json({
      error: "bar quota exceeded",
      detail: `max ${BAR_PER_SPEAKER_LIMIT} lines per ${BAR_PER_SPEAKER_WINDOW_MS / 1000}s per speaker`,
    });
    return;
  }
  const inserted = insertBarLine({ speaker, line });
  // Amortise pruning (review item #9): once every BAR_PRUNE_EVERY says,
  // not on every single insert.
  barInsertCounter += 1;
  if (barInsertCounter % BAR_PRUNE_EVERY === 0) {
    pruneBarLines(BAR_KEEP);
  }
  res.status(201).json({ line: inserted });
}

function barTailHandler(req: Request, res: Response) {
  const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : 50;
  if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 500) {
    res.status(400).json({ error: "limit must be an integer in [1, 500]" });
    return;
  }
  const sinceRaw = typeof req.query.since === "string" ? Number(req.query.since) : NaN;
  if (Number.isFinite(sinceRaw)) {
    if (!Number.isInteger(sinceRaw) || sinceRaw < 0) {
      res.status(400).json({ error: "since must be a non-negative integer cursor" });
      return;
    }
    const lines = listBarLinesSince(sinceRaw, limitRaw);
    res.json({ lines, cursor: lines.length > 0 ? lines[lines.length - 1].id : sinceRaw });
    return;
  }
  const lines = listBarLinesRecent(limitRaw);
  res.json({ lines, cursor: lines.length > 0 ? lines[0].id : 0 });
}

// ----- Wiring ---------------------------------------------------------

export function agoraRouter(): express.Router {
  ensureAgoraTables();
  const router = express.Router();
  router.use(express.json({ limit: "16kb" }));

  router.post("/board/post", boardPostHandler);
  router.get("/board", boardListHandler);
  router.get("/board/:id", boardGetHandler);

  router.post("/auction/create", auctionCreateHandler);
  router.post("/auction/:id/bid", auctionBidHandler);
  router.post("/auction/:id/reveal", auctionRevealHandler);
  router.post("/auction/:id/finalize", auctionFinalizeHandler);
  router.get("/auction/:id", auctionGetHandler);

  router.post("/bar/say", barSayHandler);
  router.get("/bar", barTailHandler);
  return router;
}

export const agoraProduct: Product = {
  slug: SLUG,
  description:
    "Public square: paid pinboard, sealed-bid auction, and paid chatroom. Three small " +
    "primitives behind one product slot.",
  paidRoutes: [
    {
      method: "POST",
      path: `/${SLUG}/board/post`,
      price: "$0.05",
      description: "Pin a short message on the public board.",
    },
    {
      method: "POST",
      path: `/${SLUG}/auction/create`,
      price: "$0.10",
      description: "Open a sealed-bid auction.",
    },
    {
      method: "POST",
      path: `/${SLUG}/auction/:id/bid`,
      price: "$0.01",
      description: "Place a sealed-bid commitment.",
    },
    {
      method: "POST",
      path: `/${SLUG}/bar/say`,
      price: "$0.001",
      description: "Speak a line in the bar.",
    },
  ],
  preValidators: [agoraPreValidator],
  router: agoraRouter,
  help: agoraHelp,
};
