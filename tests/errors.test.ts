import { describe, it, expect } from "vitest";
import { errBody, codes } from "../src/core/errors.js";

describe("errBody envelope", () => {
  it("wraps a code+message into the canonical shape", () => {
    expect(errBody({ code: "not_found", message: "no such thing" })).toEqual({
      error: { code: "not_found", message: "no such thing" },
    });
  });

  it("preserves optional detail and retry_after", () => {
    expect(
      errBody({ code: "rate_limited", message: "slow down", retry_after: 30 }),
    ).toEqual({ error: { code: "rate_limited", message: "slow down", retry_after: 30 } });
  });

  it("exports a stable code vocabulary", () => {
    expect(codes.invalid_input).toBe("invalid_input");
    expect(codes.not_found).toBe("not_found");
    expect(codes.internal).toBe("internal");
  });
});
