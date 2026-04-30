import { checkSolution } from "../../src/products/passport/captcha.js";

/**
 * Hashcash miner used only in tests and the buyer demo to produce a valid
 * captcha solution. Lives outside src/ so production builds don't ship it.
 */
export function mineSolution(nonce: string, difficulty: number, maxIters = 1_000_000): string {
  for (let i = 0; i < maxIters; i++) {
    const candidate = i.toString(16);
    if (checkSolution(nonce, candidate, difficulty)) return candidate;
  }
  throw new Error(`mineSolution: exhausted ${maxIters} attempts at difficulty ${difficulty}`);
}
