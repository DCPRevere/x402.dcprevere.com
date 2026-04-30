import type { ProductHelpInput } from "../../core/help.js";

const LAST_MODIFIED = "2026-04-29T00:00:00Z";

export const randomHelp: ProductHelpInput = {
  name: "random",
  description:
    "Verifiable entropy & sealing primitives: paid randomness, commit-reveal, " +
    "time-locked secrets, and verifiable pool sortition.",
  tags: ["primitive", "randomness", "entropy"],
  status: "live",
  last_modified: LAST_MODIFIED,
  endpoints: [
    {
      slug: "draw",
      name: "random/draw",
      description:
        "Paid randomness: coin, dice, shuffle, picks, distributions, raw bytes, UUIDs. " +
        "Response includes the seed and derivation so callers can reproduce the result.",
      tags: ["randomness", "paid"],
      status: "live",
      last_modified: LAST_MODIFIED,
      input: {
        params: [
          { name: "sides", type: "int", required: false, default: 2, doc: "N-sided die." },
          { name: "count", type: "int", required: false, default: 1, doc: "Independent draws per call (1..256)." },
          { name: "dnd", type: "string", required: false, doc: "Dice notation, e.g. '4d6' or '4d6kh3'." },
          { name: "range", type: "string", required: false, doc: "Uniform integer in [a, b], e.g. '1-100'." },
          { name: "bytes", type: "int", required: false, doc: "Number of raw random bytes (1..256)." },
          { name: "uuid", type: "string", required: false, values: ["v4"], doc: "Generate a UUID." },
          { name: "choose", type: "csv", required: false, doc: "Pick one of N labels." },
          { name: "weights", type: "csv-float", required: false, doc: "Weighted choice; pairs with `choose`." },
          { name: "shuffle", type: "csv", required: false, doc: "Return a random permutation." },
          {
            name: "distribution",
            type: "enum",
            required: false,
            values: ["uniform", "normal", "exponential", "poisson"],
            doc: "Sample from a distribution. Distribution params via mu/sigma/lambda.",
          },
          { name: "mu", type: "float", required: false, doc: "Distribution location parameter." },
          { name: "sigma", type: "float", required: false, doc: "Distribution scale parameter." },
          { name: "lambda", type: "float", required: false, doc: "Rate parameter for exponential/poisson." },
          {
            name: "proof",
            type: "bool",
            required: false,
            default: false,
            doc: "Include the seed → derivation chain in the response (always on for now).",
          },
        ],
      },
      pricing: {
        kind: "parametric",
        rules: [
          { when: "default", amount: "5000", amount_usdc: "0.005" },
          { when: "bytes>=32", min_amount: "10000", min_amount_usdc: "0.01" },
        ],
        examples: [
          { call: "?sides=2", amount: "5000", amount_usdc: "0.005" },
          { call: "?bytes=32", amount: "10000", amount_usdc: "0.01" },
          { call: "?dnd=4d6kh3", amount: "5000", amount_usdc: "0.005" },
        ],
      },
      output: { media_types: ["application/json"] },
      examples: [
        { request: "GET /random/draw?sides=20" },
        { request: "GET /random/draw?dnd=4d6kh3" },
        { request: "GET /random/draw?bytes=16" },
        { request: "GET /random/draw?choose=alice,bob,carol&weights=0.5,0.3,0.2" },
      ],
    },
    {
      slug: "commit",
      name: "random/commit",
      description:
        "Two-phase commit-reveal substrate. POST a hash to commit, later POST the preimage " +
        "to reveal; server arbitrates the binding and returns a signed receipt.",
      tags: ["randomness", "commit-reveal", "paid"],
      status: "live",
      last_modified: LAST_MODIFIED,
      input: {
        params: [
          { name: "commitment", type: "hex32", required: true, doc: "32-byte sha256 of (value || salt)." },
          { name: "deadline", type: "iso8601", required: true, doc: "Reveal deadline; commits expire after." },
          { name: "label", type: "string", required: false, doc: "Optional human label." },
        ],
      },
      pricing: { kind: "flat", amount: "50000", amount_usdc: "0.05" },
      output: { media_types: ["application/json"] },
      examples: [
        { request: "POST /random/commit { commitment, deadline }" },
        { request: "POST /random/commit/<id>/reveal { value, salt }" },
      ],
    },
    {
      slug: "seal",
      name: "random/seal",
      description:
        "Submit ciphertext with a time-lock (block_height or ISO timestamp). The unlock " +
        "key is released by GET /random/seal/<id> as soon as the condition fires. " +
        "Note: the legacy `deposit` unlock_kind is parked as experimental — there is no " +
        "deposit endpoint yet, so a deposit-sealed payload will never unlock. Use " +
        "block_height or timestamp.",
      tags: ["randomness", "time-lock", "paid"],
      status: "live",
      last_modified: LAST_MODIFIED,
      input: {
        params: [
          { name: "ciphertext", type: "base64", required: true, doc: "Encrypted payload up to 8 KiB." },
          {
            name: "unlock_kind",
            type: "enum",
            required: true,
            values: ["block_height", "timestamp"],
            doc:
              "Trigger family. `deposit` is technically accepted by the validator for " +
              "back-compat but currently has no deposit-recording endpoint.",
          },
          { name: "unlock_value", type: "string", required: true, doc: "Block number or ISO timestamp." },
        ],
      },
      pricing: { kind: "flat", amount: "50000", amount_usdc: "0.05" },
      output: { media_types: ["application/json"] },
      examples: [
        { request: "POST /random/seal { ciphertext, unlock_kind: 'timestamp', unlock_value: '...' }" },
        { request: "GET /random/seal/<id>" },
      ],
    },
    {
      slug: "sortition",
      name: "random/sortition",
      description:
        "Register agents in a pool; a verifiable random draw at a future block selects N members.",
      tags: ["randomness", "selection", "paid"],
      status: "live",
      last_modified: LAST_MODIFIED,
      input: {
        params: [
          { name: "pool_name", type: "string", required: true, doc: "Unique pool identifier." },
          { name: "draw_at_block", type: "int", required: true, doc: "Future block number for the draw." },
          { name: "count", type: "int", required: true, doc: "Number of members to draw." },
        ],
      },
      pricing: {
        kind: "parametric",
        rules: [
          { when: "create_pool", amount: "100000", amount_usdc: "0.10" },
          { when: "register", amount: "10000", amount_usdc: "0.01" },
          { when: "draw", amount: "50000", amount_usdc: "0.05" },
        ],
        examples: [
          { call: "POST /random/sortition (create)", amount: "100000", amount_usdc: "0.10" },
          { call: "POST /random/sortition/<id>/register", amount: "10000", amount_usdc: "0.01" },
          { call: "POST /random/sortition/<id>/draw", amount: "50000", amount_usdc: "0.05" },
        ],
      },
      output: { media_types: ["application/json"] },
      examples: [
        { request: "POST /random/sortition { pool_name, draw_at_block, count }" },
      ],
    },
  ],
};
