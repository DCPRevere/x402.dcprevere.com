import { describe, it, expect } from "vitest";
import { SUPPORTED_NETWORKS } from "../src/core/networks.js";

describe("SUPPORTED_NETWORKS", () => {
  it("includes Base mainnet and Base Sepolia testnet", () => {
    expect(SUPPORTED_NETWORKS).toContain("eip155:8453");
    expect(SUPPORTED_NETWORKS).toContain("eip155:84532");
  });

  it("entries are CAIP-2 namespace:reference format", () => {
    for (const net of SUPPORTED_NETWORKS) {
      expect(net).toMatch(/^[a-z0-9-]+:[a-z0-9]+$/);
    }
  });
});
