import type { Request } from "express";
import { POISSON_KNUTH_MAX_LAMBDA, type DrawSpec } from "./draw.js";

const MAX_COUNT = 256;
const MAX_BYTES = 256;

export type ValidateDrawResult =
  | { ok: true; spec: DrawSpec; count: number }
  | { ok: false; status: number; error: string };

/**
 * Resolves a /random/draw query into a single DrawSpec. Exactly one of the
 * "shape" parameters (sides, range, bytes, uuid, choose, shuffle, dnd,
 * distribution) selects the operation; `count` controls multi-draws for the
 * shapes that support it.
 */
export function validateDrawInput(query: Request["query"]): ValidateDrawResult {
  const count = parseCount(query.count);
  if (count instanceof Error) return { ok: false, status: 400, error: count.message };

  // Pick the operation shape. We fail if multiple are set, to keep the
  // input semantically clear.
  const shapes: string[] = [];
  if (query.sides !== undefined) shapes.push("sides");
  if (query.range !== undefined) shapes.push("range");
  if (query.bytes !== undefined) shapes.push("bytes");
  if (query.uuid !== undefined) shapes.push("uuid");
  if (query.choose !== undefined) shapes.push("choose");
  if (query.shuffle !== undefined) shapes.push("shuffle");
  if (query.dnd !== undefined) shapes.push("dnd");
  if (query.distribution !== undefined) shapes.push("distribution");

  if (shapes.length > 1) {
    return {
      ok: false,
      status: 400,
      error: `pick exactly one of: sides, range, bytes, uuid, choose, shuffle, dnd, distribution (got: ${shapes.join(", ")})`,
    };
  }
  // Default shape when nothing is specified: a coin flip (sides=2).
  const shape = shapes[0] ?? "sides";

  switch (shape) {
    case "sides": {
      const sides = parsePositiveInt(query.sides ?? "2", "sides");
      if (sides instanceof Error) return { ok: false, status: 400, error: sides.message };
      if (sides < 2) return { ok: false, status: 400, error: "sides must be >= 2" };
      return { ok: true, count, spec: { sides } };
    }
    case "range": {
      const r = parseRange(query.range);
      if (r instanceof Error) return { ok: false, status: 400, error: r.message };
      return { ok: true, count, spec: { range: r } };
    }
    case "bytes": {
      const n = parsePositiveInt(query.bytes, "bytes");
      if (n instanceof Error) return { ok: false, status: 400, error: n.message };
      if (n > MAX_BYTES)
        return { ok: false, status: 400, error: `bytes must be <= ${MAX_BYTES}` };
      return { ok: true, count: 1, spec: { bytes: n } };
    }
    case "uuid": {
      if (query.uuid !== "v4")
        return { ok: false, status: 400, error: "uuid must be 'v4'" };
      return { ok: true, count: 1, spec: { uuid: "v4" } };
    }
    case "choose": {
      const labels = parseCsv(query.choose);
      if (labels.length === 0) return { ok: false, status: 400, error: "choose: at least one label required" };
      let weights: number[] | undefined;
      if (query.weights !== undefined) {
        const ws = parseCsvFloat(query.weights);
        if (ws instanceof Error) return { ok: false, status: 400, error: ws.message };
        if (ws.length !== labels.length)
          return {
            ok: false,
            status: 400,
            error: `weights length (${ws.length}) must match labels length (${labels.length})`,
          };
        weights = ws;
      }
      return { ok: true, count, spec: { choose: labels, weights } };
    }
    case "shuffle": {
      const items = parseCsv(query.shuffle);
      if (items.length === 0)
        return { ok: false, status: 400, error: "shuffle: at least one item required" };
      return { ok: true, count: 1, spec: { shuffle: items } };
    }
    case "dnd": {
      const parsed = parseDndNotation(query.dnd);
      if (parsed instanceof Error) return { ok: false, status: 400, error: parsed.message };
      return { ok: true, count: 1, spec: { dnd: parsed } };
    }
    case "distribution": {
      const d = parseDistribution(query);
      if (d instanceof Error) return { ok: false, status: 400, error: d.message };
      return { ok: true, count, spec: { distribution: d } };
    }
    default:
      return { ok: false, status: 400, error: `unknown shape: ${shape}` };
  }
}

