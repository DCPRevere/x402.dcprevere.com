import express from "express";
import { ensureAgoraTables } from "./state.js";
import { agoraHelp } from "./help.js";
import { boardPreValidator, boardRouter } from "./board.js";
import { auctionPreValidator, auctionRouter } from "./auction.js";
import { barPreValidator, barRouter } from "./bar.js";
import type { Product } from "../../core/product.js";

const SLUG = "agora";

// Re-export sub-product helpers callers expect.
export { setClockForTesting, resetClockForTesting } from "./clock.js";
export { bidCommitment } from "./auction.js";

/**
 * Composite preValidator: dispatches by request path to the appropriate
 * sub-product's validator. Each sub-product's validator handles only its own
 * paid endpoints and leaves the rest alone.
 */
export function agoraPreValidator(req: express.Request, res: express.Response, next: express.NextFunction) {
  // Run sub-validators in sequence; each is a no-op for paths it doesn't own.
  // We chain by treating each as a middleware: if it sends a response, stop;
  // if it calls next, move to the next.
  const validators = [boardPreValidator, auctionPreValidator, barPreValidator];
  let i = 0;
  const advance = () => {
    if (i >= validators.length) return next();
    const v = validators[i++];
    v(req, res, advance);
  };
  advance();
}

export function agoraRouter(): express.Router {
  ensureAgoraTables();
  const router = express.Router();
  router.use("/board", boardRouter());
  router.use("/auction", auctionRouter());
  router.use("/bar", barRouter());
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
