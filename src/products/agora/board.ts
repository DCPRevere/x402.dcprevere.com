import express, { type Request, type Response, type NextFunction } from "express";
import { isAddress } from "../../core/addr.js";
import { insertBoardPost, listBoardPosts, getBoardPost } from "./state.js";

export const BOARD_BODY_MAX = 512;

/** Pre-validator for /agora/board/post. Stashes parsed input on res.locals. */
export function boardPreValidator(req: Request, res: Response, next: NextFunction) {
  if (req.method !== "POST" || req.path !== "/board/post") return next();
  if (!req.body || typeof req.body !== "object") {
    res.status(400).json({ error: "JSON body required" });
    return;
  }
  const body = req.body as Record<string, unknown>;
  const author = typeof body.author === "string" ? body.author : "";
  const text = typeof body.body === "string" ? body.body : "";
  if (!isAddress(author)) {
    res.status(400).json({ error: "author must be a 0x-prefixed 20-byte hex address" });
    return;
  }
  if (!text || Buffer.byteLength(text, "utf8") > BOARD_BODY_MAX) {
    res.status(400).json({ error: `body required, max ${BOARD_BODY_MAX} bytes` });
    return;
  }
  res.locals.agoraBoardPost = { author, body: text };
  next();
}

function postHandler(_req: Request, res: Response) {
  const input = res.locals.agoraBoardPost;
  if (!input) {
    res.status(500).json({ error: "internal: validator did not run" });
    return;
  }
  const post = insertBoardPost({ author: input.author, body: input.body });
  res.status(201).json({ post });
}

function listHandler(req: Request, res: Response) {
  const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : 50;
  if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 100) {
    res.status(400).json({ error: "limit must be an integer in [1, 100]" });
    return;
  }
  res.json({ posts: listBoardPosts(limitRaw) });
}

function getHandler(req: Request, res: Response) {
  const post = getBoardPost(req.params.id);
  if (!post) {
    res.status(404).json({ error: "no such post" });
    return;
  }
  res.json({ post });
}

export function boardRouter(): express.Router {
  const router = express.Router();
  router.post("/post", postHandler);
  router.get("/", listHandler);
  router.get("/:id", getHandler);
  return router;
}
