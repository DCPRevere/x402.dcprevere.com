import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { log, setLogLevel } from "../src/core/log.js";

describe("structured logger", () => {
  let stdout: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    setLogLevel("silent");
    vi.restoreAllMocks();
  });

  it("silent level suppresses everything", () => {
    setLogLevel("silent");
    log.error("never_seen");
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it("info level emits info+warn+error but not debug/trace", () => {
    setLogLevel("info");
    log.trace("not_seen");
    log.debug("not_seen");
    log.info("seen");
    log.warn("seen");
    log.error("seen");
    expect(stdout).toHaveBeenCalledTimes(2); // info + warn
    expect(stderr).toHaveBeenCalledTimes(1); // error
  });

  it("emits parseable JSON with ts/level/event", () => {
    setLogLevel("info");
    log.info("hello", { foo: "bar" });
    const line = (stdout.mock.calls[0]?.[0] as string) ?? "";
    const parsed = JSON.parse(line);
    expect(parsed.event).toBe("hello");
    expect(parsed.level).toBe("info");
    expect(parsed.foo).toBe("bar");
    expect(typeof parsed.ts).toBe("string");
  });
});
