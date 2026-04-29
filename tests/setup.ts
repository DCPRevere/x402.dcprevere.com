// Vitest setup: provide the env vars `src/core/config.ts` validates at
// module load, and stub network calls to the x402 facilitator so the
// paywall test path is fully offline / deterministic.

process.env.NETWORK ??= "eip155:84532";
process.env.FACILITATOR_URL ??= "https://x402.org/facilitator";
process.env.PAY_TO ??= "0x00000000000000000000000000000000DeadBeef";
// Force analytics into no-op mode for tests; individual tests that exercise
// analytics use a spy on the `capture` export instead.
process.env.POSTHOG_KEY = "";

// `@x402/core`'s HTTPFacilitatorClient calls `${url}/supported` on first
// use to discover what schemes/networks the facilitator can verify. In
// tests we never reach the network, so intercept that one URL pattern and
// return a synthetic response that advertises the exact-EVM scheme on the
// configured network. All other fetches fall through to the real impl.
const FACILITATOR_SUPPORTED_RE = /\/supported(\?|$)/;
const realFetch = globalThis.fetch;

globalThis.fetch = async function stubbedFetch(input, init) {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as Request).url;

  if (FACILITATOR_SUPPORTED_RE.test(url)) {
    return new Response(
      JSON.stringify({
        kinds: [
          { x402Version: 2, scheme: "exact", network: process.env.NETWORK, extra: {} },
          { x402Version: 1, scheme: "exact", network: process.env.NETWORK, extra: {} },
        ],
        extensions: [],
        signers: {},
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }
  return realFetch(input as RequestInfo, init);
} as typeof fetch;
