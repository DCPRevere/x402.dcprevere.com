/**
 * Autonomous-buyer demo for x402.aegent.dev.
 *
 * Usage:
 *   npm run buyer                   # default: figlet (one paid call)
 *   npm run buyer figlet            # render text in a figlet font
 *   npm run buyer random            # paid die roll
 *   npm run buyer passport          # mint an anti-captcha pass (low-difficulty)
 *   npm run buyer wire              # create inbox, paid send, owner-poll
 *   npm run buyer board             # post to /agora/board
 *   npm run buyer bar               # speak in /agora/bar (cheapest call: $0.001)
 *   npm run buyer auction           # full sealed-bid lifecycle (4 paid steps)
 *   npm run buyer all               # walk every scenario in turn
 *
 * Required env:
 *   BUYER_PRIVATE_KEY  — Sepolia-only test wallet, funded with USDC + ETH
 *   X402_URL           — base URL of the umbrella (default: http://localhost:4021)
 *   NETWORK            — CAIP-2 chain id (default: eip155:84532 = Base Sepolia)
 *
 * See buyer/README.md for faucet links.
 */
import crypto from "node:crypto";
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import "dotenv/config";

const baseUrl = (process.env.X402_URL ?? "http://localhost:4021").replace(/\/+$/, "");
const networkRaw = process.env.NETWORK ?? "eip155:84532";
if (!/^[^:]+:[^:]+$/.test(networkRaw)) {
  console.error(`NETWORK must be CAIP-2 (e.g. eip155:84532), got: ${networkRaw}`);
  process.exit(1);
}
const network = networkRaw as `${string}:${string}`;
const privateKey = process.env.BUYER_PRIVATE_KEY;

if (!privateKey) {
  console.error(
    "Set BUYER_PRIVATE_KEY (a Sepolia-only test wallet). See buyer/README.md for faucet links.",
  );
  process.exit(1);
}

const account = privateKeyToAccount(privateKey as `0x${string}`);
console.error(`buyer wallet: ${account.address}`);
console.error(`umbrella:     ${baseUrl}`);
console.error(`network:      ${network}`);
console.error("");

const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network, client: new ExactEvmScheme(account) }],
});

// ----- Helpers --------------------------------------------------------

interface PaidCallResult {
  status: number;
  body: unknown;
  paid: unknown;
}

async function paidCall(method: "GET" | "POST", path: string, body?: unknown): Promise<PaidCallResult> {
  const url = `${baseUrl}${path}`;
  console.error(`→ ${method} ${path}`);
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetchWithPayment(url, init);
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep as text */
  }

  const paymentResponse =
    res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
  let paid: unknown = null;
  if (paymentResponse) {
    try {
      paid = decodePaymentResponseHeader(paymentResponse);
    } catch {
      paid = "(decode failed)";
    }
  }
  console.error(`  ← ${res.status} ${paid ? "(paid)" : ""}`);
  return { status: res.status, body: parsed, paid };
}

async function freeCall(method: "GET" | "POST", path: string, body?: unknown): Promise<PaidCallResult> {
  // For free routes we still go through the wrapped fetch — it'll skip
  // payment when the server returns 200 directly.
  return paidCall(method, path, body);
}

// ----- Scenarios ------------------------------------------------------

async function scenarioFiglet(text = "hello agent") {
  console.error("== /graphics/figlet/render ==");
  const r = await paidCall(
    "GET",
    `/graphics/figlet/render?text=${encodeURIComponent(text)}&font=Slant`,
  );
  if (r.status === 200 && typeof r.body === "string") {
    process.stdout.write(r.body);
    if (!r.body.endsWith("\n")) process.stdout.write("\n");
  }
}

async function scenarioRandom() {
  console.error("== /random/draw ==");
  const r = await paidCall("GET", "/random/draw?dnd=4d6kh3");
  console.error(JSON.stringify(r.body, null, 2));
}

async function scenarioBar() {
  console.error("== /agora/bar/say (cheapest paid call: $0.001) ==");
  const say = await paidCall("POST", "/agora/bar/say", {
    speaker: account.address,
    line: `hello from ${account.address.slice(0, 8)} via the agentic economy`,
  });
  console.error(say.body);
  const tail = await freeCall("GET", "/agora/bar?limit=5");
  console.error("recent bar:", tail.body);
}

async function scenarioBoard() {
  console.error("== /agora/board/post ==");
  const post = await paidCall("POST", "/agora/board/post", {
    author: account.address,
    body: `posted by ${account.address.slice(0, 8)} at ${new Date().toISOString()}`,
  });
  console.error(post.body);
}

function leadingZeroBits(buf: Buffer): number {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    for (let mask = 0x80; mask; mask >>= 1) {
      if ((byte & mask) === 0) bits++;
      else return bits;
    }
  }
  return bits;
}

