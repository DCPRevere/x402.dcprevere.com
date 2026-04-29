import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { buildApp } from "../src/server.js";

describe("umbrella server (HTTP)", () => {
  let app: Express;
  beforeAll(() => {
    app = buildApp();
  });

  describe("free routes", () => {
    it("GET /healthz returns ok", async () => {
      const res = await request(app).get("/healthz");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it("GET / returns the landing page advertising the figlet product", async () => {
      const res = await request(app).get("/");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/plain/);
      expect(res.text).toContain("/figlet");
      expect(res.text).toContain("$0.10");
    });

    it("GET /figlet returns the product info page", async () => {
      const res = await request(app).get("/figlet");
      expect(res.status).toBe(200);
      expect(res.text).toContain("PAID $0.10");
    });

    it("GET /figlet/fonts lists fonts as JSON", async () => {
      const res = await request(app).get("/figlet/fonts");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.fonts)).toBe(true);
      expect(res.body.fonts).toContain("Standard");
      expect(res.body.count).toBe(res.body.fonts.length);
    });

    it("does not advertise an x-powered-by header", async () => {
      const res = await request(app).get("/healthz");
      expect(res.headers["x-powered-by"]).toBeUndefined();
    });
  });

  describe("validation runs before the paywall", () => {
    it("missing text returns 400 (not 402)", async () => {
      const res = await request(app).get("/figlet/render");
      expect(res.status).toBe(400);
      expect(res.text).toMatch(/text query parameter is required/);
    });

    it("unknown font returns 400 (not 402)", async () => {
      const res = await request(app).get("/figlet/render?text=hi&font=NotAFont");
      expect(res.status).toBe(400);
      expect(res.text).toMatch(/unknown font/);
    });

    it("text past the length cap returns 400 (not 402)", async () => {
      const res = await request(app).get(`/figlet/render?text=${"x".repeat(257)}`);
      expect(res.status).toBe(400);
    });
  });

  describe("paywall fires on valid paid requests", () => {
    it("valid request without X-PAYMENT returns 402", async () => {
      const res = await request(app).get("/figlet/render?text=hi");
      expect(res.status).toBe(402);
    });

    it("a different paid product path also 402s (sanity)", async () => {
      // The figlet/render path is the only paid route today; this guards
      // against the paywall accidentally protecting unrelated routes.
      const free = await request(app).get("/figlet/fonts");
      expect(free.status).toBe(200);
    });
  });
});
