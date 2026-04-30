import express, { type Request, type Response, type NextFunction } from "express";
import { signClaim } from "../../core/sign.js";
import { isAddress, isUuidV4 } from "../../core/addr.js";
import { isFuture, parseTimestamp } from "../../core/time.js";
import { log } from "../../core/log.js";
import {
  ensureEscrowTables,
  createEscrow,
  getEscrow,
  listEscrowsByBuyer,
  listEscrowsByRecipient,
  markReleased,
  markRefunded,
  type EscrowConditionKind,
  type EscrowRow,
} from "./state.js";
import {
  evaluateCondition,
  isValidConditionKind,
  parsePassportSelector,
  type ConditionContext,
} from "./conditions.js";
import { escrowHelp } from "./help.js";
import type { ParsedEscrowCreate } from "./locals.js";
import type { Product } from "../../core/product.js";

const SLUG = "escrow";

// ----- Pluggable context (tests can override) -------------------------

let contextProvider: () => Promise<ConditionContext> = async () => ({
  now: new Date(),
});

export function setContextProviderForTesting(p: () => Promise<ConditionContext>): void {
  contextProvider = p;
}

export function resetContextProviderForTesting(): void {
  contextProvider = async () => ({ now: new Date() });
}

// ----- Validation -----------------------------------------------------

export function parseCreateBody(body: Record<string, unknown>):
  | { ok: true; value: ParsedEscrowCreate }
  | { ok: false; error: string } {
  const buyer = typeof body.buyer === "string" ? body.buyer : "";
  const recipient = typeof body.recipient === "string" ? body.recipient : "";
  const amount_usdc = typeof body.amount_usdc === "string" ? body.amount_usdc : "";
  const condition_kind = body.condition_kind;
  const condition_value =
    typeof body.condition_value === "string" ? body.condition_value : "";
  const deadline = typeof body.deadline === "string" ? body.deadline : "";
  const memoRaw = body.memo;

  if (!isAddress(buyer)) {
    return { ok: false, error: "buyer must be a 0x-prefixed 20-byte hex address" };
  }
  if (!isAddress(recipient)) {
    return { ok: false, error: "recipient must be a 0x-prefixed 20-byte hex address" };
  }
  if (buyer.toLowerCase() === recipient.toLowerCase()) {
    return { ok: false, error: "buyer and recipient must differ" };
  }
  if (!/^\d+$/.test(amount_usdc) || amount_usdc === "0") {
    return { ok: false, error: "amount_usdc must be a positive base-units integer" };
  }
  if (!isValidConditionKind(condition_kind)) {
    return {
      ok: false,
      error: "condition_kind must be block_height|timestamp|passport_binding|commit_revealed",
    };
  }
  if (!condition_value) {
    return { ok: false, error: "condition_value is required" };
  }
  if (!validateConditionValue(condition_kind, condition_value)) {
    return { ok: false, error: `condition_value malformed for kind ${condition_kind}` };
  }
  if (!parseTimestamp(deadline)) {
    return { ok: false, error: "deadline must be an ISO 8601 timestamp" };
  }
  if (!isFuture(deadline)) {
    return { ok: false, error: "deadline must be in the future" };
  }
  let memo: string | undefined;
  if (memoRaw !== undefined && memoRaw !== null) {
    if (typeof memoRaw !== "string" || memoRaw.length > 256) {
      return { ok: false, error: "memo must be a string ≤ 256 chars" };
    }
    memo = memoRaw;
  }
  return {
    ok: true,
    value: { buyer, recipient, amount_usdc, condition_kind, condition_value, deadline, memo },
  };
}

function validateConditionValue(kind: EscrowConditionKind, value: string): boolean {
  switch (kind) {
    case "block_height":
      return /^\d+$/.test(value);
    case "timestamp":
      return parseTimestamp(value) !== null;
    case "passport_binding":
      return parsePassportSelector(value) !== null;
    case "commit_revealed":
      return isUuidV4(value);
  }
}

// ----- Pre-validator for paid POST /escrow/create ---------------------

export function escrowPreValidator(req: Request, res: Response, next: NextFunction) {
  if (req.method !== "POST" || req.path !== "/create") return next();
  if (!req.body || typeof req.body !== "object") {
    res.status(400).json({ error: "JSON body required" });
    return;
  }
  const parsed = parseCreateBody(req.body as Record<string, unknown>);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  res.locals.escrowCreate = parsed.value;
  next();
}

// ----- Handlers -------------------------------------------------------

function createHandler(_req: Request, res: Response) {
  const input = res.locals.escrowCreate;
  if (!input) {
    res.status(500).json({ error: "internal: validator did not run" });
    return;
  }
  const row = createEscrow(input);
  log.debug("escrow_created", { id: row.id, buyer: row.buyer, recipient: row.recipient });
  res.status(201).json({ escrow: row });
}

/**
 * Read an escrow. If the escrow has been resolved (released or refunded) we
 * also re-derive the signed attestation so a recipient who lost their
 * release-time response can still produce a verifiable receipt — the
 * attestation depends only on row state, so this is deterministic and the
 * signature matches the one returned at release time.
 *
 * Fixes review item #10.
 */