function mineSolution(nonce: string, difficulty: number, maxIters = 1_000_000): string {
  for (let i = 0; i < maxIters; i++) {
    const cand = i.toString(16);
    const h = crypto
      .createHash("sha256")
      .update(Buffer.from(nonce, "hex"))
      .update(Buffer.from(cand, "utf8"))
      .digest();
    if (leadingZeroBits(h) >= difficulty) return cand;
  }
  throw new Error(`mineSolution: exhausted ${maxIters} attempts at difficulty ${difficulty}`);
}

async function scenarioPassport() {
  console.error("== /passport/anti-captcha (issue → solve) ==");
  // Challenge issue is free; solve is free; the only paid surface here is
  // /passport/bind, which requires a real ENS/domain/gist to verify against
  // and so isn't on-rails for an arbitrary buyer wallet.
  const challenge = await freeCall("POST", "/passport/anti-captcha/challenge", {
    wallet: account.address,
    difficulty: 12,
  });
  const c = challenge.body as { id: string; nonce: string; difficulty: number };
  console.error(`challenge ${c.id} (difficulty=${c.difficulty}); mining...`);
  const solution = mineSolution(c.nonce, c.difficulty);
  console.error(`found solution: ${solution}`);
  const solve = await freeCall("POST", "/passport/anti-captcha/solve", {
    challenge_id: c.id,
    solution,
  });
  console.error("pass issued:", solve.body);
}

async function scenarioWire() {
  console.error("== /wire (create inbox → paid send → peek → poll) ==");
  const create = await freeCall("POST", "/wire/inbox", { owner_wallet: account.address });
  const created = create.body as { inbox: { id: string }; owner_token: string };
  console.error(`inbox id: ${created.inbox.id}`);

  // Paid send (from ourselves to ourselves, just to demo the flow).
  await paidCall("POST", `/wire/inbox/${created.inbox.id}/send`, {
    from: account.address,
    body: "hello future me",
  });

  // Peek (free) — see what's queued without consuming.
  const peek = await fetch(`${baseUrl}/wire/inbox/${created.inbox.id}/peek`, {
    method: "GET",
    headers: { "X-Wire-Owner-Token": created.owner_token },
  });
  console.error("peek:", await peek.json());

  // Drain (free, owner-authed).
  const poll = await fetch(`${baseUrl}/wire/inbox/${created.inbox.id}/poll`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Wire-Owner-Token": created.owner_token },
    body: JSON.stringify({}),
  });
  console.error("drained:", await poll.json());
}

async function scenarioAuction() {
  console.error("== /agora/auction (create → bid → reveal → finalize) ==");
  console.error("Note: this scenario uses a 5-second bid window and 5-second reveal window");
  console.error("for demo purposes. Real auctions should give bidders longer windows.\n");

  const bidDeadline = new Date(Date.now() + 5_000).toISOString();
  const revealDeadline = new Date(Date.now() + 10_000).toISOString();

  const create = await paidCall("POST", "/agora/auction/create", {
    seller: account.address,
    description: "one (1) verifiable agentic-economy demo",
    min_bid_usdc: "1000",
    bid_deadline: bidDeadline,
    reveal_deadline: revealDeadline,
  });
  const auction = (create.body as { auction: { id: string } }).auction;
  console.error(`auction id: ${auction.id}`);

  // Bid (the buyer can't bid in their own auction, so this scenario is
  // demonstrative — in production buyer and seller are different wallets).
  console.error("\nThis demo wallet is also the seller, so bidding is rejected by design.");
  console.error("Run two buyer instances with different keys to bid against each other.");
  console.error("\nWaiting for bid window to close...");
  await new Promise((r) => setTimeout(r, 6_000));

  console.error("Waiting for reveal window to close...");
  await new Promise((r) => setTimeout(r, 5_000));

  const finalize = await freeCall("POST", `/agora/auction/${auction.id}/finalize`);
  console.error("finalize:", JSON.stringify(finalize.body, null, 2));
}

const SCENARIOS: Record<string, () => Promise<void>> = {
  figlet: () => scenarioFiglet(process.argv.slice(3).join(" ") || "hello agent"),
  random: scenarioRandom,
  bar: scenarioBar,
  board: scenarioBoard,
  passport: scenarioPassport,
  wire: scenarioWire,
  auction: scenarioAuction,
};

async function runAll() {
  for (const [name, fn] of Object.entries(SCENARIOS)) {
    if (name === "auction") continue; // skip in `all` due to the 11s wait
    console.error(`\n────────── ${name} ──────────`);
    try {
      await fn();
    } catch (err) {
      console.error(`scenario ${name} failed:`, err instanceof Error ? err.message : err);
    }
  }
}

const scenario = process.argv[2] ?? "figlet";
if (scenario === "all") {
  await runAll();
} else if (SCENARIOS[scenario]) {
  await SCENARIOS[scenario]();
} else {
  console.error(`unknown scenario: ${scenario}`);
  console.error(`available: ${Object.keys(SCENARIOS).join(", ")}, all`);
  process.exit(1);
}
