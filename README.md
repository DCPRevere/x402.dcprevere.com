# x402.dcprevere.com

A small umbrella of pay-per-call APIs that demonstrate what the agentic
economy might look like. Every endpoint speaks [x402][x402] over USDC on
Base — no accounts, no API keys, no human in the loop. A buyer with a
wallet can transact.

## Shape

The umbrella mounts one free discovery slot and a growing set of paid
product slots. New ideas land as sub-endpoints under an existing slot
or motivate a new top-level slot only when none of the others fit.

```
x402.dcprevere.com/
├── /help          discovery — fractal catalog of everything (free)
├── /graphics      generative output (figlet lives here)
├── /random        verifiable entropy & sealing primitives
├── /passport      identity attestations
├── /escrow        conditional value (planned)
├── /wire          paid comms channels (planned)
└── /agora         the public square — board, auction, bar, ... (planned)
```

## Live products

| Slug                            | What it does                                                    | Price          |
| ------------------------------- | --------------------------------------------------------------- | -------------- |
| `/help`                         | machine-readable catalog of every product on this umbrella      | free           |
| `/graphics/figlet/render`       | render text in a figfont (ASCII-art banner)                     | $0.10          |
| `/graphics/figlet/fonts`        | list available figfonts                                         | free           |
| `/random/draw`                  | coin/dice/dnd/range/bytes/uuid/choose/weights/shuffle/distrib   | parametric     |
| `/random/commit`                | open a commit-reveal binding                                    | $0.05          |
| `/random/seal`                  | submit a time- or condition-sealed ciphertext                   | $0.05          |
| `/random/sortition`             | verifiable random selection over a registered pool              | parametric     |
| `/passport/bind`                | bind wallet → ENS / domain / GitHub gist (90-day attestation)   | $0.10          |
| `/passport/anti-captcha`        | hashcash PoW; issue a 24h pass that proves "definitely a bot"   | $0.001         |

The live catalog (with full parameter tables, pricing rules, and
examples) is at `/help`:

```bash
curl -s https://x402.dcprevere.com/help | jq
```

## /help — fractal discovery

Every level of the hierarchy returns the same self-describing envelope
with the entire subtree below it inlined. Three access forms, all
returning identical JSON:

| Form | Example |
| --- | --- |
| Path suffix (canonical) | `GET /random/draw/help` |
| Query flag | `GET /random/draw?help` |
| HTTP verb | `OPTIONS /random/draw` |

Etagged at every level (`If-None-Match` → 304). Filters: `?depth=N`
truncates descent; `?since=<iso8601>` drops untouched subtrees.

Every 402 response also carries `Link` headers pointing at both the
local self-help and the umbrella catalog, so an agent that hits any
paywall can discover everything the operator sells in one round-trip.

## Why x402

[x402][x402] reuses the long-reserved `HTTP 402 Payment Required`
status code: a server returns 402 with machine-readable payment
instructions, the client signs a USDC transfer from its wallet, retries
with the payment header, and gets the resource. The seller only needs
a wallet address — no custody, no PCI, no Stripe account, no buyer-side
API keys. (Mainnet sellers do need a [CDP][cdp] facilitator key;
testnet runs against the free public facilitator with no signup.)

Every product follows the same shape, so callers (humans or agents)
can switch between them without re-onboarding.

## Try the paywall (no payment, just see the 402)

```bash
curl -i 'https://x402.dcprevere.com/graphics/figlet/render?text=hello'
```

You'll get back `HTTP 402 Payment Required` with a `PAYMENT-REQUIRED`
header containing base64-encoded payment instructions, plus `Link`
headers pointing at `/graphics/figlet/render/help` and `/help`.

## Pay autonomously (the buyer demo)

The repo includes a small Node script using [`@x402/fetch`][fetch] that
behaves like an agent: it pays and prints the rendered output. See
[`buyer/README.md`](./buyer/README.md) for the full runbook (test
wallet, faucets).

```bash
export BUYER_PRIVATE_KEY=0x...
export X402_URL=https://x402.dcprevere.com
npm run buyer -- "hello agent economy"
```

## Repo layout

```
x402.dcprevere.com/
├── README.md
├── package.json
├── src/
│   ├── server.ts                 # umbrella Express bootstrap
│   ├── core/
│   │   ├── product.ts            # Product + help abstractions
│   │   ├── help.ts               # fractal /help registry + middleware
│   │   ├── payment.ts            # x402 paywall + Link headers
│   │   ├── persist.ts            # shared sqlite handle
│   │   ├── chain.ts              # viem PublicClient wrapper
│   │   ├── analytics.ts          # PostHog event sink
│   │   ├── analytics-middleware.ts
│   │   ├── landing.ts
│   │   └── config.ts
│   └── products/
│       ├── graphics/
│       │   └── figlet/           # /graphics/figlet — live
│       ├── random/               # /random — live
│       └── passport/             # /passport — live
├── buyer/                        # autonomous-buyer demo CLI
└── tests/                        # vitest, 118+ tests
```