function parseCount(q: unknown): number | Error {
  if (q === undefined) return 1;
  if (typeof q !== "string") return new Error("count must be a string integer");
  const n = Number(q);
  if (!Number.isInteger(n) || n < 1 || n > MAX_COUNT)
    return new Error(`count must be an integer in [1, ${MAX_COUNT}]`);
  return n;
}

function parsePositiveInt(q: unknown, name: string): number | Error {
  if (typeof q !== "string" || q === "") return new Error(`${name} is required`);
  const n = Number(q);
  if (!Number.isInteger(n) || n < 1) return new Error(`${name} must be a positive integer`);
  return n;
}

function parseRange(q: unknown): { lo: number; hi: number } | Error {
  if (typeof q !== "string") return new Error("range must be 'lo-hi'");
  const m = /^(-?\d+)-(-?\d+)$/.exec(q);
  if (!m) return new Error("range must be 'lo-hi', e.g. '1-100'");
  const lo = Number(m[1]);
  const hi = Number(m[2]);
  if (!Number.isInteger(lo) || !Number.isInteger(hi))
    return new Error("range bounds must be integers");
  if (hi < lo) return new Error("range hi must be >= lo");
  return { lo, hi };
}

function parseCsv(q: unknown): string[] {
  if (typeof q !== "string") return [];
  return q.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

function parseCsvFloat(q: unknown): number[] | Error {
  if (typeof q !== "string") return new Error("weights must be a comma-separated list");
  const parts = q.split(",").map((s) => s.trim());
  const out: number[] = [];
  for (const p of parts) {
    if (!p) return new Error("weights must not contain empty entries");
    const n = Number(p);
    if (!Number.isFinite(n) || n < 0) return new Error(`weights must be non-negative numbers (got '${p}')`);
    out.push(n);
  }
  return out;
}

function parseDndNotation(
  q: unknown,
): { dice: number; sides: number; modifier: "kh" | "kl" | null; keep: number | null } | Error {
  if (typeof q !== "string") return new Error("dnd must be like '4d6' or '4d6kh3'");
  const m = /^(\d+)d(\d+)(?:(kh|kl)(\d+))?$/.exec(q);
  if (!m) return new Error("dnd must match '<dice>d<sides>[kh|kl<keep>]'");
  const dice = Number(m[1]);
  const sides = Number(m[2]);
  const modifier = (m[3] as "kh" | "kl" | undefined) ?? null;
  const keep = m[4] !== undefined ? Number(m[4]) : null;
  if (dice < 1 || dice > 100) return new Error("dnd dice count must be in [1, 100]");
  if (sides < 2 || sides > 1000) return new Error("dnd sides must be in [2, 1000]");
  if (modifier && (keep === null || keep < 1 || keep > dice))
    return new Error("dnd keep must be in [1, dice]");
  return { dice, sides, modifier, keep };
}

function parseDistribution(
  q: Request["query"],
): DrawSpec["distribution"] | Error {
  const kind = q.distribution;
  if (kind === "uniform") return { kind: "uniform" };
  if (kind === "normal") {
    const mu = Number(q.mu ?? "0");
    const sigma = Number(q.sigma ?? "1");
    if (!Number.isFinite(mu)) return new Error("mu must be a finite number");
    if (!Number.isFinite(sigma) || sigma <= 0) return new Error("sigma must be > 0");
    return { kind: "normal", mu, sigma };
  }
  if (kind === "exponential" || kind === "poisson") {
    const lambda = Number(q.lambda ?? "1");
    if (!Number.isFinite(lambda) || lambda <= 0) return new Error("lambda must be > 0");
    if (kind === "poisson" && lambda > POISSON_KNUTH_MAX_LAMBDA) {
      return new Error(`poisson lambda must be <= ${POISSON_KNUTH_MAX_LAMBDA}`);
    }
    return { kind: kind as "exponential" | "poisson", lambda };
  }
  return new Error(`unknown distribution: ${kind}`);
}
