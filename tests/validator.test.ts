import { describe, it, expect } from "vitest";
import { validateFigletInput } from "../src/products/figlet/validate.js";

describe("validateFigletInput", () => {
  it("accepts a minimal valid input", () => {
    const r = validateFigletInput({ text: "hi" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.text).toBe("hi");
      expect(r.value.font).toBe("Standard");
      expect(r.value.width).toBeUndefined();
    }
  });

  it("rejects missing text", () => {
    const r = validateFigletInput({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it("rejects empty text", () => {
    const r = validateFigletInput({ text: "" });
    expect(r.ok).toBe(false);
  });

  it("rejects text over the length cap", () => {
    const r = validateFigletInput({ text: "x".repeat(257) });
    expect(r.ok).toBe(false);
  });

  it("accepts text at the length cap", () => {
    const r = validateFigletInput({ text: "x".repeat(256) });
    expect(r.ok).toBe(true);
  });

  it("rejects unknown font", () => {
    const r = validateFigletInput({ text: "hi", font: "DefinitelyNotAFont" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown font/);
  });

  it("accepts a known font", () => {
    const r = validateFigletInput({ text: "hi", font: "Slant" });
    expect(r.ok).toBe(true);
  });

  it("rejects non-integer width", () => {
    const r = validateFigletInput({ text: "hi", width: "12.5" });
    expect(r.ok).toBe(false);
  });

  it("rejects width below the minimum", () => {
    const r = validateFigletInput({ text: "hi", width: "10" });
    expect(r.ok).toBe(false);
  });

  it("rejects width above the maximum", () => {
    const r = validateFigletInput({ text: "hi", width: "500" });
    expect(r.ok).toBe(false);
  });

  it("accepts width within bounds", () => {
    const r = validateFigletInput({ text: "hi", width: "80" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.width).toBe(80);
  });
});
