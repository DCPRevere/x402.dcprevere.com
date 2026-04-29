# figpay — plan

> **Status (post-implementation):** the product shipped, but as the
> `figlet` slug under the umbrella `x402.dcprevere.com` host rather than as
> a standalone `figpay.dcprevere.com` subdomain. Routes are now
> `/figlet/render`, `/figlet/fonts`, etc. (not `/figlet`, `/fonts`). The
> `figlet_rendered` PostHog event is emitted as `product_rendered`. Sections
> below describing per-product Dockerfiles / standalone deploy / single-route
> mounts are historical — see the umbrella [`README.md`](../README.md) and
> [`figpay/README.md`](./README.md) for the actual shape.

## Context

We want to demonstrate what the agentic economy looks like with a tiny, real
product: an HTTP API that renders text as ASCII art in a chosen figfont and
charges $0.10 per call. The novel part is *how* it's paid for — using
[x402](https://www.x402.org/), an open protocol where the server returns
`HTTP 402 Payment Required` with payment instructions, the client (typically
an AI agent) signs a USDC transfer, and the server verifies the payment via
a hosted *facilitator* before serving the response. No accounts, no API keys,
no per-customer onboarding — an agent with a funded wallet can transact.

Domain: `figpay.dcprevere.com` (already owned).

## What ships

1. A public Node/TypeScript Express API (the seller).
2. A buyer demo CLI that uses `@x402/fetch` to autonomously pay and print the
   result (the agent).
3. PostHog analytics on the seller side so we can see request → 402 → settled
   funnel and per-font popularity.
4. A README explaining the agentic-economy pitch and how to call the API
   (curl shows the 402, the demo CLI completes the loop).

## Key x402 facts that drive the design

- The seller only needs a **wallet address** — no private key on the server.
  Verification and settlement happen via a hosted *facilitator* HTTP service.
- For testnet (Base Sepolia), `https://x402.org/facilitator` is free and
  needs no signup. For mainnet, Coinbase's CDP facilitator at
  `https://api.cdp.coinbase.com/platform/v2/x402` is recommended (needs a CDP
  API key).
- Network is identified in CAIP-2: `eip155:84532` (Base Sepolia) /
  `eip155:8453` (Base mainnet). Asset is USDC. Price is a dollar string
  like `"$0.10"` — the leading `$` is required.
- Server middleware: `@x402/express` + `@x402/evm` + `@x402/core`.
  Buyers can't pay with plain `curl`; they need an x402-aware client
  (`@x402/fetch` wraps `fetch` with payment-signing logic).

We will ship on **Base Sepolia first**, with the network and facilitator URL
read from env vars, so flipping to mainnet is a config change and a wallet
swap with no code changes.

## Architecture

```
┌──────────────────────┐         402 + payment-required          ┌──────────────────────────┐
│ buyer demo CLI       │ ───────────────────────────────────►   │ figpay seller (Express)  │
│ @x402/fetch + wallet │                                         │ @x402/express middleware │
│                      │ ◄─────── retry w/ X-PAYMENT ────────►   │   ├─ /figlet (paid)      │
└──────────────────────┘                                         │   ├─ /fonts  (free)      │
                                                                 │   ├─ /healthz (free)     │
                                                                 │   └─ /     (free landing)│
                                                                 └──────────┬───────────────┘
                                                                            │ verify+settle
                                                                            ▼
                                                                 ┌──────────────────────────┐
                                                                 │ x402 facilitator (HTTPS) │
                                                                 │ x402.org or CDP          │
                                                                 └──────────────────────────┘
                                                                            │ on-chain settle
                                                                            ▼
                                                                 ┌──────────────────────────┐
                                                                 │ Base Sepolia / Base      │
                                                                 │ USDC → seller wallet     │
                                                                 └──────────────────────────┘
                                  │ events
                                  ▼
                      ┌──────────────────────────┐
                      │ PostHog (server-side)    │
                      └──────────────────────────┘
```

## API surface

| Route                          | Paid? | Returns                                                        |
| ------------------------------ | ----- | -------------------------------------------------------------- |
| `GET /`                        | Free  | `text/plain` landing page: pitch, how to call, demo command.   |
| `GET /healthz`                 | Free  | `{"ok":true}` for uptime checks.                               |
| `GET /fonts`                   | Free  | `application/json` array of figfont names. Free so agents can discover. |
| `GET /figlet?text=…&font=…&width=…` | **Paid $0.10** | `text/plain` ASCII rendering. `text` required. `font` defaults to `Standard`. `width` optional, capped at 200. |

Validation:
- `text` length capped (e.g. 256 chars) — keep cost predictable, prevent abuse.
- `font` must be in the bundled list from `figlet.fontsSync()`; reject otherwise with 400.
- `width` parsed as int, clamped to `[20, 200]`.

Errors are deliberately returned **before** the payment middleware decides to
charge — the middleware is mounted only on `/figlet`, and we put a small
pre-validator in front of it so a buyer never pays for a request that would
have 400'd. (Wiring detail: do validation in a custom middleware mounted on
`/figlet` *before* `paymentMiddleware`, returning 400 on bad input; valid
requests fall through to `paymentMiddleware` and then the handler.)

