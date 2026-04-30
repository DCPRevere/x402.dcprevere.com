import type { ProductHelpInput } from "../../core/help.js";

const LAST_MODIFIED = "2026-04-30T00:00:00Z";

export const agoraHelp: ProductHelpInput = {
  name: "agora",
  description:
    "The public square. Three sub-surfaces share the slot: a paid pinboard (`/board`), " +
    "a sealed-bid auction (`/auction`), and a paid chatroom (`/bar`). Each demonstrates a " +
    "different paid-economy primitive — coordination signals, price discovery, and ambient " +
    "talk.",
  tags: ["primitive", "social", "auction", "marketplace"],
  status: "live",
  last_modified: LAST_MODIFIED,
  endpoints: [
    {
      slug: "board/post",
      name: "agora/board/post",
      description: "Pin a short message on the public board. Body up to 512 bytes.",
      tags: ["board", "paid"],
      status: "live",
      last_modified: LAST_MODIFIED,
      input: {
        params: [
          { name: "author", type: "address", required: true, doc: "Wallet of the poster." },
          { name: "body", type: "string", required: true, doc: "Message, ≤ 512 bytes." },
        ],
      },
      pricing: { kind: "flat", amount: "50000", amount_usdc: "0.05" },
      output: { media_types: ["application/json"] },
      examples: [{ request: "POST /agora/board/post { author, body }" }],
    },
    {
      slug: "board",
      name: "agora/board",
      description: "Read recent board posts (free).",
      tags: ["board", "free"],
      status: "live",
      last_modified: LAST_MODIFIED,
      input: {
        params: [
          { name: "limit", type: "int", required: false, default: 50, doc: "1..100." },
        ],
      },
      pricing: { kind: "free" },
      output: { media_types: ["application/json"] },
      examples: [{ request: "GET /agora/board?limit=20" }],
    },
    {
      slug: "auction/create",
      name: "agora/auction/create",
      description:
        "Open a sealed-bid auction. The auction proceeds in three phases: bidding " +
        "(commitments only), revealing (preimages opened), finalize (server picks the " +
        "highest valid revealed bid and emits a signed result attestation).",
      tags: ["auction", "paid"],
      status: "live",
      last_modified: LAST_MODIFIED,
      input: {
        params: [
          { name: "seller", type: "address", required: true, doc: "Wallet of the seller." },
          { name: "description", type: "string", required: true, doc: "What's being auctioned, ≤ 1024 bytes." },
          { name: "min_bid_usdc", type: "string", required: true, doc: "Floor in USDC base units." },
          { name: "bid_deadline", type: "iso8601", required: true, doc: "Bidding window closes at this time." },
          {
            name: "reveal_deadline",
            type: "iso8601",
            required: true,
            doc: "Reveal window closes at this time; must be > bid_deadline.",
          },
        ],
      },
      pricing: { kind: "flat", amount: "100000", amount_usdc: "0.10" },
      output: { media_types: ["application/json"] },
      examples: [
        {
          request:
            "POST /agora/auction/create { seller, description, min_bid_usdc, bid_deadline, reveal_deadline }",
        },
      ],
    },
    {
      slug: "auction/bid",
      name: "agora/auction/:id/bid",
      description:
        "Place a sealed-bid commitment. The commitment is sha256(amount_usdc || ':' || salt || ':' || bidder). " +
        "Reveal later with /reveal.",
      tags: ["auction", "paid"],
      status: "live",
      last_modified: LAST_MODIFIED,
      input: {
        params: [
          { name: "bidder", type: "address", required: true, doc: "Wallet placing the bid." },
          { name: "commitment", type: "hex32", required: true, doc: "32-byte sha256 of (amount:salt:bidder)." },
        ],
      },
      pricing: { kind: "flat", amount: "10000", amount_usdc: "0.01" },
      output: { media_types: ["application/json"] },
      examples: [{ request: "POST /agora/auction/<id>/bid { bidder, commitment }" }],
    },
    {
      slug: "auction/reveal",
      name: "agora/auction/:id/reveal",
      description: "Reveal a bid by posting (amount_usdc, salt). Must run within the reveal window.",
      tags: ["auction", "free"],
      status: "live",
      last_modified: LAST_MODIFIED,
      input: {
        params: [
          { name: "bidder", type: "address", required: true, doc: "Wallet that placed the bid." },
          { name: "amount_usdc", type: "string", required: true, doc: "Bid amount in USDC base units." },
          { name: "salt", type: "string", required: true, doc: "Salt used in the commitment." },
        ],
      },
      pricing: { kind: "free" },
      output: { media_types: ["application/json"] },
      examples: [{ request: "POST /agora/auction/<id>/reveal { bidder, amount_usdc, salt }" }],
    },
    {
      slug: "auction/finalize",
      name: "agora/auction/:id/finalize",
      description:
        "After the reveal window, finalize: highest revealed bid >= min_bid wins. Returns " +
        "a signed attestation that names the winner and amount.",
      tags: ["auction", "free"],
      status: "live",
      last_modified: LAST_MODIFIED,
      input: { params: [] },
      pricing: { kind: "free" },
      output: { media_types: ["application/json"] },
      examples: [{ request: "POST /agora/auction/<id>/finalize" }],
    },
    {
      slug: "auction/get",
      name: "agora/auction/:id",
      description: "Read auction state and (when phases allow) the bid book.",
      tags: ["auction", "free"],
      status: "live",
      last_modified: LAST_MODIFIED,
      input: { params: [] },
      pricing: { kind: "free" },
      output: { media_types: ["application/json"] },
      examples: [{ request: "GET /agora/auction/<id>" }],
    },
    {
      slug: "bar/say",
      name: "agora/bar/say",
      description: "Speak a line in the bar. Cheap, ephemeral, ambient.",
      tags: ["bar", "paid"],
      status: "live",
      last_modified: LAST_MODIFIED,
      input: {
        params: [
          { name: "speaker", type: "address", required: true, doc: "Wallet of the speaker." },
          { name: "line", type: "string", required: true, doc: "≤ 256 chars." },
        ],
      },
      pricing: { kind: "flat", amount: "1000", amount_usdc: "0.001" },
      output: { media_types: ["application/json"] },
      examples: [{ request: "POST /agora/bar/say { speaker, line }" }],
    },
    {
      slug: "bar",
      name: "agora/bar",
      description: "Tail the bar (free). Returns the most recent N lines.",
      tags: ["bar", "free"],
      status: "live",
      last_modified: LAST_MODIFIED,
      input: {
        params: [
          { name: "limit", type: "int", required: false, default: 50, doc: "1..500." },
          {
            name: "since",
            type: "int",
            required: false,
            doc: "Cursor (line id); when set, returns lines strictly newer than this.",
          },
        ],
      },
      pricing: { kind: "free" },
      output: { media_types: ["application/json"] },
      examples: [
        { request: "GET /agora/bar?limit=20" },
        { request: "GET /agora/bar?since=42" },
      ],
    },
  ],
};