function getHandler(req: Request, res: Response) {
  const row = getEscrow(req.params.id);
  if (!row) {
    res.status(404).json({ error: "no such escrow" });
    return;
  }
  if (row.state === "released") {
    res.json({ escrow: row, attestation: signEscrowAttestation(row, "release") });
    return;
  }
  if (row.state === "refunded") {
    res.json({ escrow: row, attestation: signEscrowAttestation(row, "refund") });
    return;
  }
  res.json({ escrow: row });
}

function listByBuyerHandler(req: Request, res: Response) {
  const wallet = req.params.wallet;
  if (!isAddress(wallet)) {
    res.status(400).json({ error: "wallet must be a 0x-prefixed 20-byte hex address" });
    return;
  }
  res.json({ escrows: listEscrowsByBuyer(wallet) });
}

function listByRecipientHandler(req: Request, res: Response) {
  const wallet = req.params.wallet;
  if (!isAddress(wallet)) {
    res.status(400).json({ error: "wallet must be a 0x-prefixed 20-byte hex address" });
    return;
  }
  res.json({ escrows: listEscrowsByRecipient(wallet) });
}

async function releaseHandler(req: Request, res: Response) {
  const row = getEscrow(req.params.id);
  if (!row) {
    res.status(404).json({ error: "no such escrow" });
    return;
  }
  if (row.state !== "open") {
    res.status(400).json({ error: `escrow is ${row.state}` });
    return;
  }
  const ctx = await contextProvider();
  const result = evaluateCondition(row, ctx);
  if (!result.met) {
    res.status(400).json({ error: "condition not met", detail: result.detail });
    return;
  }
  const updated = markReleased(row.id, result.detail);
  if (!updated) {
    res.status(409).json({ error: "escrow no longer open" });
    return;
  }
  const attestation = signEscrowAttestation(updated, "release");
  log.info("escrow_released", { id: updated.id, detail: result.detail });
  res.status(200).json({ escrow: updated, attestation });
}

async function refundHandler(req: Request, res: Response) {
  const row = getEscrow(req.params.id);
  if (!row) {
    res.status(404).json({ error: "no such escrow" });
    return;
  }
  if (row.state !== "open") {
    res.status(400).json({ error: `escrow is ${row.state}` });
    return;
  }
  const ctx = await contextProvider();
  const deadline = parseTimestamp(row.deadline);
  if (deadline && deadline.ms > ctx.now.getTime()) {
    res.status(400).json({
      error: "deadline has not passed",
      detail: `now ${ctx.now.toISOString()} < deadline ${row.deadline}`,
    });
    return;
  }
  const updated = markRefunded(row.id, `deadline ${row.deadline} passed without release`);
  if (!updated) {
    res.status(409).json({ error: "escrow no longer open" });
    return;
  }
  const attestation = signEscrowAttestation(updated, "refund");
  log.info("escrow_refunded", { id: updated.id, deadline: updated.deadline });
  res.status(200).json({ escrow: updated, attestation });
}

interface EscrowAttestation {
  claim: {
    escrow_id: string;
    buyer: string;
    recipient: string;
    amount_usdc: string;
    resolution: "release" | "refund";
    resolved_at: string;
    detail: string;
  };
  signature: string;
}

/**
 * Discriminated subtype: an escrow that has actually resolved. Encodes the
 * "row.resolved_at and row.resolution are non-null" invariant in the type so
 * `signEscrowAttestation` doesn't need non-null assertions.
 */
type ResolvedEscrow = EscrowRow & { resolved_at: string; resolution: string };

function isResolved(row: EscrowRow): row is ResolvedEscrow {
  return row.resolved_at !== null && row.resolution !== null;
}

function signEscrowAttestation(row: EscrowRow, resolution: "release" | "refund"): EscrowAttestation {
  if (!isResolved(row)) {
    throw new Error(`signEscrowAttestation: escrow ${row.id} is not resolved (state=${row.state})`);
  }
  const claim = {
    escrow_id: row.id,
    buyer: row.buyer,
    recipient: row.recipient,
    amount_usdc: row.amount_usdc,
    resolution,
    resolved_at: row.resolved_at,
    detail: row.resolution,
  };
  return { claim, signature: signClaim(claim) };
}

// ----- Wiring ---------------------------------------------------------

export function escrowRouter(): express.Router {
  ensureEscrowTables();
  const router = express.Router();
  router.use(express.json({ limit: "16kb" }));

  router.post("/create", createHandler);
  router.get("/by-buyer/:wallet", listByBuyerHandler);
  router.get("/by-recipient/:wallet", listByRecipientHandler);
  router.post("/:id/release", (req, res) => {
    void releaseHandler(req, res);
  });
  router.post("/:id/refund", (req, res) => {
    void refundHandler(req, res);
  });
  router.get("/:id", getHandler);
  return router;
}

export const escrowProduct: Product = {
  slug: SLUG,
  description:
    "Conditional value attestations. Lock an escrow against a release condition; " +
    "anyone can trigger release once it fires; the buyer refunds after the deadline.",
  paidRoutes: [
    {
      method: "POST",
      path: `/${SLUG}/create`,
      price: "$0.10",
      description: "Open a conditional escrow.",
    },
  ],
  preValidators: [escrowPreValidator],
  router: escrowRouter,
  help: escrowHelp,
};
