import express, { type Express } from "express";
import { config } from "./core/config.js";
import { buildLandingHandler, healthHandler } from "./core/landing.js";
import { buildPaymentMiddleware } from "./core/payment.js";
import { analyticsMiddleware } from "./core/analytics-middleware.js";
import { shutdown as shutdownAnalytics } from "./core/analytics.js";
import type { Product } from "./core/product.js";
import { figletProduct } from "./products/figlet/router.js";

export const products: Product[] = [figletProduct];

/**
 * Build the umbrella Express app. Exported (and parameterised) so tests
 * can mount it with a custom product list without starting an HTTP listener.
 */
export function buildApp(productList: Product[] = products): Express {
  const app = express();
  app.disable("x-powered-by");

  // Free, top-level routes — registered before the paywall so they aren't
  // considered for payment.
  app.get("/", buildLandingHandler(productList));
  app.get("/healthz", healthHandler);

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
