import crypto from "node:crypto";

/**
 * Hashcash-style proof-of-work: the prover finds a `solution` such that
 * sha256(challenge_nonce || solution) has at least `difficulty` leading
 * zero bits. Easy for a programmable client; impossible for a human.
 *
 * Difficulty 18 ≈ 2^18 ≈ 262144 hashes (~50ms on modern hardware), which
 * is the right order of magnitude for "definitely a bot" without being
 * abusive.
 */

export function freshNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function checkSolution(nonce: string, solution: string, difficulty: number): boolean {
  if (difficulty < 1 || difficulty > 64) return false;
  const h = crypto
    .createHash("sha256")
    .update(Buffer.from(nonce, "hex"))
    .update(Buffer.from(solution, "utf8"))
    .digest();
  return countLeadingZeroBits(h) >= difficulty;
}

export function countLeadingZeroBits(buf: Buffer): number {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    // Find the position of the highest set bit in `byte` (a value 1..255).
    for (let mask = 0x80, b = 0; mask !== 0; mask >>= 1, b++) {
      if ((byte & mask) === 0) {
        bits += 1;
      } else {
        return bits;
      }
    }
  }
  return bits;
}

// `mineSolution` moved to tests/helpers/mine.ts (review item #14): the
// production server has no business shipping a "free wallet pass farmer"
// utility. The `freshNonce`/`checkSolution` pair is sufficient at runtime.
