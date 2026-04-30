import type { ProductHelpInput } from "../../core/help.js";

const LAST_MODIFIED = "2026-04-30T00:00:00Z";

export const wireHelp: ProductHelpInput = {
  name: "wire",
  description:
    "Paid messaging inboxes. Owners create an inbox; senders pay per message; owners " +
    "poll to drain. Free to receive, paid to send — the inverse of email's spam economy.",
  tags: ["primitive", "messaging", "anti-spam"],
  status: "live",
  last_modified: LAST_MODIFIED,
  endpoints: [
    {
      slug: "inbox",
      name: "wire/inbox",
      description:
        "Create a paid inbox owned by a wallet. Returns the inbox id and a one-time " +
        "owner_token used to authenticate /poll and /close. The token is not recoverable; " +
        "lost token = lost inbox.",
      tags: ["messaging", "free"],
      status: "live",
      last_modified: LAST_MODIFIED,
      input: {
        params: [
          { name: "owner_wallet", type: "address", required: true, doc: "Wallet that will own the inbox." },
        ],
      },
      pricing: { kind: "free" },
      output: { media_types: ["application/json"] },
      examples: [
        { request: "POST /wire/inbox { owner_wallet }" },
        { request: "GET /wire/inbox/<id>  (free public metadata)" },
      ],
    },
    {
      slug: "send",
      name: "wire/inbox/:id/send",
      description:
        "Drop a message into an open inbox. Body is plaintext or JSON-encoded payload up " +
        "to 8 KiB. `from` should be the sender's wallet address.",
      tags: ["messaging", "paid"],
      status: "live",
      last_modified: LAST_MODIFIED,
      input: {
        params: [
          { name: "from", type: "address", required: true, doc: "Sender wallet (echoed back to owner)." },
          { name: "body", type: "string", required: true, doc: "Message body, ≤ 8 KiB." },
          { name: "reply_to", type: "string", required: false, doc: "Optional reply hint." },
        ],
      },
      pricing: { kind: "flat", amount: "5000", amount_usdc: "0.005" },
      output: { media_types: ["application/json"] },
      examples: [{ request: "POST /wire/inbox/<id>/send { from, body }" }],
    },
    {
      slug: "poll",
      name: "wire/inbox/:id/poll",
      description:
        "Drain queued messages from an inbox. Owner authenticates via the X-Wire-Owner-Token " +
        "header. Up to 100 messages per call; messages are marked delivered atomically and " +
        "do not reappear on the next poll.",
      tags: ["messaging", "free"],
      status: "live",
      last_modified: LAST_MODIFIED,
      input: {
        params: [
          { name: "max", type: "int", required: false, default: 100, doc: "Max messages to drain (1..100)." },
        ],
      },
      pricing: { kind: "free" },
      output: { media_types: ["application/json"] },
      examples: [{ request: "POST /wire/inbox/<id>/poll  (Header: X-Wire-Owner-Token: <token>)" }],
    },
    {
      slug: "peek",
      name: "wire/inbox/:id/peek",
      description:
        "Read queued messages WITHOUT marking them delivered. Owner-authed. Use to " +
        "inspect senders / amounts / content before deciding to drain. Same auth as poll.",
      tags: ["messaging", "free"],
      status: "live",
      last_modified: LAST_MODIFIED,
      input: {
        params: [
          { name: "max", type: "int", required: false, default: 100, doc: "Max messages to peek at (1..100)." },
        ],
      },
      pricing: { kind: "free" },
      output: { media_types: ["application/json"] },
      examples: [{ request: "GET /wire/inbox/<id>/peek?max=10  (Header: X-Wire-Owner-Token: <token>)" }],
    },
    {
      slug: "close",
      name: "wire/inbox/:id/close",
      description: "Close an inbox. Future sends are rejected with 410 Gone.",
      tags: ["messaging", "free"],
      status: "live",
      last_modified: LAST_MODIFIED,
      input: { params: [] },
      pricing: { kind: "free" },
      output: { media_types: ["application/json"] },
      examples: [{ request: "POST /wire/inbox/<id>/close  (Header: X-Wire-Owner-Token: <token>)" }],
    },
  ],
};
