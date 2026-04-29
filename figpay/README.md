# figpay

A pay-per-call ASCII-art API. Send some text, get it back rendered in a
figfont. Each call costs $0.10 in USDC, paid via the [x402][x402] protocol —
no accounts, no API keys, no human in the loop.

This is a deliberately small product designed to demonstrate what the
"agentic economy" might look like: an autonomous client (an AI agent) finds
an API, gets a `402 Payment Required` with machine-readable payment terms,
signs a USDC transfer from its wallet, retries, and gets the result.

```
    ____            _____           __
   / __/_  ______ _/ ___/____ _____/ /
  / /_/ / / / __ `/\__ \/ __ `/ __  /
 / __/ /_/ / /_/ /___/ / /_/ / /_/ /
/_/  \__, /\__, //____/\__,_/\__,_/
    /____//____/
```

## Try the paywall (no payment, just see the 402)

```bash
curl -i 'https://x402.dcprevere.com/figlet/render?text=hello'
```

You'll get back `HTTP 402 Payment Required` with a `PAYMENT-REQUIRED` header
containing base64-encoded payment instructions: scheme, network, USDC
amount, recipient address, expiry. Decode it:

```bash
curl -s -i 'https://x402.dcprevere.com/figlet/render?text=hi' \
  | awk -F': ' '/^PAYMENT-REQUIRED/{print $2}' \
  | base64 -d \
  | jq
```

## Pay autonomously (the buyer demo)

The repo includes a small Node script using [`@x402/fetch`][fetch] that
behaves like an agent: it pays and prints the rendered output. See
[`buyer/README.md`](../buyer/README.md) for the full runbook (test wallet,
faucets).

```bash
export BUYER_PRIVATE_KEY=0x...
export X402_URL=https://x402.dcprevere.com
npm run buyer -- "hello agent economy"
```

## Routes

| Route                                              | Paid?     | Returns                              |
| -------------------------------------------------- | --------- | ------------------------------------ |
| `GET /`                                            | free      | umbrella landing page (text/plain)   |
| `GET /healthz`                                     | free      | `{"ok":true}`                        |
| `GET /figlet`                                      | free      | figlet product info page             |
| `GET /figlet/fonts`                                | free      | JSON list of figfont names           |
| `GET /figlet/render?text=…&font=…&width=…`         | **$0.10** | `text/plain` ASCII rendering         |

Validation runs *before* the paywall, so an invalid request returns `400`,
never `402` — buyers don't pay for bad input.

## Running locally

```bash
cp .env.example .env
# edit .env: set PAY_TO to your Sepolia wallet address (the server refuses
# to start on the zero address)
npm install
npm run dev
```

Then:

```bash
curl localhost:4021/healthz
curl 'localhost:4021/figlet/render?text=hi'   # → 402, with payment instructions
```

## Configuration

| Env var           | Default                              | Notes                                 |
| ----------------- | ------------------------------------ | ------------------------------------- |
| `PORT`            | `4021`                               |                                       |
| `NETWORK`         | `eip155:84532` (Base Sepolia)        | CAIP-2; mainnet is `eip155:8453`      |
| `FACILITATOR_URL` | `https://x402.org/facilitator`       | Free for testnet; CDP for mainnet     |
| `PAY_TO`          | **required, no default**             | Seller wallet address; zero address is rejected |
| `POSTHOG_KEY`     | (unset)                              | Analytics is a no-op when unset       |
| `POSTHOG_HOST`    | `https://eu.i.posthog.com`           |                                       |

Per-route prices are declared in code (see `src/products/figlet/router.ts`),
not env, so the umbrella server can host products at different price points.

## Mainnet flip (real money)

When you're ready to charge real USDC:

1. Set `NETWORK=eip155:8453`.
2. Set `FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402` and
   the `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` env vars (sign up at
   [Coinbase Developer Platform][cdp]).
3. Set `PAY_TO` to a real wallet you control on Base mainnet.
4. Redeploy.

No code changes.

## Stack

- Node 20 + TypeScript + Express
- [`figlet`][figlet] (MIT) for the ASCII rendering
- [`@x402/express`][x402-express] for the paywall, [`@x402/fetch`][fetch]
  for the buyer
- `posthog-node` for the funnel: `request_received → payment_required_sent
  → payment_settled → product_rendered` (joined on the hashed payer address)

## Tests

```bash
npm test               # vitest run — full suite
npm run test:watch     # vitest in watch mode
npm run test:coverage  # v8 coverage with an 80% threshold (lines/branches/funcs)
npm run typecheck      # tsc --noEmit on the whole project
```

The suite covers:
- `validate.ts` — pure validator (text/font/width branches).
- `render.ts` — figlet wrapper renders & lists fonts.
- `config.ts` — env validation rejects unset, malformed, and zero `PAY_TO`; CAIP-2 enforcement.
- `analytics.ts` — `hashPayer` stable + case-insensitive; no-op when `POSTHOG_KEY` is unset.
- `analytics-middleware.ts` — payer address extraction from `X-PAYMENT`, stable `distinct_id` across paid retries, status-code → event mapping (402 / 400 / 5xx / 2xx-with-payment).
- `server.ts` (HTTP via supertest) — free routes, validation-before-paywall, paywall fires.
- `router.ts` — `renderHandler` emits `product_rendered` analytics with the right shape.

Manual end-to-end (requires a funded Sepolia wallet):

```bash
npm run dev
# in another shell
BUYER_PRIVATE_KEY=0x... npm run buyer -- "hello"
```

## Why this exists

The interesting thing about x402 isn't the figlet — it's that the figlet is
incidental. Any HTTP API can be paid for the same way, in the same number
of lines, and any client with a wallet can pay it. That's the agentic
economy: machine-to-machine commerce with no platform mediation, no
accounts, no rate limit deals — just `402 Payment Required` and a settled
transfer.

[x402]: https://www.x402.org/
[x402-express]: https://www.npmjs.com/package/@x402/express
[fetch]: https://www.npmjs.com/package/@x402/fetch
[figlet]: https://www.npmjs.com/package/figlet
[cdp]: https://docs.cdp.coinbase.com/x402/welcome
