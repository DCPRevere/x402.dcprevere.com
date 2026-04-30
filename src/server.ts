import express, { type Express } from "express";
import { config } from "./core/config.js";
import { buildLandingHandler, healthHandler } from "./core/landing.js";
import { buildPaymentMiddleware } from "./core/payment.js";
import { analyticsMiddleware } from "./core/analytics-middleware.js";
import { shutdown as shutdownAnalytics } from "./core/analytics.js";
import { helpRegistry, mountHelp } from "./core/help.js";
import type { Product } from "./core/product.js";
import { figletProduct } from "./products/graphics/figlet/router.js";
import { randomProduct } from "./products/random/router.js";
import { passportProduct } from "./products/passport/router.js";
import { escrowProduct } from "./products/escrow/router.js";
import { wireProduct } from "./products/wire/router.js";
import { agoraProduct } from "./products/agora/router.js";

export const products: Product[] = [
  figletProduct,
  randomProduct,
  passportProduct,
  escrowProduct,
  wireProduct,
  agoraProduct,
];

/**
 * Build the umbrella Express app. Exported (and parameterised) so tests
 * can mount it with a custom product list without starting an HTTP listener.
 */
export function buildApp(productList: Product[] = products): Express {
  const app = express();
  app.disable("x-powered-by");

  // Reset registry per app instance — important for test runs that build
  // multiple apps with different product lists.
  helpRegistry.clear();
  for (const product of productList) {
    helpRegistry.registerProduct(product.help, "/" + product.slug);
  }

  // Help interceptor runs first so /help, ?help, and OPTIONS all bypass the
  // paywall and the per-product validators. Registered before any GET handler
  // so OPTIONS / and GET /help reach the registry instead of falling through.
  mountHelp(app);

  // Free, top-level routes — registered before the paywall so they aren't
  // considered for payment.
  app.get("/", buildLandingHandler(productList));
  app.get("/healthz", healthHandler);

  // Parse JSON bodies app-wide (16 KiB cap) so per-product preValidators that
  // run *before* the router can inspect req.body. Routers' own
  // express.json() calls become idempotent no-ops on already-parsed requests.
  app.use(express.json({ limit: "16kb" }));

  // Order matters:
  //   1. Per-product analytics (captures request_received and final-status events).
  //   2. Per-product preValidators (return 400 *before* the paywall, so buyers
  //      never pay for invalid input). Mounted under /<slug> so they only see
  //      requests for their own product.
  //   3. App-level paywall: matches paid routes by full request path.
  //   4. Per-product router: handles the actual response.
  const allPaidRoutes = productList.flatMap((p) => p.paidRoutes);

  for (const product of productList) {
    app.use(`/${product.slug}`, analyticsMiddleware(product.slug));
    for (const v of product.preValidators ?? []) {
      app.use(`/${product.slug}`, v);
    }
  }

  app.use(buildPaymentMiddleware(allPaidRoutes));

  for (const product of productList) {
    app.use(`/${product.slug}`, product.router());
  }

  return app;
}

// Only start a listener when this module is the entry point — importing
// it from tests should not bind a port.
const isEntry = import.meta.url === `file://${process.argv[1]}`;

if (isEntry) {
  const app = buildApp();
  const server = app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(
      `x402.dcprevere.com listening on :${config.port} ` +
        `(network=${config.network}, products=${products.map((p) => p.slug).join(",")})`,
    );
  });

  const gracefulShutdown = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`received ${signal}, shutting down`);
    server.close();
    await shutdownAnalytics();
    process.exit(0);
  };

  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
}
