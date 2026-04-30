import express, { type Request, type Response } from "express";
import { signClaim } from "../../core/sign.js";
import {
  ensurePassportTables,
  insertBinding,
  listBindings,
  insertChallenge,
  getChallenge,
  markChallengeSolved,
  insertPass,
  listPasses,
} from "./state.js";
import { freshNonce, checkSolution } from "./captcha.js";
import { passportHelp } from "./help.js";
import { defaultVerifier, type VerifyResult } from "./verify.js";
import type { Product } from "../../core/product.js";

const SLUG = "passport";

const BIND_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const PASS_TTL_MS = 24 * 60 * 60 * 1000;
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

// ----- /passport/bind -------------------------------------------------

/**
 * Verifier hook. Default uses the real ENS/domain/gist verifiers in
 * verify.ts (review item #17). Tests can swap in a mock with
 * setVerifierForTesting.
 */
export type Verifier = (
  wallet: string,
  anchor_kind: "ens" | "domain" | "gist",
  anchor_value: string,
) => Promise<VerifyResult>;

let verifier: Verifier = defaultVerifier;

export function setVerifierForTesting(v: Verifier): void {
  verifier = v;
}

export function resetVerifierForTesting(): void {
  verifier = defaultVerifier;
}

async function bindHandler(req: Request, res: Response) {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const wallet = typeof body.wallet === "string" ? body.wallet : "";
  const anchor_kind = body.anchor_kind;
  const anchor_value = typeof body.anchor_value === "string" ? body.anchor_value : "";

  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    res.status(400).json({ error: "wallet must be a 0x-prefixed 20-byte hex address" });
    return;
  }
  if (anchor_kind !== "ens" && anchor_kind !== "domain" && anchor_kind !== "gist") {
    res.status(400).json({ error: "anchor_kind must be ens|domain|gist" });
    return;
  }
  if (!anchor_value || anchor_value.length > 256) {
    res.status(400).json({ error: "anchor_value required, max 256 chars" });
    return;
  }

  const kind = anchor_kind as "ens" | "domain" | "gist";
  const result = await verifier(wallet, kind, anchor_value);

  const issued_at = new Date().toISOString();
  const expires_at = new Date(Date.now() + BIND_TTL_MS).toISOString();
  const verified: 0 | 1 = result.verified ? 1 : 0;
  const claim = {
    wallet: wallet.toLowerCase(),
    anchor_kind: kind,
    anchor_value,
    verified,
    issued_at,
    expires_at,
  };
  const signature = signClaim(claim);
  const row = insertBinding({ ...claim, signature });

  res.status(201).json({ binding: row, detail: result.detail });
}

function bindGetHandler(req: Request, res: Response) {
  const wallet = req.params.wallet;
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    res.status(400).json({ error: "wallet must be a 0x-prefixed 20-byte hex address" });
    return;
  }
  const rows = listBindings(wallet);
  res.json({ bindings: rows });
}

// ----- /passport/anti-captcha ----------------------------------------

function captchaChallengeHandler(req: Request, res: Response) {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const wallet = typeof body.wallet === "string" ? body.wallet : "";
  const difficultyRaw = body.difficulty;
  const difficulty =
    typeof difficultyRaw === "number"
      ? difficultyRaw
      : typeof difficultyRaw === "string"
        ? Number(difficultyRaw)
        : 18;

  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    res.status(400).json({ error: "wallet must be a 0x-prefixed 20-byte hex address" });
    return;
  }
  if (!Number.isInteger(difficulty) || difficulty < 12 || difficulty > 28) {
    res.status(400).json({ error: "difficulty must be an integer in [12, 28]" });
    return;
  }

  const nonce = freshNonce();
  const issued_at = new Date().toISOString();
  const expires_at = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
  const row = insertChallenge({ wallet, difficulty, nonce, issued_at, expires_at });
  res.status(201).json(row);
}

function captchaSolveHandler(req: Request, res: Response) {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const challenge_id = typeof body.challenge_id === "string" ? body.challenge_id : "";
  const solution = typeof body.solution === "string" ? body.solution : "";

  const chal = getChallenge(challenge_id);
  if (!chal) {
    res.status(404).json({ error: "no such challenge" });
    return;
  }
  if (chal.state !== "open") {
    res.status(400).json({ error: `challenge is ${chal.state}` });
    return;
  }
  if (Date.parse(chal.expires_at) < Date.now()) {
    res.status(400).json({ error: "challenge expired" });
    return;
  }
  if (!checkSolution(chal.nonce, solution, chal.difficulty)) {
    res.status(400).json({ error: "solution does not meet difficulty target" });
    return;
  }

  markChallengeSolved(challenge_id);

  const issued_at = new Date().toISOString();
  const expires_at = new Date(Date.now() + PASS_TTL_MS).toISOString();
  const claim = {
    wallet: chal.wallet,
    issued_at,
    expires_at,
    challenge_id,
  };
  const signature = signClaim(claim);
  const pass = insertPass({ wallet: chal.wallet, issued_at, expires_at, signature });
  res.status(201).json({ pass, claim });
}

function passesGetHandler(req: Request, res: Response) {
  const wallet = req.params.wallet;
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    res.status(400).json({ error: "wallet must be a 0x-prefixed 20-byte hex address" });
    return;
  }
  const rows = listPasses(wallet);
  res.json({ passes: rows });
}

// ----- Wiring ---------------------------------------------------------

export function passportRouter(): express.Router {
  ensurePassportTables();
  const router = express.Router();
  router.use(express.json({ limit: "16kb" }));

  router.post("/bind", (req, res) => {
    void bindHandler(req, res);
  });
  router.get("/bind/:wallet", bindGetHandler);
  router.post("/anti-captcha/challenge", captchaChallengeHandler);
  router.post("/anti-captcha/solve", captchaSolveHandler);
  router.get("/anti-captcha/passes/:wallet", passesGetHandler);
  return router;
}

export const passportProduct: Product = {
  slug: SLUG,
  description:
    "Identity attestations: bind wallets to ENS/domain/gist anchors, or prove " +
    "non-humanness via proof-of-work challenges.",
  paidRoutes: [
    {
      method: "POST",
      path: `/${SLUG}/bind`,
      price: "$0.10",
      description: "Issue a 90-day signed identity binding.",
    },
    {
      method: "POST",
      path: `/${SLUG}/anti-captcha/challenge`,
      price: "$0.001",
      description: "Issue an anti-human proof-of-work challenge.",
    },
  ],
  router: passportRouter,
  help: passportHelp,
};
