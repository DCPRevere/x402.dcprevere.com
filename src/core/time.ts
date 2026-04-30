/**
 * Defensive time parsing.
 *
 * `Date.parse` returns NaN for malformed input. NaN compared against any
 * number is `false`, so naive `Date.parse(x) < Date.now()` returns `false`
 * for garbage and lets stale data slip through validity checks. These
 * helpers convert NaN into an explicit failure mode the caller can branch on.
 *
 * Fixes review item #1.
 */

export interface ParsedTimestamp {
  ms: number;
}

export function parseTimestamp(input: string): ParsedTimestamp | null {
  const ms = Date.parse(input);
  return Number.isFinite(ms) ? { ms } : null;
}

/** True iff `at` is a valid timestamp strictly in the past relative to `now`. */
export function isPast(at: string, now: number = Date.now()): boolean {
  const t = parseTimestamp(at);
  return t !== null && t.ms <= now;
}

/** True iff `at` is a valid timestamp at-or-before `now`. Use for deadlines. */
export function isExpired(at: string, now: number = Date.now()): boolean {
  return isPast(at, now);
}

/** True iff `at` is a valid timestamp in the future relative to `now`. */
export function isFuture(at: string, now: number = Date.now()): boolean {
  const t = parseTimestamp(at);
  return t !== null && t.ms > now;
}
