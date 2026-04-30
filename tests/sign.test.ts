import { describe, it, expect, beforeEach } from "vitest";
import {
  attestMac,
  verifyMac,
  signClaim,
  verifyClaim,
  resetSecretForTesting,
  CLAIM_VERSION,
} from "../src/core/sign.js";

describe("attestation MACs", () => {
  beforeEach(() => {
    resetSecretForTesting("test-secret-of-sufficient-length-for-hmac");
  });

  it("MACs are deterministic for the same payload", () => {
    const a = attestMac({ foo: "bar", n: 1 });
    const b = attestMac({ foo: "bar", n: 1 });
    expect(a).toBe(b);
  });

  it("verifyMac accepts a signed claim", () => {
    const claim = { foo: "bar", n: 1 };
    const mac = attestMac(claim);
    expect(verifyMac(claim, mac)).toBe(true);
  });

  it("verifyMac rejects modifications", () => {
    const mac = attestMac({ foo: "bar", n: 1 });
    expect(verifyMac({ foo: "bar", n: 2 }, mac)).toBe(false);
  });

  it("rejects swapped order via canonical JSON", () => {
    // Even if the JS object literal swaps order, canonical JSON sorts keys.
    const m1 = attestMac({ a: 1, b: 2 });
    const m2 = attestMac({ b: 2, a: 1 });
    expect(m1).toBe(m2);
  });

  it("legacy aliases (signClaim, verifyClaim) match new names", () => {
    const claim = { hello: "world" };
    expect(signClaim(claim)).toBe(attestMac(claim));
    expect(verifyClaim(claim, attestMac(claim))).toBe(true);
  });

  it("CLAIM_VERSION is exported and a positive integer", () => {
    expect(CLAIM_VERSION).toBeGreaterThan(0);
    expect(Number.isInteger(CLAIM_VERSION)).toBe(true);
  });

  it("a different secret produces a different MAC", () => {
    const claim = { same: "claim" };
    resetSecretForTesting("secret-A-with-enough-length");
    const a = attestMac(claim);
    resetSecretForTesting("secret-B-with-enough-length");
    const b = attestMac(claim);
    expect(a).not.toBe(b);
  });

  it("verifyMac handles malformed signatures without throwing", () => {
    expect(verifyMac({ foo: 1 }, "not-hex-at-all")).toBe(false);
    expect(verifyMac({ foo: 1 }, "ab")).toBe(false);
    expect(verifyMac({ foo: 1 }, "")).toBe(false);
  });
});