## Network

All products default to **Base Sepolia** (testnet, free, no signup) via
the open `https://x402.org/facilitator`. Mainnet is a config flip:

1. Set `NETWORK=eip155:8453`.
2. Set `FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402`
   and the `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` env vars (sign up at
   [Coinbase Developer Platform][cdp]).
3. Set `PAY_TO` to a real wallet you control on Base mainnet.
4. Redeploy.

No code changes.

## Configuration

| Env var               | Default                              | Notes                                        |
| --------------------- | ------------------------------------ | -------------------------------------------- |
| `PORT`                | `4021`                               |                                              |
| `NETWORK`             | `eip155:84532` (Base Sepolia)        | CAIP-2; mainnet is `eip155:8453`             |
| `FACILITATOR_URL`     | `https://x402.org/facilitator`       | Free for testnet; CDP for mainnet            |
| `PAY_TO`              | **required, no default**             | One shared receiver wallet for all products  |
| `DATABASE_PATH`       | `./data/x402.db`                     | sqlite file; `:memory:` is supported         |
| `RPC_URL`             | (viem default for the chain)         | Base RPC for blockhash-seeded randomness     |
| `PUBLIC_BASE_URL`     | (relative URLs in /help)             | When set, /help emits absolute URLs          |
| `POSTHOG_KEY`         | (unset)                              | Analytics is a no-op when unset              |
| `POSTHOG_HOST`        | `https://us.i.posthog.com`           |                                              |
| `PASSPORT_SECRET`     | (per-process random)                 | HMAC key for /passport attestations          |
| `OPERATOR_CONTACT`    | `ops@x402.dcprevere.com`             | Surfaced in /help                            |
| `STATUS_PAGE_URL`     | (empty)                              | Surfaced in /help                            |
| `TOS_URL`             | (empty)                              | Surfaced in /help                            |

Per-route prices are declared in code (each product's `help.ts`), not
env, so the umbrella can host products at different price points without
config drift between the catalog and the paywall.

## Running locally

```bash
cp .env.example .env
# edit .env: set PAY_TO to your Sepolia wallet address (the server
# refuses to start on the zero address)
npm install
npm run dev
```

Then:

```bash
curl localhost:4021/healthz
curl localhost:4021/help | jq                                # full catalog
curl 'localhost:4021/graphics/figlet/render?text=hi'         # → 402 + Link headers
curl 'localhost:4021/random/draw?dnd=4d6kh3'                 # → 402, then pay to roll
```

## Tests

```bash
npm test               # vitest run — full suite
npm run test:watch     # vitest in watch mode
npm run test:coverage  # v8 coverage with an 80% threshold
npm run typecheck      # tsc --noEmit on the whole project
```

Coverage spans:
- the help registry (suffix / ?help / OPTIONS / etag / depth / since /
  self-registration / 404 paths)
- `/random` derivations (coin, dice, dnd, range, bytes, uuid, choose,
  weights, shuffle, normal, exponential, poisson) and the sqlite-backed
  commit-reveal, seal, and sortition state
- `/passport` bindings (with a pluggable verifier under test) and the
  anti-captcha challenge / solve / pass flow
- `/graphics/figlet` validator + render-handler + analytics
- the umbrella server's HTTP surface, including 402 `Link` headers and
  the `/help` access matrix

## What's planned next

- **`/escrow`** — substrate for conditional value: `deal` (two-party
  escrow), `bond` (pay X now, get Y at block N+T), `vouch` (stake on
  another wallet's behaviour).
- **`/wire`** — paid comms channels: `whisper` (one-to-one encrypted
  drop-and-pickup), `broadcast` (one-to-many beacon), `heartbeat`
  (silence-triggered webhooks).
- **`/agora`** — the public square. Composes the four substrates above
  into `board` (classifieds), `match` (interest-pool discovery),
  `auction` (sealed-bid / English / Dutch), `duel` / `quorum` /
  `assembly` / `schelling`, and finally `bar` — a stateful agent
  social hub with a tab, jukebox, brawl, last-call, and a rolling
  presence index.

The dependency graph is `escrow + random + passport + wire → agora →
bar`. /escrow is next because everything downstream settles through it.

A separate project, **subs-x402**, will provide drop-in subscription
middleware for any x402 endpoint (1% rake on settlement). Held back to
its own repo because it's product-as-infrastructure and shouldn't be
mixed with the demo umbrella; this umbrella will be its first
dogfood customer.

[x402]: https://www.x402.org/
[fetch]: https://www.npmjs.com/package/@x402/fetch
[cdp]: https://docs.cdp.coinbase.com/x402/welcome
