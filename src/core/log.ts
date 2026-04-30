/**
 * Tiny structured logger. One JSON line per event, written to stdout —
 * Railway / Fly aggregates stdout into searchable logs and any log shipper
 * (Datadog, Logtail) parses it natively.
 *
 * Levels:
 *   trace — verbose request detail, off by default
 *   debug — handler-level state transitions
 *   info  — boot, shutdown, ops-relevant events
 *   warn  — recoverable anomalies (RPC retries, rate-limit hits)
 *   error — handler 5xx, chain RPC failures, facilitator errors
 *
 * Set `LOG_LEVEL=debug` (or trace/info/warn/error) to filter. Tests run with
 * `LOG_LEVEL=silent` from setup.ts so stdout stays clean.
 */

const LEVELS = ["trace", "debug", "info", "warn", "error", "silent"] as const;
export type LogLevel = (typeof LEVELS)[number];

function envLevel(): LogLevel {
  if (process.env.NODE_ENV === "test") return "silent";
  const env = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return (LEVELS as readonly string[]).includes(env) ? (env as LogLevel) : "info";
}

let currentLevel: LogLevel = envLevel();

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  if (currentLevel === "silent") return false;
  return LEVELS.indexOf(level) >= LEVELS.indexOf(currentLevel);
}

function emit(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  if (!shouldLog(level)) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  });
  // eslint-disable-next-line no-console
  if (level === "error") console.error(line);
  else console.log(line);
}

export const log = {
  trace: (event: string, fields?: Record<string, unknown>) => emit("trace", event, fields),
  debug: (event: string, fields?: Record<string, unknown>) => emit("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => emit("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit("error", event, fields),
};
