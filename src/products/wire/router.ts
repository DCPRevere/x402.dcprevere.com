import express, { type Request, type Response, type NextFunction } from "express";
import {
  ensureWireTables,
  createInbox,
  getInboxPublic,
  authenticateOwner,
  closeInbox,
  enqueueMessage,
  countQueued,
  pollMessages,
} from "./state.js";
import { wireHelp } from "./help.js";
import type { Product } from "../../core/product.js";

const SLUG = "wire";

const MAX_BODY_BYTES = 8 * 1024;
const MAX_POLL_BATCH = 100;

// ----- Validation helpers --------------------------------------------

function readOwnerToken(req: Request): string | null {
  const header = req.header("x-wire-owner-token");
  if (typeof header !== "string" || header.length === 0) return null;
  if (!/^[0-9a-f]{64}$/i.test(header)) return null;
  return header.toLowerCase();
}

// ----- Pre-validator --------------------------------------------------

/**
 * Runs at the app level before the paywall. Currently only the send endpoint
 * is paid; the rest are free. We pre-validate the send body so a buyer never
 * pays $0.005 for a malformed message.
 */
export function wirePreValidator(req: Request, res: Response, next: NextFunction) {
  // Path arrives without the /wire prefix because preValidators are mounted
  // under the product slug.
  const sendMatch = req.path.match(/^\/inbox\/([^/]+)\/send$/);
  if (req.method === "POST" && sendMatch) {
    if (!req.body || typeof req.body !== "object") {
      res.status(400).json({ error: "JSON body required" });
      return;
    }
    const body = req.body as Record<string, unknown>;
    const from = typeof body.from === "string" ? body.from : "";
    const messageBody = typeof body.body === "string" ? body.body : "";
    if (!/^0x[0-9a-fA-F]{40}$/.test(from)) {
      res.status(400).json({ error: "from must be a 0x-prefixed 20-byte hex address" });
      return;
    }
    if (!messageBody || Buffer.byteLength(messageBody, "utf8") > MAX_BODY_BYTES) {
      res.status(400).json({ error: `body required, max ${MAX_BODY_BYTES} bytes` });
      return;
    }
    const inbox = getInboxPublic(sendMatch[1]);
    if (!inbox) {
      res.status(404).json({ error: "no such inbox" });
      return;
    }
    if (inbox.state !== "open") {
      res.status(410).json({ error: `inbox is ${inbox.state}` });
      return;
    }
  }
  next();
}

// ----- Handlers -------------------------------------------------------

function createInboxHandler(req: Request, res: Response) {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const owner_wallet = typeof body.owner_wallet === "string" ? body.owner_wallet : "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner_wallet)) {
    res.status(400).json({ error: "owner_wallet must be a 0x-prefixed 20-byte hex address" });
    return;
  }
  const result = createInbox({ owner_wallet });
  res.status(201).json({ inbox: result.inbox, owner_token: result.owner_token });
}

function getInboxHandler(req: Request, res: Response) {
  const inbox = getInboxPublic(req.params.id);
  if (!inbox) {
    res.status(404).json({ error: "no such inbox" });
    return;
  }
  res.json({
    inbox,
    queued: countQueued(inbox.id),
    price_per_send_usdc: "0.005",
  });
}

function sendHandler(req: Request, res: Response) {
  const inbox = getInboxPublic(req.params.id);
  if (!inbox) {
    res.status(404).json({ error: "no such inbox" });
    return;
  }
  if (inbox.state !== "open") {
    res.status(410).json({ error: `inbox is ${inbox.state}` });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const from = typeof body.from === "string" ? body.from : "";
  const messageBody = typeof body.body === "string" ? body.body : "";
  const reply_to = typeof body.reply_to === "string" ? body.reply_to : undefined;

  if (!/^0x[0-9a-fA-F]{40}$/.test(from)) {
    res.status(400).json({ error: "from must be a 0x-prefixed 20-byte hex address" });
    return;
  }
  if (!messageBody || Buffer.byteLength(messageBody, "utf8") > MAX_BODY_BYTES) {
    res.status(400).json({ error: `body required, max ${MAX_BODY_BYTES} bytes` });
    return;
  }

  const message = enqueueMessage({ inbox_id: inbox.id, sender: from, body: messageBody, reply_to });
  res.status(201).json({ message: { id: message.id, queued_at: message.queued_at } });
}

function pollHandler(req: Request, res: Response) {
  const token = readOwnerToken(req);
  if (!token) {
    res.status(401).json({ error: "missing or malformed X-Wire-Owner-Token" });
    return;
  }
  const inbox = authenticateOwner(req.params.id, token);
  if (!inbox) {
    res.status(403).json({ error: "owner token does not authenticate this inbox" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  let max = MAX_POLL_BATCH;
  if (body.max !== undefined) {
    const n = Number(body.max);
    if (!Number.isInteger(n) || n < 1 || n > MAX_POLL_BATCH) {
      res.status(400).json({ error: `max must be an integer in [1, ${MAX_POLL_BATCH}]` });
      return;
    }
    max = n;
  }
  const messages = pollMessages(inbox.id, max);
  res.json({ messages, remaining: countQueued(inbox.id) });
}

function closeHandler(req: Request, res: Response) {
  const token = readOwnerToken(req);
  if (!token) {
    res.status(401).json({ error: "missing or malformed X-Wire-Owner-Token" });
    return;
  }
  const inbox = authenticateOwner(req.params.id, token);
  if (!inbox) {
    res.status(403).json({ error: "owner token does not authenticate this inbox" });
    return;
  }
  if (inbox.state === "closed") {
    res.status(200).json({ inbox: getInboxPublic(inbox.id) });
    return;
  }
  const closed = closeInbox(inbox.id);
  res.status(200).json({ inbox: closed });
}

// ----- Wiring ---------------------------------------------------------

export function wireRouter(): express.Router {
  ensureWireTables();
  const router = express.Router();
  router.use(express.json({ limit: "16kb" }));

  router.post("/inbox", createInboxHandler);
  router.get("/inbox/:id", getInboxHandler);
  router.post("/inbox/:id/send", sendHandler);
  router.post("/inbox/:id/poll", pollHandler);
  router.post("/inbox/:id/close", closeHandler);
  return router;
}

export const wireProduct: Product = {
  slug: SLUG,
  description:
    "Paid messaging inboxes. Free to create and read; senders pay per message.",
  paidRoutes: [
    {
      method: "POST",
      path: `/${SLUG}/inbox/:id/send`,
      price: "$0.005",
      description: "Drop a message into an open inbox.",
    },
  ],
  preValidators: [wirePreValidator],
  router: wireRouter,
  help: wireHelp,
};
