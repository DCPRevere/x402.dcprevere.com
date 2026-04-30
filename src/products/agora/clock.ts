/**
 * Per-product test seam for the wall clock. Shared across agora's three
 * sub-products (board, auction, bar) so a single setClockForTesting call
 * affects all of them.
 */
let clock: () => Date = () => new Date();

export function now(): Date {
  return clock();
}

export function setClockForTesting(fn: () => Date): void {
  clock = fn;
}

export function resetClockForTesting(): void {
  clock = () => new Date();
}
