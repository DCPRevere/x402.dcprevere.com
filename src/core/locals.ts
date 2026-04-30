/**
 * Module augmentation of Express.Locals so per-product validators can stash
 * typed parsed input on `res.locals` without per-handler casts.
 *
 * Each product adds its parsed-input shape here. Handlers then read with
 * full type safety: `res.locals.figletInput?.text` is `string | undefined`
 * rather than `unknown`.
 */

import type { ValidatedFigletInput } from "../products/graphics/figlet/validate.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      // Cross-cutting analytics state set by analyticsMiddleware.
      analytics?: {
        distinctId: string;
        startedAt: number;
        product: string;
        payerAddress: string | null;
      };

      // Per-product parsed inputs.
      figletInput?: ValidatedFigletInput;
      drawInput?: { spec: import("../products/random/draw.js").DrawSpec; count: number };
      escrowCreate?: import("../products/escrow/locals.js").ParsedEscrowCreate;
      agoraBoardPost?: import("../products/agora/locals.js").ParsedBoardPost;
      agoraAuctionCreate?: import("../products/agora/locals.js").ParsedAuctionCreate;
      agoraAuctionBid?: import("../products/agora/locals.js").ParsedAuctionBid;
      agoraBarSay?: import("../products/agora/locals.js").ParsedBarSay;
      wireSend?: import("../products/wire/locals.js").ParsedWireSend;
    }
  }
}

// Intentionally empty — this file exists for the side-effect declare global.
export {};
