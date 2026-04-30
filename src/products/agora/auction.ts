import crypto from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import { signClaim } from "../../core/sign.js";
import { isAddress, parseHex32 } from "../../core/addr.js";
import { parseTimestamp } from "../../core/time.js";
import { log } from "../../core/log.js";
import { now } from "./clock.js";
import {
  createAuction,
  getAuction,
  setAuctionState,
  placeBid,
  getBid,
  listBids,
  recordReveal,
  finalizeAuction,
  type AuctionRow,
} from "./state.js";

export const AUCTION_DESCRIPTION_MAX = 1024;

// ----- Pre-validator -------------------------------------------------

export function auctionPreValidator(req: Request, res: Response, next: NextFunction) {
  if (req.method !== "POST") return next();

  if (req.path === "/auction/create") {
    return validateCreate(req, res, next);
  }
  const bidMatch = req.path.match(/^\/auction\/([^/]+)\/bid$/);
  if (bidMatch) {
    return validateBid(bidMatch[1], req, res, next);
  }
  next();
}

function validateCreate(req: Request, res: Response, next: NextFunction) {
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

  if (!isAddress(seller)) {
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
  const bid = parseTimestamp(bid_deadline);
  const reveal = parseTimestamp(reveal_deadline);
  if (!bid || !reveal) {
    res.status(400).json({ error: "bid_deadline and reveal_deadline must be ISO 8601" });
    return;
  }
  if (bid.ms <= now().getTime()) {
    res.status(400).json({ error: "bid_deadline must be in the future" });
    return;
  }
  if (reveal.ms <= bid.ms) {
    res.status(400).json({ error: "reveal_deadline must be after bid_deadline" });
    return;
  }

  res.locals.agoraAuctionCreate = { seller, description, min_bid_usdc, bid_deadline, reveal_deadline };
  next();
}

function validateBid(auctionId: string, req: Request, res: Response, next: NextFunction) {
  if (!req.body || typeof req.body !== "object") {
    res.status(400).json({ error: "JSON body required" });
    return;
  }
  const body = req.body as Record<string, unknown>;
  const bidder = typeof body.bidder === "string" ? body.bidder : "";
  const commitmentRaw = typeof body.commitment === "string" ? body.commitment : "";

  if (!isAddress(bidder)) {
    res.status(400).json({ error: "bidder must be a 0x-prefixed 20-byte hex address" });
    return;
  }
  const commitment = parseHex32(commitmentRaw);
  if (!commitment) {
    res.status(400).json({ error: "commitment must be 32 bytes of hex" });
    return;
  }
  const auction = getAuction(auctionId);
  if (!auction) {
    res.status(404).json({ error: "no such auction" });
    return;
  }
  if (auction.state !== "bidding") {
    res.status(400).json({ error: `auction is ${auction.state}` });
    return;
  }
  const deadline = parseTimestamp(auction.bid_deadline);
  if (!deadline || deadline.ms <= now().getTime()) {
    res.status(400).json({ error: "bidding window closed" });
    return;
  }
  if (bidder.toLowerCase() === auction.seller) {
    res.status(400).json({ error: "seller cannot bid in their own auction" });
    return;
  }

  res.locals.agoraAuctionBid = { auctionId: auction.id, bidder, commitment };
  next();
}

// ----- Handlers ------------------------------------------------------

function createHandler(_req: Request, res: Response) {
  const input = res.locals.agoraAuctionCreate;
  if (!input) {
    res.status(500).json({ error: "internal: validator did not run" });
    return;
  }
  const auction = createAuction(input);
  log.info("auction_created", {
    id: auction.id,
    seller: auction.seller,
    bid_deadline: auction.bid_deadline,
  });
  res.status(201).json({ auction });
}

function getHandler(req: Request, res: Response) {
  const auction = getAuction(req.params.id);
  if (!auction) {
    res.status(404).json({ error: "no such auction" });
    return;
  }
  let bids: ReturnType<typeof listBids> | undefined;
  if (auction.state !== "bidding") {
    bids = listBids(auction.id);
  }
  const body: Record<string, unknown> = { auction, bids };
  if (auction.state === "finalized") {
    body.attestation = attestationFor(auction);
  }
  res.json(body);
}

function bidHandler(_req: Request, res: Response) {
  const input = res.locals.agoraAuctionBid;
  if (!input) {
    res.status(500).json({ error: "internal: validator did not run" });
    return;
  }
  const placed = placeBid({
    auction_id: input.auctionId,
    bidder: input.bidder,
    commitment: input.commitment,
  });
  if (!placed.ok) {
    res.status(409).json({ error: placed.reason });
    return;
  }
  res.status(201).json({ bid: placed.bid });
}

function revealHandler(req: Request, res: Response) {
  const auction = getAuction(req.params.id);
  if (!auction) {
    res.status(404).json({ error: "no such auction" });
    return;
  }
  const t = now();
  const bidDeadline = parseTimestamp(auction.bid_deadline);
  if (auction.state === "bidding" && bidDeadline && bidDeadline.ms <= t.getTime()) {
    setAuctionState(auction.id, "revealing");
  }
  const refreshed = getAuction(auction.id)!;
  if (refreshed.state !== "revealing") {
    res.status(400).json({ error: `auction is ${refreshed.state}, not revealing` });
    return;
  }
  const revealDeadline = parseTimestamp(refreshed.reveal_deadline);
  if (!revealDeadline || revealDeadline.ms <= t.getTime()) {
    res.status(400).json({ error: "reveal window closed" });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const bidder = typeof body.bidder === "string" ? body.bidder : "";
  const amount_usdc = typeof body.amount_usdc === "string" ? body.amount_usdc : "";
  const salt = typeof body.salt === "string" ? body.salt : "";

  if (!isAddress(bidder)) {
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

function finalizeHandler(req: Request, res: Response) {
  const auction = getAuction(req.params.id);
  if (!auction) {
    res.status(404).json({ error: "no such auction" });
    return;
  }
  if (auction.state === "finalized") {
    res.status(200).json({ auction, attestation: attestationFor(auction) });
    return;
  }
  const t = now();
  const bidDeadline = parseTimestamp(auction.bid_deadline);
  const revealDeadline = parseTimestamp(auction.reveal_deadline);
  const bidWindowOver = bidDeadline !== null && bidDeadline.ms <= t.getTime();
  const revealWindowOver = revealDeadline !== null && revealDeadline.ms <= t.getTime();
  if (auction.state === "bidding" && !bidWindowOver) {
    res.status(400).json({ error: `auction is bidding, cannot finalize` });
    return;
  }
  if (!revealWindowOver) {
    res.status(400).json({
      error: "reveal window still open",
      detail: `now ${t.toISOString()} < reveal_deadline ${auction.reveal_deadline}`,
    });
    return;
  }
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
  log.info("auction_finalized", {
    id: finalised.id,
    winner: finalised.winner,
    winning_bid_usdc: finalised.winning_bid,
  });
  res.status(200).json({ auction: finalised, attestation: attestationFor(finalised) });
}

export function attestationFor(auction: AuctionRow) {
  const claim = {
    auction_id: auction.id,
    seller: auction.seller,
    winner: auction.winner,
    winning_bid_usdc: auction.winning_bid,
    finalized_at: auction.finalized_at,
  };
  return { claim, signature: signClaim(claim) };
}

export function auctionRouter(): express.Router {
  const router = express.Router();
  router.post("/create", createHandler);
  router.post("/:id/bid", bidHandler);
  router.post("/:id/reveal", revealHandler);
  router.post("/:id/finalize", finalizeHandler);
  router.get("/:id", getHandler);
  return router;
}
