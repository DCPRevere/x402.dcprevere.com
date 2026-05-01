import type { Request, Response } from "express";
import { config } from "./config.js";
import type { Product } from "./product.js";

export function buildLandingHandler(products: Product[]) {
  return function (req: Request, res: Response) {
    const host = `${req.protocol}://${req.get("host")}`;

    const productLines = products
      .map((p) => {
        const paid = p.paidRoutes.map((r) => `      ${r.method} ${r.path}  ${r.price}`).join("\n");
        return `  /${p.slug}\n      ${p.description}\n${paid}`;
      })
      .join("\n\n");

    const sample = products[0];
    const sampleCurl = sample
      ? `  curl -i '${host}${sample.paidRoutes[0]?.path ?? "/" + sample.slug}'`
      : "";

    const body = `x402.aegent.dev — pay-per-call APIs for the agentic economy
==============================================================

Products (each charges in USDC on Base via x402):

${productLines}

Free routes
  GET /healthz       liveness
  GET /              this page

${sample ? `Try the paywall (returns 402 + payment instructions):\n${sampleCurl}\n\n` : ""}Network: ${config.network}
Pay to:  ${config.payTo}
`;

    res.type("text/plain").send(body);
  };
}

export function healthHandler(_req: Request, res: Response) {
  res.json({ ok: true });
}