## Stack

- **Runtime**: Node 20, TypeScript, ESM.
- **HTTP**: `express@4`.
- **Figlet**: `figlet` (MIT, bundles many .flf fonts; `figlet.text(...)` async).
- **Payments**: `@x402/express`, `@x402/evm`, `@x402/core`.
- **Buyer**: `@x402/fetch` + `viem` (for the test wallet).
- **Analytics**: `posthog-node`.
- **Env**: `dotenv` for local; production reads from host env.
- **Lint/format**: `eslint` + `prettier` minimal config — don't over-tool.
- **Tests**: `vitest` for the validator and the (mocked) figlet rendering.
  Skip integration tests against the live facilitator in CI; document a manual
  smoke test with the buyer CLI.

## Repo layout

```
figpay/
├── PLAN.md                     # this file
├── README.md                   # pitch + quickstart + buyer demo instructions
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
├── Dockerfile
├── src/
│   ├── server.ts               # Express bootstrap, mounts middleware + routes
│   ├── config.ts               # env parsing (NETWORK, PAY_TO, FACILITATOR_URL, POSTHOG_KEY, PORT)
│   ├── payment.ts              # x402 middleware factory (one place to flip testnet/mainnet)
│   ├── routes/
│   │   ├── figlet.ts           # validator + handler (renders figlet)
│   │   ├── fonts.ts            # GET /fonts
│   │   ├── landing.ts          # GET / and /healthz
│   ├── analytics.ts            # PostHog wrapper (no-op if POSTHOG_KEY unset)
│   └── figlet-render.ts        # thin async wrapper over figlet.text
├── buyer/
│   ├── README.md               # how to fund a Sepolia wallet, run the demo
│   └── pay.ts                  # @x402/fetch + viem demo CLI
└── tests/
    ├── validator.test.ts
    └── render.test.ts
```

## Critical config (`.env.example`)

```
PORT=4021
NETWORK=eip155:84532                                  # Base Sepolia
FACILITATOR_URL=https://x402.org/facilitator          # free, no signup
PAY_TO=0x0000000000000000000000000000000000000000     # seller wallet
PRICE=$0.10
POSTHOG_KEY=                                          # optional
POSTHOG_HOST=https://eu.i.posthog.com                 # if EU project
```

For mainnet flip: change `NETWORK=eip155:8453`,
`FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402`, set
`CDP_API_KEY_ID` / `CDP_API_KEY_SECRET`, and use a real `PAY_TO` wallet.

## PostHog events (server-side, `posthog-node`)

All events tagged `service=figpay`, `network=$NETWORK`.

| Event                  | Properties                                                                 |
| ---------------------- | -------------------------------------------------------------------------- |
| `request_received`     | `route`, `font`, `text_length`, `has_payment_header` (bool)                |
| `payment_required_sent`| `route`, `price`                                                           |
| `payment_settled`      | `route`, `price`, `payer_hash` (sha256 of address, first 12 chars), `latency_ms` |
| `figlet_rendered`      | `font`, `text_length`, `output_lines`, `render_ms`                         |
| `validation_error`     | `route`, `reason`                                                          |
| `error`                | `route`, `message`, `stack_first_line`                                     |

Identify with `distinct_id = payer_hash` when present, else a per-request
UUID. This lets us see the funnel `request_received → payment_required_sent →
payment_settled → figlet_rendered` per agent in PostHog.

PostHog calls are fire-and-forget; on shutdown call `posthog.shutdown()` so
no events are dropped.

## Buyer demo (`buyer/pay.ts`)

What it does:

1. Reads `BUYER_PRIVATE_KEY` from env (a fresh Sepolia-only test wallet).
2. Builds a `viem` account, wraps `fetch` with `@x402/fetch`.
3. Calls `https://figpay.dcprevere.com/figlet?text=hello&font=Slant`.
4. Prints the ASCII output to stdout.

