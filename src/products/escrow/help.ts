import type { ProductHelpInput } from "../../core/help.js";

const LAST_MODIFIED = "2026-04-30T00:00:00Z";

export const escrowHelp: ProductHelpInput = {
  name: "escrow",
  description:
    "Conditional value attestations. A buyer locks an escrow against a recipient and " +
    "a release condition (block height, timestamp, passport binding, or revealed commit). " +
    "When the condition fires, anyone can trigger release; otherwise the buyer can refund " +
    "after the deadline. Server emits HMAC-signed receipts that downstream contracts can " +
    "honour.",
  tags: ["primitive", "escrow", "attestation", "paid"],
  status: "live",
  last_modified: LAST_MODIFIED,
  endpoints: [
    {
      slug: "create",
      name: "escrow/create",
      description:
        "Open an escrow. The server records buyer, recipient, amount, condition, and " +
        "deadline, and returns the escrow id. The escrow is settled either by /release " +
        "(condition met) or /refund (deadline passed without release).",
      tags: ["escrow", "paid"],
      status: "live",
      last_modified: LAST_MODIFIED,
      input: {
        params: [
          { name: "buyer", type: "address", required: true, doc: "0x address funding the escrow." },
          { name: "recipient", type: "address", required: true, doc: "0x address that receives on release." },
          { name: "amount_usdc", type: "string", required: true, doc: "USDC base units, decimal string." },
          {
            name: "condition_kind",
            type: "enum",
            required: true,
            values: ["block_height", "timestamp", "passport_binding", "commit_revealed"],
            doc: "Which family of condition to evaluate.",
          },
          {
            name: "condition_value",
            type: "string",
            required: true,
            doc:
              "Block number, ISO timestamp, '<wallet>:<anchor_kind>:<anchor_value>' (passport_binding), " +
              "or a /random/commit id (commit_revealed).",
          },
          { name: "deadline", type: "iso8601", required: true, doc: "Refund window opens at this time." },
          { name: "memo", type: "string", required: false, doc: "Optional buyer memo, ≤ 256 chars." },
        ],
      },
      pricing: { kind: "flat", amount: "100000", amount_usdc: "0.10" },
      output: { media_types: ["application/json"] },
      examples: [
        {
          request:
            "POST /escrow/create { buyer, recipient, amount_usdc, condition_kind: 'timestamp', condition_value: '2026-12-31T00:00:00Z', deadline: '2027-01-31T00:00:00Z' }",
        },
      ],
    },
    {
      slug: "release",
      name: "escrow/:id/release",
      description:
        "Attempt to release the escrow to the recipient. Anyone may call. Server " +
        "evaluates the condition; on success returns a signed release attestation that " +
        "the recipient can present to a settlement contract.",
      tags: ["escrow", "free"],
      status: "live",
      last_modified: LAST_MODIFIED,
      input: { params: [] },
      pricing: { kind: "free" },
      output: { media_types: ["application/json"] },
      examples: [{ request: "POST /escrow/<id>/release" }],
    },
    {
      slug: "refund",
      name: "escrow/:id/refund",
      description:
        "Issue a refund attestation if the deadline has passed without a release. " +
        "Returns 400 while the escrow is still releasable.",
      tags: ["escrow", "free"],
      status: "live",
      last_modified: LAST_MODIFIED,
      input: { params: [] },
      pricing: { kind: "free" },
      output: { media_types: ["application/json"] },
      examples: [{ request: "POST /escrow/<id>/refund" }],
    },
    {
      slug: "get",
      name: "escrow/:id",
      description: "Read the current state of an escrow.",
      tags: ["escrow", "free"],
      status: "live",
      last_modified: LAST_MODIFIED,
      input: { params: [] },
      pricing: { kind: "free" },
      output: { media_types: ["application/json"] },
      examples: [{ request: "GET /escrow/<id>" }],
    },
  ],
};
