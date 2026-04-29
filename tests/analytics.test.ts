import { describe, it, expect } from "vitest";
import { capture, hashPayer, newDistinctId, shutdown } from "../src/core/analytics.js";

describe("analytics module (no-op when POSTHOG_KEY is unset)", () => {
  it("capture is a no-op and never throws", () => {
    expect(() => capture("anyone", "request_received", { x: 1 })).not.toThrow();
  });

  it("shutdown is a no-op and resolves cleanly", async () => {
    await expect(shutdown()).resolves.toBeUndefined();
  });
});

describe("hashPayer", () => {
  it("produces a 12-char hex digest", () => {
    const h = hashPayer("0x1111111111111111111111111111111111111111");
    expect(h).toMatch(/^[0-9a-f]{12}$/);
  });

  it("is case-insensitive on the input address", () => {
    const lower = hashPayer("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");
    const upper = hashPayer("0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD");
    expect(lower).toBe(upper);
  });

  it("returns different digests for different addresses", () => {
    expect(hashPayer("0x1111111111111111111111111111111111111111")).not.toBe(
      hashPayer("0x2222222222222222222222222222222222222222"),
    );
  });
});

describe("newDistinctId", () => {
  it("produces an anon-prefixed id with hex suffix", () => {
    const id = newDistinctId();
    expect(id).toMatch(/^anon-[0-9a-f]{12}$/);
  });

  it("returns a fresh id each call", () => {
    expect(newDistinctId()).not.toBe(newDistinctId());
  });
});
