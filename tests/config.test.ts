import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// `src/core/config.ts` reads + validates env at module load, so each test
// must isolate the env it cares about and force a fresh import via
// `vi.resetModules()`.
const ORIGINAL_ENV = { ...process.env };

async function loadConfig(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return import("../src/core/config.js");
}

describe("config validation", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("loads with the standard test env", async () => {
    const { config } = await loadConfig({});
    expect(config.network).toBe("eip155:84532");
    expect(config.payTo.startsWith("0x")).toBe(true);
  });

  it("rejects an unset PAY_TO", async () => {
    await expect(loadConfig({ PAY_TO: undefined })).rejects.toThrow(/PAY_TO/);
  });

  it("rejects the zero address", async () => {
    await expect(
      loadConfig({ PAY_TO: "0x0000000000000000000000000000000000000000" }),
    ).rejects.toThrow(/zero address/);
  });

  it("rejects a malformed address", async () => {
    await expect(loadConfig({ PAY_TO: "not-an-address" })).rejects.toThrow(/PAY_TO/);
  });

  it("rejects a malformed NETWORK", async () => {
    await expect(loadConfig({ NETWORK: "no-colon" })).rejects.toThrow(/CAIP-2/);
  });
});
