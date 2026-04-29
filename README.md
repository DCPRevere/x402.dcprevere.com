# x402.dcprevere.com

A small collection of pay-per-call APIs that demonstrate what the agentic
economy might look like. Each product is a real HTTP API that charges in
USDC on Base via the [x402][x402] protocol — no accounts, no API keys, no
human in the loop. A buyer with a wallet can transact.

## Products

| Product                                  | What it does                                  | Price | Status |
| ---------------------------------------- | --------------------------------------------- | ----- | ------ |
| [`figlet`](./src/products/figlet)        | Renders text in a figfont (ASCII-art banners) | $0.10 | live   |

More to come.

## Why x402

[x402][x402] reuses the long-reserved `HTTP 402 Payment Required` status
code: a server returns 402 with machine-readable payment instructions, the
client signs a USDC transfer from its wallet, retries with the payment
header, and gets the resource. The seller only needs a wallet address — no
custody, no PCI, no Stripe account, no buyer-side API keys. (Mainnet
sellers do need a [CDP][cdp] facilitator key; testnet runs against the
free public facilitator with no signup.)

Every product in this repo follows the same shape, so callers (humans or
agents) can switch between them without re-onboarding.

## Repo layout

```
x402.dcprevere.com/
├── README.md
├── package.json
├── src/
│   ├── server.ts            # umbrella Express bootstrap
│   ├── core/                # shared payment/landing/analytics/Product abstraction
│   └── products/
│       └── figlet/          # the figlet product (router + render + validator)
├── buyer/                   # autonomous-buyer demo CLI (@x402/fetch + viem)
├── figpay/                  # historical product docs (planning, pitch)
└── tests/
```

All products are mounted on a single Express server (`/<slug>/...`) and
share one deploy, one wallet, and one `package.json`. Per-product details
live alongside each product's code; product-level pitch / history is in
[`figpay/`](./figpay).

## Network

Currently all products default to **Base Sepolia** (testnet, free, no
signup) using the open `https://x402.org/facilitator`. Mainnet is a config
flip — see [`figpay/README.md`](./figpay/README.md#mainnet-flip-real-money).

[x402]: https://www.x402.org/
[cdp]: https://docs.cdp.coinbase.com/x402/welcome
