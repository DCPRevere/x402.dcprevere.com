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
      expect(res.text).toContain("graphics/figlet");
      expect(res.text).toContain("$0.10");
    });

    it("GET /graphics/figlet returns the product info page", async () => {
      const res = await request(app).get("/graphics/figlet");
      expect(res.status).toBe(200);
      expect(res.text).toContain("PAID $0.10");
    });

    it("GET /graphics/figlet/fonts lists fonts as JSON", async () => {
      const res = await request(app).get("/graphics/figlet/fonts");
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
      const res = await request(app).get("/graphics/figlet/render");
      expect(res.status).toBe(400);
      expect(res.text).toMatch(/text query parameter is required/);
    });

    it("unknown font returns 400 (not 402)", async () => {
      const res = await request(app).get("/graphics/figlet/render?text=hi&font=NotAFont");
      expect(res.status).toBe(400);
      expect(res.text).toMatch(/unknown font/);
    });

    it("text past the length cap returns 400 (not 402)", async () => {
      const res = await request(app).get(
        `/graphics/figlet/render?text=${"x".repeat(257)}`,
      );
      expect(res.status).toBe(400);
    });
  });

  describe("paywall fires on valid paid requests", () => {
    it("valid request without X-PAYMENT returns 402", async () => {
      const res = await request(app).get("/graphics/figlet/render?text=hi");
      expect(res.status).toBe(402);
    });

    it("402 response carries Link headers pointing at help and catalog", async () => {
      const res = await request(app).get("/graphics/figlet/render?text=hi");
      expect(res.status).toBe(402);
      const link = res.headers["link"];
      expect(typeof link).toBe("string");
      expect(link).toMatch(/rel="self-help"/);
      expect(link).toMatch(/rel="catalog"/);
    });

    it("free routes (e.g. /graphics/figlet/fonts) are not protected", async () => {
      const free = await request(app).get("/graphics/figlet/fonts");
      expect(free.status).toBe(200);
    });
  });

  describe("error envelope", () => {
    it("404 for unknown product is JSON-shaped", async () => {
      const res = await request(app).get("/no-such-product/help");
      // /help middleware handles missing nodes with its own 404 envelope.
      expect(res.status).toBe(404);
      expect(res.body.error).toBeDefined();
    });
  });
});
