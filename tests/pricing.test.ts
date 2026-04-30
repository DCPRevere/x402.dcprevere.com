import { describe, it, expect } from "vitest";
import { usdcBaseUnits, usdcPricing } from "../src/core/pricing.js";

describe("usdcBaseUnits", () => {
  it("converts whole-dollar amounts", () => {
    expect(usdcBaseUnits("1")).toBe("1000000");
    expect(usdcBaseUnits("10")).toBe("10000000");
  });

  it("converts cent amounts", () => {
    expect(usdcBaseUnits("0.10")).toBe("100000");
    expect(usdcBaseUnits("0.05")).toBe("50000");
    expect(usdcBaseUnits("0.01")).toBe("10000");
  });

  it("converts sub-cent amounts to the precision USDC supports", () => {
    expect(usdcBaseUnits("0.005")).toBe("5000");
    expect(usdcBaseUnits("0.001")).toBe("1000");
    expect(usdcBaseUnits("0.000001")).toBe("1");
  });

  it("rejects more than 6 decimal places", () => {
    expect(() => usdcBaseUnits("0.0000001")).toThrow();
  });

  it("rejects malformed inputs", () => {
    expect(() => usdcBaseUnits("$0.10")).toThrow();
    expect(() => usdcBaseUnits("0.1.2")).toThrow();
    expect(() => usdcBaseUnits("not a number")).toThrow();
  });

  it("usdcPricing returns both forms", () => {
    expect(usdcPricing("0.10")).toEqual({ amount: "100000", amount_usdc: "0.10" });
  });
});
