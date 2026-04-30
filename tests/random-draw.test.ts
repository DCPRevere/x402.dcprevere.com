import { describe, it, expect } from "vitest";
import {
  freshSeed,
  drawCoinOrDie,
  drawRange,
  drawBytes,
  drawUuidV4,
  drawChoose,
  drawShuffle,
  drawDnd,
  drawNormal,
  drawExponential,
  drawPoisson,
} from "../src/products/random/draw.js";
import { validateDrawInput } from "../src/products/random/validate-draw.js";

describe("random/draw — pure derivations", () => {
  const fixedSeed = Buffer.from(
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "hex",
  );

  it("freshSeed returns 32 bytes of randomness", () => {
    const a = freshSeed();
    const b = freshSeed();
    expect(a.length).toBe(32);
    expect(b.length).toBe(32);
    expect(a.equals(b)).toBe(false);
  });

  it("drawCoinOrDie is deterministic given the same seed", () => {
    const a = drawCoinOrDie(fixedSeed, 6, 5);
    const b = drawCoinOrDie(fixedSeed, 6, 5);
    expect(a).toEqual(b);
    expect(a.length).toBe(5);
    for (const v of a) expect(v).toBeGreaterThanOrEqual(1);
    for (const v of a) expect(v).toBeLessThanOrEqual(6);
  });

  it("drawRange respects bounds", () => {
    const out = drawRange(fixedSeed, 10, 20, 50);
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(10);
      expect(v).toBeLessThanOrEqual(20);
    }
  });

  it("drawBytes returns hex of the requested length", () => {
    expect(drawBytes(fixedSeed, 16).length).toBe(32);
    expect(drawBytes(fixedSeed, 32).length).toBe(64);
  });

  it("drawUuidV4 produces a valid v4-shaped UUID", () => {
    const u = drawUuidV4(fixedSeed);
    expect(u).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("drawChoose returns one of the labels (uniform)", () => {
    const labels = ["alice", "bob", "carol"];
    const v = drawChoose(fixedSeed, labels);
    expect(labels).toContain(v);
  });

  it("drawChoose with weights respects relative probabilities (smoke)", () => {
    const labels = ["a", "b"];
    // Heavy weight on "b" — across many seeds, "b" should win the majority.
    let bWins = 0;
    for (let i = 0; i < 200; i++) {
      const seed = freshSeed();
      const v = drawChoose(seed, labels, [0.05, 0.95]);
      if (v === "b") bWins++;
    }
    expect(bWins).toBeGreaterThan(140);
  });

  it("drawShuffle returns a permutation", () => {
    const items = [1, 2, 3, 4, 5];
    const out = drawShuffle(fixedSeed, items);
    expect(out.slice().sort()).toEqual(items);
    expect(out).not.toEqual(items); // exceedingly unlikely to be identical
  });

  it("drawDnd parses 4d6kh3 and keeps top three", () => {
    const r = drawDnd(fixedSeed, { dice: 4, sides: 6, modifier: "kh", keep: 3 });
    expect(r.rolls.length).toBe(4);
    expect(r.kept.length).toBe(3);
    expect(r.total).toBe(r.kept.reduce((a, b) => a + b, 0));
    // Verify "keep highest" by checking the dropped die is the smallest.
    const sorted = r.rolls.slice().sort((a, b) => a - b);
    expect(r.kept).toEqual(sorted.slice(1));
  });

  it("drawNormal produces finite samples", () => {
    const out = drawNormal(fixedSeed, 0, 1, 10);
    for (const v of out) expect(Number.isFinite(v)).toBe(true);
  });

  it("drawExponential samples are non-negative", () => {
    const out = drawExponential(fixedSeed, 1, 10);
    for (const v of out) expect(v).toBeGreaterThanOrEqual(0);
  });

  it("drawPoisson samples are non-negative integers", () => {
    const out = drawPoisson(fixedSeed, 3, 20);
    for (const v of out) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  // Review item #4: lambda above the Knuth method's safe range must throw
  // rather than silently iterate to the cap and return garbage.
  it("drawPoisson rejects lambda above the safe range", () => {
    expect(() => drawPoisson(fixedSeed, 100, 1)).toThrow();
  });
});

describe("random/draw — validator", () => {
  it("default empty query → coin flip (sides=2)", () => {
    const r = validateDrawInput({});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.sides).toBe(2);
      expect(r.count).toBe(1);
    }
  });

  it("rejects multiple shape parameters", () => {
    const r = validateDrawInput({ sides: "6", bytes: "4" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/pick exactly one/);
  });

  it("accepts dnd notation '4d6kh3'", () => {
    const r = validateDrawInput({ dnd: "4d6kh3" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.dnd).toEqual({ dice: 4, sides: 6, modifier: "kh", keep: 3 });
    }
  });

  it("rejects malformed dnd", () => {
    const r = validateDrawInput({ dnd: "garbage" });
    expect(r.ok).toBe(false);
  });

  it("accepts range '1-100'", () => {
    const r = validateDrawInput({ range: "1-100" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.range).toEqual({ lo: 1, hi: 100 });
  });

  it("rejects range hi < lo", () => {
    const r = validateDrawInput({ range: "10-1" });
    expect(r.ok).toBe(false);
  });

  it("accepts weights matching choose length", () => {
    const r = validateDrawInput({ choose: "a,b,c", weights: "0.5,0.3,0.2" });
    expect(r.ok).toBe(true);
  });

  it("rejects weights with mismatched length", () => {
    const r = validateDrawInput({ choose: "a,b,c", weights: "0.5,0.5" });
    expect(r.ok).toBe(false);
  });

  it("rejects bytes > 256", () => {
    const r = validateDrawInput({ bytes: "1000" });
    expect(r.ok).toBe(false);
  });

  it("accepts uuid=v4", () => {
    const r = validateDrawInput({ uuid: "v4" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.uuid).toBe("v4");
  });

  it("rejects unknown uuid version", () => {
    const r = validateDrawInput({ uuid: "v1" });
    expect(r.ok).toBe(false);
  });

  it("accepts distribution=normal with mu/sigma", () => {
    const r = validateDrawInput({ distribution: "normal", mu: "5", sigma: "2" });
    expect(r.ok).toBe(true);
    if (r.ok && r.spec.distribution?.kind === "normal") {
      expect(r.spec.distribution.mu).toBe(5);
      expect(r.spec.distribution.sigma).toBe(2);
    }
  });

  it("rejects sigma <= 0", () => {
    const r = validateDrawInput({ distribution: "normal", sigma: "0" });
    expect(r.ok).toBe(false);
  });
});