README explains:
- Generate a Sepolia private key (e.g. `cast wallet new` or a snippet).
- Fund it with Base Sepolia ETH (gas) from a public faucet.
- Fund it with test USDC from a Base Sepolia USDC faucet.
- Run `pnpm tsx buyer/pay.ts "your text here"`.

This is the moment that demonstrates the agentic economy: an autonomous
client transacting against a paid API with no human in the loop.

## Deployment

- **Hosting**: Railway. Reasons: one-click Node deploy, env vars, free TLS,
  custom domain support, generous free tier. (Alternatives if Railway
  becomes inconvenient: Fly.io, Render — same shape.)
- **Domain**: point `figpay.dcprevere.com` CNAME at the Railway service.
- **Container**: simple multi-stage `Dockerfile` (node:20-alpine builder →
  runner). Railway will build from Dockerfile if present.
- **Secrets**: `PAY_TO`, `POSTHOG_KEY` (and CDP keys for mainnet) set via the
  Railway dashboard, not committed.

## Implementation order

1. **Scaffold** — `package.json`, `tsconfig.json`, ESM Express hello-world,
   `.env.example`, `.gitignore`. Confirm `pnpm dev` runs. (~15 min)
2. **Free routes** — `/`, `/healthz`, `/fonts` returning real `figlet.fontsSync()`
   output. Smoke with curl. (~15 min)
3. **Paid /figlet route** — validator + render, *without* payment yet. Verify
   it returns the ASCII art. (~20 min)
4. **Wire x402 middleware** — `@x402/express` mounted on `/figlet` with Sepolia
   config. Verify `curl` returns 402 + JSON instructions; `curl --include`
   shows the `WWW-Authenticate`-style headers. (~30 min)
5. **PostHog** — `analytics.ts`, instrument the four events. Verify events
   land in PostHog dashboard. (~20 min)
6. **Buyer CLI** — `@x402/fetch` + `viem` script, fund a test wallet, complete
   one paid call end-to-end. (~45 min, most of it on faucet wrangling)
7. **Tests** — vitest for validator + render. (~20 min)
8. **Dockerfile + README** — write the pitch and the demo runbook. (~30 min)
9. **Deploy** — Railway, point DNS, smoke from public URL. (~30 min)
10. **Mainnet readiness note** — document the 3-line flip in README; do *not*
    flip without explicit decision (real money). (~5 min)

Total ballpark: a focused day.

## Out of scope (deliberately)

- Rate limiting beyond what x402 naturally provides (no payment, no service).
- Per-key auth, accounts, dashboards.
- Caching identical paid renders (would let an agent get the second copy
  free; arguably defeats the demo).
- A web paywall UI (`@x402/paywall`) — agents-first, not browser-first.
- Mainnet rollout (separate decision, after testnet is live).

## Verification

End-to-end check, in order:

1. **Local server up**: `pnpm dev` → `curl localhost:4021/healthz` → `{"ok":true}`.
2. **Free discovery**: `curl localhost:4021/fonts | jq 'length'` returns >0.
3. **Paywall fires**: `curl -i 'localhost:4021/figlet?text=hi'` returns
   `HTTP/1.1 402 Payment Required` with a JSON body listing the `accepts`
   array, the `payTo` address, the price `$0.10`, and the network
   `eip155:84532`.
4. **Validation before payment**: `curl -i 'localhost:4021/figlet?text=hi&font=NotAFont'`
   returns `400`, *not* `402`. (No charge for bad input.)
5. **Paid call succeeds**: `pnpm tsx buyer/pay.ts "hello"` prints ASCII art;
   on-chain explorer shows USDC transfer from buyer to `PAY_TO` on Base
   Sepolia.
6. **PostHog funnel**: PostHog dashboard shows
   `request_received → payment_required_sent → payment_settled → figlet_rendered`
   for the buyer demo run.
7. **Vitest**: `pnpm test` green.
8. **Production smoke**: same step 3 + step 5 against
   `https://figpay.dcprevere.com`.

## Open questions for follow-up (not blockers for v1)

- Do we want a public leaderboard of fonts requested? (PostHog already gives us this.)
- Mainnet pricing — keep at $0.10 or experiment? Need a real wallet first.
- Do we add `@x402/paywall` later for human/browser callers, or keep the
  agents-only purity?
