import type { Router, RequestHandler } from "express";

/**
 * Each product is a self-contained x402-paid API mounted under /<slug>.
 * The umbrella server merges all products' paidRoutes into one paymentMiddleware
 * call, then mounts each product's router.
 *
 * preValidators run *before* the paywall so a request with bad input returns
 * 400 without ever reaching 402 — buyers don't pay for invalid requests.
 */
export interface Product {
  slug: string;
  description: string;
  paidRoutes: PaidRoute[];
  /**
   * Optional middlewares mounted under `/<slug>` and run before the paywall.
   * `req.path` inside these has the slug prefix stripped, so a validator for
   * a paid `/<slug>/render` route checks `req.path === "/render"`.
   */
  preValidators?: RequestHandler[];
  router(): Router;
}

export interface PaidRoute {
  /** Express method, uppercase, e.g. "GET". */
  method: "GET" | "POST";
  /** Full request path the paywall must match, e.g. "/figlet/render". */
  path: string;
  /** USDC amount as a dollar string, e.g. "$0.10". Leading $ is required by x402. */
  price: string;
  /** Human-readable description shown in the 402 response. */
  description: string;
}
