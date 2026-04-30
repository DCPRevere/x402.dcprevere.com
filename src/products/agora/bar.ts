import express, { type Request, type Response, type NextFunction } from "express";
import { isAddress } from "../../core/addr.js";
import { now } from "./clock.js";
import {
  insertBarLine,
  listBarLinesSince,
  listBarLinesRecent,
  pruneBarLines,
  countBarLinesBySpeakerSince,
  totalBarLines,
} from "./state.js";

export const BAR_LINE_MAX = 256;
export const BAR_KEEP = 5000;
export const BAR_PRUNE_EVERY = 100;
export const BAR_PER_SPEAKER_LIMIT = 60;
export const BAR_PER_SPEAKER_WINDOW_MS = 60_000;

export function barPreValidator(req: Request, res: Response, next: NextFunction) {
  if (req.method !== "POST" || req.path !== "/bar/say") return next();
  if (!req.body || typeof req.body !== "object") {
    res.status(400).json({ error: "JSON body required" });
    return;
  }
  const body = req.body as Record<string, unknown>;
  const speaker = typeof body.speaker === "string" ? body.speaker : "";
  const line = typeof body.line === "string" ? body.line : "";
  if (!isAddress(speaker)) {
    res.status(400).json({ error: "speaker must be a 0x-prefixed 20-byte hex address" });
    return;
  }
  if (!line || line.length > BAR_LINE_MAX) {
    res.status(400).json({ error: `line required, max ${BAR_LINE_MAX} chars` });
    return;
  }
  res.locals.agoraBarSay = { speaker, line };
  next();
}

function sayHandler(_req: Request, res: Response) {
  const input = res.locals.agoraBarSay;
  if (!input) {
    res.status(500).json({ error: "internal: validator did not run" });
    return;
  }
  // Per-speaker fairness quota (review item #24): a single wallet can't
  // monopolise the bar's rolling buffer.
  const since = new Date(now().getTime() - BAR_PER_SPEAKER_WINDOW_MS).toISOString();
  if (countBarLinesBySpeakerSince(input.speaker, since) >= BAR_PER_SPEAKER_LIMIT) {
    res.status(429).json({
      error: "bar quota exceeded",
      detail: `max ${BAR_PER_SPEAKER_LIMIT} lines per ${BAR_PER_SPEAKER_WINDOW_MS / 1000}s per speaker`,
    });
    return;
  }
  const inserted = insertBarLine({ speaker: input.speaker, line: input.line });
  // Amortise pruning by reading the table's auto-incrementing id rather than
  // a process-local counter (which doesn't survive restarts and is shared
  // across tests). When the latest id is divisible by BAR_PRUNE_EVERY, we
  // prune. With AUTOINCREMENT this is monotonic, so each "milestone" id
  // triggers pruning exactly once.
  if (inserted.id % BAR_PRUNE_EVERY === 0) {
    pruneBarLines(BAR_KEEP);
  }
  // Belt-and-braces: if the table grew well past BAR_KEEP between milestones
  // (e.g. from a burst of inserts crossing the threshold), prune anyway.
  // Cheap when the COUNT is below threshold.
  if (totalBarLines() > BAR_KEEP * 2) {
    pruneBarLines(BAR_KEEP);
  }
  res.status(201).json({ line: inserted });
}

function tailHandler(req: Request, res: Response) {
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

export function barRouter(): express.Router {
  const router = express.Router();
  router.post("/say", sayHandler);
  router.get("/", tailHandler);
  return router;
}
