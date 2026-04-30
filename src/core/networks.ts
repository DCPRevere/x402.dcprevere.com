/**
 * Single source of truth for the networks the umbrella supports.
 *
 * The paywall uses `config.network` (one value); /help advertises
 * SUPPORTED_NETWORKS to clients. Adding a new chain (e.g. Solana) means
 * editing this file plus the paywall scheme registration in core/payment.ts.
 *
 * Fixes review item #20.
 */

export const SUPPORTED_NETWORKS: readonly string[] = [
  "eip155:84532", // Base Sepolia
  "eip155:8453", // Base mainnet
] as const;
