import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { figletProduct } from "../src/products/figlet/router.js";
import * as analytics from "../src/core/analytics.js";

/**
 * Exercises the figlet router directly, bypassing the paywall, so we can
 * assert behavior of `renderHandler` (rendering, analytics emission, error
 * paths) without involving payment middleware in the test.
 */
function appWithRouter() {
  const app = express();
  // Stand-in analytics: just attach a distinct_id so renderHandler emits.
  app.use("/figlet", (_req, res, next) => {
    (res.locals as { analytics?: { distinctId: string } }).analytics = {
      distinctId: "test-id",
    };
    next();
  });
  // Stand-in pre-validator: pre-set the validated input so renderHandler runs.
  app.use("/figlet", (req, res, next) => {
    if (req.path === "/render") {
      (
        res.locals as {
          figletInput?: { text: string; font: string; width: undefined };
        }
      ).figletInput = {
        text: typeof req.query.text === "string" ? req.query.text : "hi",
        font: "Standard",
        width: undefined,
      };
    }
    next();
  });
  app.use("/figlet", figletProduct.router());
  return app;
}

describe("figlet renderHandler", () => {
  it("renders text/plain ASCII for valid input", async () => {
    const app = appWithRouter();
    const res = await request(app).get("/figlet/render?text=hi");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.text.length).toBeGreaterThan(0);
    expect(res.text.split("\n").length).toBeGreaterThan(1);
  });

  it("emits a product_rendered analytics event with the right shape", async () => {
    const events: { event: string; props: Record<string, unknown> }[] = [];
    vi.spyOn(analytics, "capture").mockImplementation((_id, event, props) => {
      events.push({ event, props: props ?? {} });
    });
    const app = appWithRouter();
    await request(app).get("/figlet/render?text=hi");
    const rendered = events.find((e) => e.event === "product_rendered");
    expect(rendered).toBeDefined();
    expect(rendered!.props.product).toBe("figlet");
    expect(rendered!.props.font).toBe("Standard");
    expect(rendered!.props.text_length).toBe(2);
    expect(typeof rendered!.props.render_ms).toBe("number");
  });

  it("returns 500 when the validator middleware did not run", async () => {
    // App that mounts the router but doesn't pre-set figletInput.
    const app = express();
    app.use("/figlet", figletProduct.router());
    const res = await request(app).get("/figlet/render?text=hi");
    expect(res.status).toBe(500);
    expect(res.text).toMatch(/validator did not run/);
  });
});
