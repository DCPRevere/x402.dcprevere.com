import crypto from "node:crypto";

/**
 * Pure deterministic randomness derived from a 32-byte seed.
 *
 * All derivations are sha256-based stream functions: given the seed and the
 * call's parameters, the output is reproducible. Callers receive (seed,
 * params, output) so they can verify the result themselves — the seed is the
 * only non-derivable input.
 *
 * For ungrindable randomness, /random/commit (commit-reveal) is the right
 * surface. /random/draw is "trust the server's seed, but here it is so you
 * can audit."
 */

export type Seed = Buffer;

export function freshSeed(): Seed {
  return crypto.randomBytes(32);
}

/** Deterministic uint64 stream from `seed || counter || label`. */
function streamUint64(seed: Seed, counter: number, label: string): bigint {
  const counterBuf = Buffer.alloc(4);
  counterBuf.writeUInt32BE(counter >>> 0, 0);
  const h = crypto
    .createHash("sha256")
    .update(seed)
    .update(counterBuf)
    .update(Buffer.from(label, "utf8"))
    .digest();
  // First 8 bytes as big-endian uint64.
  return h.readBigUInt64BE(0);
}

/** Uniform integer in [0, max) using rejection sampling on uint64. */
function uniformInt(seed: Seed, counter: number, label: string, max: bigint): bigint {
  if (max <= 0n) throw new Error("uniformInt: max must be positive");
  // Range [0, max). Reject samples in the truncated tail to keep uniform.
  const ULL_MAX = 1n << 64n;
  const limit = ULL_MAX - (ULL_MAX % max);
  let n = 0;
  while (true) {
    const v = streamUint64(seed, counter + n, label);
    if (v < limit) return v % max;
    n += 1;
    if (n > 256) {
      // Astronomically unlikely; bail rather than loop forever.
      return v % max;
    }
  }
}

/** Uniform float in [0, 1) from a single uint64 draw. */
function uniformFloat(seed: Seed, counter: number, label: string): number {
  const v = streamUint64(seed, counter, label);
  // 53 bits of precision — drop the bottom 11.
  const top53 = v >> 11n;
  return Number(top53) / 2 ** 53;
}

// ----- Operations ------------------------------------------------------

export interface DrawSpec {
  // Exactly one of these "shapes" should be set; the validator picks one.
  sides?: number;
  count?: number;
  range?: { lo: number; hi: number };
  bytes?: number;
  uuid?: "v4";
  choose?: string[];
  weights?: number[];
  shuffle?: string[];
  dnd?: { dice: number; sides: number; modifier: "kh" | "kl" | null; keep: number | null };
  distribution?:
    | { kind: "uniform" }
    | { kind: "normal"; mu: number; sigma: number }
    | { kind: "exponential"; lambda: number }
    | { kind: "poisson"; lambda: number };
}

export interface DrawResult {
  seed: string; // hex
  derivation: string; // human-readable, machine-parseable description
  output: unknown;
}

export function drawCoinOrDie(seed: Seed, sides: number, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const v = uniformInt(seed, i, `die:${sides}`, BigInt(sides));
    out.push(Number(v) + 1);
  }
  return out;
}

export function drawRange(seed: Seed, lo: number, hi: number, count: number): number[] {
  if (hi < lo) throw new Error("drawRange: hi < lo");
  const span = BigInt(hi - lo + 1);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const v = uniformInt(seed, i, `range:${lo}-${hi}`, span);
    out.push(lo + Number(v));
  }
  return out;
}

export function drawBytes(seed: Seed, n: number): string {
  if (n < 1 || n > 256) throw new Error("drawBytes: n out of range");
  const chunks: Buffer[] = [];
  let needed = n;
  let counter = 0;
  while (needed > 0) {
    const counterBuf = Buffer.alloc(4);
    counterBuf.writeUInt32BE(counter >>> 0, 0);
    const block = crypto
      .createHash("sha256")
      .update(seed)
      .update(counterBuf)
      .update(Buffer.from("bytes", "utf8"))
      .digest();
    const take = Math.min(needed, block.length);
    chunks.push(block.subarray(0, take));
    needed -= take;
    counter += 1;
  }
  return Buffer.concat(chunks).toString("hex");
}

