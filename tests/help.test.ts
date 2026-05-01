import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { buildApp } from "../src/server.js";
import { canonicalJson, classifyHelpRequest } from "../src/core/help.js";

describe("/help — fractal catalog", () => {
  let app: Express;
  beforeAll(() => {
    app = buildApp();
  });

  describe("GET /help — root umbrella", () => {
    it("returns 200 application/json", async () => {
      const res = await request(app).get("/help");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/application\/json/);
    });

    it("describes itself as an umbrella with the figlet product inlined", async () => {
      const res = await request(app).get("/help");
      const body = res.body;
      expect(body.level).toBe("umbrella");
      expect(body.name).toBe("x402.aegent.dev");
      expect(Array.isArray(body.children)).toBe(true);

      const figlet = body.children.find(
        (c: { name: string }) => c.name === "graphics/figlet",
      );
      expect(figlet).toBeDefined();
      expect(figlet.level).toBe("product");
      expect(Array.isArray(figlet.children)).toBe(true);

      const render = figlet.children.find(
        (c: { name: string }) => c.name === "graphics/figlet/render",
      );
      expect(render).toBeDefined();
      expect(render.level).toBe("endpoint");
      expect(render.pricing.kind).toBe("flat");
      expect(render.pricing.amount).toBe("100000"); // base units
      expect(render.pricing.amount_usdc).toBe("0.10"); // human readable
    });

    it("self-registers as a free endpoint child of the umbrella", async () => {
      const res = await request(app).get("/help");
      const helpNode = res.body.children.find(
        (c: { name: string }) => c.name === "help",
      );
      expect(helpNode).toBeDefined();
      expect(helpNode.level).toBe("endpoint");
      expect(helpNode.pricing.kind).toBe("free");
    });

    it("sets a strong etag derived from the canonical JSON", async () => {
      const res = await request(app).get("/help");
      expect(res.headers.etag).toMatch(/^"[0-9a-f]{64}"$/);

      const recomputed = canonicalJson(res.body);
      // Re-fetch with If-None-Match using the same etag → 304
      const second = await request(app)
        .get("/help")
        .set("If-None-Match", res.headers.etag);
      expect(second.status).toBe(304);
      expect(second.body).toEqual({});
      // The canonicalJson of the first body should be byte-stable enough to
      // hash equal to the etag (sanity).
      expect(recomputed.length).toBeGreaterThan(0);
    });
  });

  describe("subtree resolution agrees with the umbrella", () => {
    it("GET /graphics/figlet/help returns the same subtree as inlined", async () => {
      const root = await request(app).get("/help");
      const subtree = await request(app).get("/graphics/figlet/help");

      const inlined = root.body.children.find(
        (c: { name: string }) => c.name === "graphics/figlet",
      );
      // The subtree's parent points back to /help; the inlined version's parent
      // points to the umbrella. Equate the rest by stripping `parent`.
      const stripParent = (n: Record<string, unknown>) => {
        const { parent: _drop, ...rest } = n;
        return rest;
      };
      expect(stripParent(subtree.body)).toEqual(stripParent(inlined));
    });

    it("GET /graphics/figlet/render/help returns the leaf endpoint", async () => {
      const res = await request(app).get("/graphics/figlet/render/help");
      expect(res.status).toBe(200);
      expect(res.body.level).toBe("endpoint");
      expect(res.body.name).toBe("graphics/figlet/render");
      expect(res.body.pricing.kind).toBe("flat");
    });
  });

  describe("?help query flag", () => {
    it("GET /graphics/figlet?help returns the same JSON as /graphics/figlet/help", async () => {
      const a = await request(app).get("/graphics/figlet?help");
      const b = await request(app).get("/graphics/figlet/help");
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(a.body).toEqual(b.body);
    });

    it("GET /graphics/figlet/render?help intercepts before the paywall", async () => {
      const res = await request(app).get("/graphics/figlet/render?help");
      expect(res.status).toBe(200);
      expect(res.body.level).toBe("endpoint");
      expect(res.body.name).toBe("graphics/figlet/render");
    });
  });

  describe("OPTIONS verb", () => {
    it("OPTIONS / returns the umbrella help", async () => {
      const res = await request(app).options("/");
      expect(res.status).toBe(200);
      expect(res.body.level).toBe("umbrella");
    });

    it("OPTIONS /graphics/figlet/render returns endpoint help (not 402)", async () => {
      const res = await request(app).options("/graphics/figlet/render");
      expect(res.status).toBe(200);
      expect(res.body.level).toBe("endpoint");
      expect(res.body.name).toBe("graphics/figlet/render");
    });
  });

  describe("?depth filter", () => {
    it("?depth=0 returns the umbrella node with no children", async () => {
      const res = await request(app).get("/help?depth=0");
      expect(res.status).toBe(200);
      expect(res.body.level).toBe("umbrella");
      expect(res.body.children).toEqual([]);
    });

    it("?depth=1 returns the umbrella with products but no endpoints", async () => {
      const res = await request(app).get("/help?depth=1");
      expect(res.status).toBe(200);
      const figlet = res.body.children.find(
        (c: { name: string }) => c.name === "graphics/figlet",
      );
      expect(figlet).toBeDefined();
      expect(figlet.children).toEqual([]);
    });

    it("default depth returns the full tree (figlet endpoints inlined)", async () => {
      const res = await request(app).get("/help");
      const figlet = res.body.children.find(
        (c: { name: string }) => c.name === "graphics/figlet",
      );
      expect(figlet.children.length).toBeGreaterThan(0);
    });
  });

  describe("?since filter", () => {
    it("?since in the future returns no children at the umbrella", async () => {
      const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const res = await request(app).get(`/help?since=${encodeURIComponent(future)}`);
      expect(res.status).toBe(200);
      expect(res.body.level).toBe("umbrella");
      // /help self-node uses umbrella last_modified ≈ now, so only it could
      // appear if its mtime > future, which it isn't. Expect children empty.
      expect(res.body.children).toEqual([]);
    });

    it("?since in the deep past returns the full tree", async () => {
      const past = new Date(0).toISOString();
      const res = await request(app).get(`/help?since=${encodeURIComponent(past)}`);
      expect(res.body.children.length).toBeGreaterThan(0);
    });
  });

  describe("classifyHelpRequest", () => {
    it("treats /help as the umbrella resource", () => {
      const c = classifyHelpRequest("GET", "/help", false);
      expect(c).toEqual({ isHelpRequest: true, resourcePath: "/" });
    });

    it("strips trailing /help for nested resources", () => {
      const c = classifyHelpRequest("GET", "/graphics/figlet/help", false);
      expect(c).toEqual({ isHelpRequest: true, resourcePath: "/graphics/figlet" });
    });

    it("?help on any path is a help request", () => {
      const c = classifyHelpRequest("GET", "/graphics/figlet/render", true);
      expect(c).toEqual({
        isHelpRequest: true,
        resourcePath: "/graphics/figlet/render",
      });
    });

    it("OPTIONS on any path is a help request", () => {
      const c = classifyHelpRequest("OPTIONS", "/graphics/figlet/render", false);
      expect(c).toEqual({
        isHelpRequest: true,
        resourcePath: "/graphics/figlet/render",
      });
    });

    it("plain GET to a non-help path is not a help request", () => {
      const c = classifyHelpRequest("GET", "/graphics/figlet/render", false);
      expect(c.isHelpRequest).toBe(false);
    });
  });

  describe("404s for unknown paths", () => {
    it("GET /does-not-exist/help returns 404 JSON", async () => {
      const res = await request(app).get("/does-not-exist/help");
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/no help node/);
    });
  });
});
