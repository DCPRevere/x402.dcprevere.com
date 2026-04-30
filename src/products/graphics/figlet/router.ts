import express, { type Request, type Response, type NextFunction } from "express";
import { capture } from "../../../core/analytics.js";
import { listFonts, render } from "./render.js";
import { validateFigletInput, type ValidatedFigletInput } from "./validate.js";
import type { Product } from "../../../core/product.js";
import { figletHelp } from "./help.js";

const SLUG = "graphics/figlet";

function validateMiddleware(req: Request, res: Response, next: NextFunction) {
  const result = validateFigletInput(req.query);
  if (!result.ok) {
    res.status(result.status).type("text/plain").send(result.error + "\n");
    return;
  }
  (res.locals as { figletInput?: ValidatedFigletInput }).figletInput = result.value;
  next();
}

/**
 * Pre-validator mounted under `/graphics/figlet` (so `req.path` is post-strip).
 * Only runs validation on the paid render path so it returns 400 *before*
 * the paywall sees the request. Other routes (/, /fonts) pass through.
 */
export function figletPreValidator(req: Request, res: Response, next: NextFunction) {
  if (req.path === "/render") {
    return validateMiddleware(req, res, next);
  }
  next();
}

async function renderHandler(_req: Request, res: Response) {
  const input = (res.locals as { figletInput?: ValidatedFigletInput }).figletInput;
  if (!input) {
    res.status(500).type("text/plain").send("internal: validator did not run\n");
    return;
  }
  try {
    const startedAt = Date.now();
    const out = await render(input);
    const distinctId = (
      res.locals as { analytics?: { distinctId: string } }
    ).analytics?.distinctId;
    if (distinctId) {
      capture(distinctId, "product_delivered", {
        product: SLUG,
        font: input.font,
        text_length: input.text.length,
        output_lines: out.split("\n").length,
        render_ms: Date.now() - startedAt,
      });
    }
    res.type("text/plain").send(out);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "render failed";
    res.status(500).type("text/plain").send(`render error: ${msg}\n`);
  }
}

let fontsCache: string[] | null = null;
function fontsHandler(_req: Request, res: Response) {
  if (!fontsCache) fontsCache = listFonts().sort();
  res.json({ fonts: fontsCache, count: fontsCache.length });
}

function infoHandler(req: Request, res: Response) {
  const host = `${req.protocol}://${req.get("host")}`;
  res.type("text/plain").send(
    `figlet — pay-per-call ASCII art
==================================

Render text in a figfont (https://www.figlet.org). $0.10 per call.

Routes
  GET ${host}/graphics/figlet              this page
  GET ${host}/graphics/figlet/fonts        list of available fonts (free)
  GET ${host}/graphics/figlet/render       render text (PAID $0.10)
  GET ${host}/graphics/figlet/help         machine-readable catalog

Query parameters for /render:
  text   required, max 256 chars
  font   defaults to Standard; see /graphics/figlet/fonts
  width  optional, integer 20..200

Try the paywall:
  curl -i '${host}/graphics/figlet/render?text=hello'
`,
  );
}

export function figletRouter(): express.Router {
  const router = express.Router();
  router.get("/", infoHandler);
  router.get("/fonts", fontsHandler);
  router.get("/render", renderHandler);
  return router;
}

export const figletProduct: Product = {
  slug: SLUG,
  description: "Render text in a figfont (ASCII-art banners).",
  paidRoutes: [
    {
      method: "GET",
      path: `/${SLUG}/render`,
      price: "$0.10",
      description: "Render text in a figfont. $0.10 per call.",
    },
  ],
  preValidators: [figletPreValidator],
  router: figletRouter,
  help: figletHelp,
};