/** RFC 4122 v4 UUID derived deterministically from the seed. */
export function drawUuidV4(seed: Seed): string {
  const bytes = Buffer.from(drawBytes(seed, 16), "hex");
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function drawChoose(seed: Seed, labels: string[], weights?: number[]): string {
  if (labels.length === 0) throw new Error("drawChoose: empty label set");
  if (!weights) {
    const idx = uniformInt(seed, 0, "choose", BigInt(labels.length));
    return labels[Number(idx)]!;
  }
  if (weights.length !== labels.length) {
    throw new Error("drawChoose: weights length must match labels length");
  }
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) throw new Error("drawChoose: weights must sum to a positive value");
  const r = uniformFloat(seed, 0, "choose-weighted") * total;
  let acc = 0;
  for (let i = 0; i < labels.length; i++) {
    acc += weights[i]!;
    if (r < acc) return labels[i]!;
  }
  return labels[labels.length - 1]!;
}

export function drawShuffle<T>(seed: Seed, items: T[]): T[] {
  // Fisher–Yates with deterministic uniform draws.
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Number(uniformInt(seed, i, "shuffle", BigInt(i + 1)));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Box–Muller transform → standard normal sample, then rescaled. */
export function drawNormal(seed: Seed, mu: number, sigma: number, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const u1 = Math.max(uniformFloat(seed, i * 2, "normal-u1"), 1e-12);
    const u2 = uniformFloat(seed, i * 2 + 1, "normal-u2");
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    out.push(mu + sigma * z);
  }
  return out;
}

export function drawExponential(seed: Seed, lambda: number, count: number): number[] {
  if (lambda <= 0) throw new Error("drawExponential: lambda must be positive");
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const u = Math.max(uniformFloat(seed, i, "exp"), 1e-12);
    out.push(-Math.log(u) / lambda);
  }
  return out;
}

/**
 * Poisson sampler. Uses Knuth's method for small lambda, which works well
 * up to ~lambda=30 in double precision. Above that, e^-lambda underflows
 * and the method silently returns garbage, so we cap upstream in the
 * validator (review item #4).
 */
const POISSON_KNUTH_MAX_LAMBDA = 30;

export function drawPoisson(seed: Seed, lambda: number, count: number): number[] {
  if (lambda <= 0) throw new Error("drawPoisson: lambda must be positive");
  if (lambda > POISSON_KNUTH_MAX_LAMBDA) {
    throw new Error(
      `drawPoisson: lambda must be <= ${POISSON_KNUTH_MAX_LAMBDA} (Knuth method underflow above)`,
    );
  }
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    let counter = 0;
    // Iteration cap is loose insurance against L=0 weirdness; with the
    // lambda cap above this should never fire.
    while (p > L) {
      const u = Math.max(uniformFloat(seed, i * 1000 + counter, "poisson"), 1e-12);
      p *= u;
      k += 1;
      counter += 1;
      if (counter > 10_000) break;
    }
    out.push(k - 1);
  }
  return out;
}

export { POISSON_KNUTH_MAX_LAMBDA };

/** dnd "4d6kh3" — roll N dice of S sides, optionally keep highest/lowest K. */
export function drawDnd(
  seed: Seed,
  spec: { dice: number; sides: number; modifier: "kh" | "kl" | null; keep: number | null },
): { rolls: number[]; kept: number[]; total: number } {
  const rolls: number[] = [];
  for (let i = 0; i < spec.dice; i++) {
    const v = uniformInt(seed, i, `dnd:${spec.dice}d${spec.sides}`, BigInt(spec.sides));
    rolls.push(Number(v) + 1);
  }
  let kept = rolls.slice();
  if (spec.modifier && spec.keep !== null) {
    const sorted = rolls.slice().sort((a, b) => a - b);
    kept = spec.modifier === "kh"
      ? sorted.slice(sorted.length - spec.keep)
      : sorted.slice(0, spec.keep);
  }
  const total = kept.reduce((a, b) => a + b, 0);
  return { rolls, kept, total };
}
