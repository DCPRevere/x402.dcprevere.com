# buyer demo

A small Node script that pays the figlet API autonomously using x402 — the
"agent side" of the agentic-economy demo.

It does what an AI agent would do:
1. Calls `GET /figlet/render?text=…`
2. Receives `HTTP 402` with payment instructions
3. Signs a USDC transfer from a test wallet
4. Retries with the `X-PAYMENT` header
5. Receives the ASCII art and prints it

## One-time setup (Base Sepolia testnet)

You need a fresh wallet that holds a tiny amount of testnet ETH (gas) and
testnet USDC. **Do not reuse a real wallet.**

1. Generate a private key. Any Ethereum keypair generator works; for example:
   ```bash
   node -e 'import("viem/accounts").then(m=>{const k=m.generatePrivateKey();const a=m.privateKeyToAccount(k);console.log("PK:",k);console.log("ADDR:",a.address);})'
   ```
   Save the private key as `BUYER_PRIVATE_KEY`.

2. Fund the address with **Base Sepolia ETH** (for gas) from a public faucet,
   e.g. https://www.alchemy.com/faucets/base-sepolia or
   https://faucet.quicknode.com/base/sepolia.

3. Fund the address with **Base Sepolia USDC** from the Circle faucet:
   https://faucet.circle.com (select Base Sepolia, USDC).

4. Make sure the umbrella server is running and `PAY_TO` is set to a
   different address than the buyer's.

## Run

```bash
export BUYER_PRIVATE_KEY=0x...
export X402_URL=http://localhost:4021       # or https://x402.dcprevere.com
npm run buyer -- "hello agent economy"
```

Optional: `FONT=Slant` (defaults to `Slant`).

You should see:
```
buyer: 0xabc...
GET http://localhost:4021/figlet/render?text=hello%20agent%20economy&font=Slant
paid: { ... settlement details ... }
    __         ____
   / /_  ___  / / /___
  ...
```

The transfer is visible on Base Sepolia explorer:
https://sepolia.basescan.org/address/<your-wallet> (look for USDC transfer
to the seller's address).
