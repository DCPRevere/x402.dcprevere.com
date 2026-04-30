// Side-effect import: registers the Express.Locals module augmentation so
// res.locals.<key> is typed across all handlers. Must be imported before
// any other module that reads res.locals.
import "./core/locals.js";

import express, { type Express } from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { config } from "./core/config.js";
import { log } from "./core/log.js";
import { errBody, codes } from "./core/errors.js";
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

  // Trust the first proxy hop so req.ip reflects the original client and
  // express-rate-limit can key on it correctly behind Railway/Fly's proxy.
  app.set("trust proxy", 1);

  // CORS — agents using browser-side fetch wrappers need permissive CORS
  // for response-header access. Public, read-only API. Fixes review item #28.
  //
  // We do NOT let cors() short-circuit OPTIONS, because /help uses OPTIONS
  // as a help-discovery verb (see helpMiddleware). Setting `preflightContinue:
  // true` makes cors() set the headers and call next(); the help middleware
  // then handles the OPTIONS response. Real browser preflights still get
  // valid CORS headers via the same path.
  const corsMiddleware = cors({
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-PAYMENT", "X-Wire-Owner-Token", "If-None-Match"],
    exposedHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", "Link", "ETag"],
    maxAge: 600,
    preflightContinue: true,
  });
  app.use(corsMiddleware);

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

  // Parse JSON and (defensively) urlencoded bodies app-wide. 16 KiB cap on
  // both. Per-product preValidators run *before* the router and need
  // req.body parsed, hence the app-level placement (review item #29).
  app.use(express.json({ limit: "16kb" }));
  app.use(express.urlencoded({ limit: "16kb", extended: false }));

  // Rate-limit free routes per IP. Paid routes self-limit via the cost of
  // payment; free routes (catalog, GETs, polls) need explicit protection
  // (review item #16). 120 req/min/IP = 2 rps sustained which is generous
  // for honest agents and slow enough to make a $0 DDoS unattractive.
  // Disabled in tests so suites that hammer endpoints don't flake.
  if (process.env.NODE_ENV !== "test") {
    const freeRouteLimiter = rateLimit({
      windowMs: 60_000,
      limit: 120,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      skip: (req) => {
        if (req.path === "/healthz") return true;
        if (req.method !== "GET" && req.header("x-payment")) return true;
        return false;
      },
      message: { error: "rate limit exceeded; slow down or pay" },
    });
    app.use(freeRouteLimiter);
  }

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

  // Last-line error handler. Logs the failure, emits the structured error
  // envelope (core/errors.ts), and shields the client from Express's default
  // HTML stack trace.
  app.use(((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack?.split("\n").slice(0, 5).join("\n") : undefined;
    log.error("unhandled_error", { route: req.path, method: req.method, message, stack });
    if (res.headersSent) return;
    res.status(500).type("application/json").send(
      JSON.stringify(errBody({ code: codes.internal, message: "internal error" })),
    );
  }) as express.ErrorRequestHandler);

  return app;
}

// Only start a listener when this module is the entry point — importing
// it from tests should not bind a port.
const isEntry = import.meta.url === `file://${process.argv[1]}`;

if (isEntry) {
  const app = buildApp();
  const server = app.listen(config.port, () => {
    log.info("server_started", {
      port: config.port,
      network: config.network,
      products: products.map((p) => p.slug),
    });
  });

  const gracefulShutdown = async (signal: string) => {
    log.info("server_shutdown", { signal });
    server.close();
    await shutdownAnalytics();
    process.exit(0);
  };

  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
}
