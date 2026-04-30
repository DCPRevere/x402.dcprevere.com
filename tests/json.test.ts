import { describe, it, expect } from "vitest";
import { canonicalJson, etagFor } from "../src/core/json.js";

describe("canonicalJson", () => {
  it("sorts top-level keys", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("sorts nested keys recursively", () => {
    expect(canonicalJson({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}');
  });

  it("handles arrays without sorting their elements", () => {
    expect(canonicalJson({ a: [3, 1, 2] })).toBe('{"a":[3,1,2]}');
  });

  it("preserves primitive values", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(42)).toBe("42");
    expect(canonicalJson("hi")).toBe('"hi"');
  });
});

describe("etagFor", () => {
  it("produces a quoted hex sha256", () => {
    expect(etagFor("hello")).toMatch(/^"[0-9a-f]{64}"$/);
  });

  it("two equal inputs hash equal", () => {
    expect(etagFor("x")).toBe(etagFor("x"));
  });

  it("different inputs hash differently", () => {
    expect(etagFor("x")).not.toBe(etagFor("y"));
  });
});
