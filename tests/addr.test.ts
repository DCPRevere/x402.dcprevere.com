import { describe, it, expect } from "vitest";
import { isAddress, parseHex32, isUuidV4, ADDRESS_RE, HEX32_NO_PREFIX_RE } from "../src/core/addr.js";

describe("addr helpers", () => {
  it("isAddress accepts a 0x-prefixed 20-byte hex string", () => {
    expect(isAddress("0x" + "ab".repeat(20))).toBe(true);
  });

  it("isAddress rejects without 0x", () => {
    expect(isAddress("ab".repeat(20))).toBe(false);
  });

  it("isAddress rejects wrong length", () => {
    expect(isAddress("0x" + "ab".repeat(19))).toBe(false);
    expect(isAddress("0x" + "ab".repeat(21))).toBe(false);
  });

  it("isAddress rejects non-string", () => {
    expect(isAddress(undefined)).toBe(false);
    expect(isAddress(123)).toBe(false);
    expect(isAddress(null)).toBe(false);
  });

  it("parseHex32 accepts 64 hex chars with or without 0x", () => {
    expect(parseHex32("ab".repeat(32))).toBe("ab".repeat(32));
    expect(parseHex32("0x" + "AB".repeat(32))).toBe("ab".repeat(32));
  });

  it("parseHex32 rejects wrong length / non-hex", () => {
    expect(parseHex32("ab")).toBeNull();
    expect(parseHex32("0x" + "ab".repeat(31))).toBeNull();
    expect(parseHex32("0x" + "ZZ".repeat(32))).toBeNull();
  });

  it("isUuidV4 only matches the canonical UUID format", () => {
    expect(isUuidV4("11111111-2222-3333-4444-555555555555")).toBe(true);
    expect(isUuidV4("not-a-uuid")).toBe(false);
    expect(isUuidV4("")).toBe(false);
    expect(isUuidV4(undefined)).toBe(false);
  });

  it("exported regex constants are sane", () => {
    expect(ADDRESS_RE.source).toContain("0x");
    expect(HEX32_NO_PREFIX_RE.source).toContain("64");
  });
});
