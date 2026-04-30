import express, { type Request, type Response, type NextFunction } from "express";
import { signClaim } from "../../core/sign.js";
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

interface ParsedCreate {
  buyer: string;
  recipient: string;
  amount_usdc: string;
  condition_kind: EscrowConditionKind;
  condition_value: string;
  deadline: string;
  memo?: string;
}

function parseCreateBody(body: Record<string, unknown>):
  | { ok: true; value: ParsedCreate }
  | { ok: false; error: string } {
  const buyer = typeof body.buyer === "string" ? body.buyer : "";
  const recipient = typeof body.recipient === "string" ? body.recipient : "";
  const amount_usdc = typeof body.amount_usdc === "string" ? body.amount_usdc : "";
  const condition_kind = body.condition_kind;
  const condition_value =
    typeof body.condition_value === "string" ? body.condition_value : "";
  const deadline = typeof body.deadline === "string" ? body.deadline : "";
  const memoRaw = body.memo;

  if (!/^0x[0-9a-fA-F]{40}$/.test(buyer)) {
    return { ok: false, error: "buyer must be a 0x-prefixed 20-byte hex address" };
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
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
  const deadlineMs = Date.parse(deadline);
  if (!Number.isFinite(deadlineMs)) {
    return { ok: false, error: "deadline must be an ISO 8601 timestamp" };
  }
  if (deadlineMs <= Date.now()) {
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
      return Number.isFinite(Date.parse(value));
    case "passport_binding":
      return parsePassportSelector(value) !== null;
    case "commit_revealed":
      return /^[0-9a-f-]{8,}$/i.test(value);
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
  (res.locals as { escrowCreate?: ParsedCreate }).escrowCreate = parsed.value;
  next();
}

// ----- Handlers -------------------------------------------------------

function createHandler(_req: Request, res: Response) {
  const input = (res.locals as { escrowCreate?: ParsedCreate }).escrowCreate;
  if (!input) {
    res.status(500).json({ error: "internal: validator did not run" });
    return;
  }
  const row = createEscrow(input);
  res.status(201).json({ escrow: row });
}

function getHandler(req: Request, res: Response) {
  const row = getEscrow(req.params.id);
  if (!row) {
    res.status(404).json({ error: "no such escrow" });
    return;
  }
  res.json({ escrow: row });
}

function listByBuyerHandler(req: Request, res: Response) {
  const wallet = req.params.wallet;
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    res.status(400).json({ error: "wallet must be a 0x-prefixed 20-byte hex address" });
    return;
  }
  res.json({ escrows: listEscrowsByBuyer(wallet) });
}

function listByRecipientHandler(req: Request, res: Response) {
  const wallet = req.params.wallet;
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
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
    // Race: another caller flipped the row between read and write.
    res.status(409).json({ error: "escrow no longer open" });
    return;
  }
  const attestation = signEscrowAttestation(updated, "release");
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
  if (Date.parse(row.deadline) > ctx.now.getTime()) {
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

function signEscrowAttestation(row: EscrowRow, resolution: "release" | "refund"): EscrowAttestation {
  const claim = {
    escrow_id: row.id,
    buyer: row.buyer,
    recipient: row.recipient,
    amount_usdc: row.amount_usdc,
    resolution,
    resolved_at: row.resolved_at!,
    detail: row.resolution!,
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
