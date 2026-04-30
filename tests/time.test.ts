import { describe, it, expect } from "vitest";
import { parseTimestamp, isPast, isFuture, isExpired } from "../src/core/time.js";

describe("time helpers", () => {
  it("parseTimestamp returns null for malformed input", () => {
    expect(parseTimestamp("not-a-date")).toBeNull();
    expect(parseTimestamp("")).toBeNull();
  });

  it("parseTimestamp returns ms for valid ISO 8601", () => {
    const t = parseTimestamp("2030-01-01T00:00:00Z");
    expect(t).not.toBeNull();
    expect(t!.ms).toBe(Date.parse("2030-01-01T00:00:00Z"));
  });

  it("isPast returns false for malformed input (closes review #1 NaN bug)", () => {
    expect(isPast("not-a-date", Date.now())).toBe(false);
  });

  it("isPast respects clock", () => {
    const now = Date.parse("2025-06-01T00:00:00Z");
    expect(isPast("2025-01-01T00:00:00Z", now)).toBe(true);
    expect(isPast("2030-01-01T00:00:00Z", now)).toBe(false);
  });

  it("isFuture returns false for malformed input", () => {
    expect(isFuture("not-a-date", Date.now())).toBe(false);
  });

  it("isExpired and isPast agree on the boundary case", () => {
    const ts = "2025-06-01T00:00:00Z";
    const now = Date.parse(ts);
    // <= boundary: expired/past
    expect(isExpired(ts, now)).toBe(true);
    expect(isPast(ts, now)).toBe(true);
  });
});
