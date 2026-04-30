import { getDb } from "../../core/persist.js";
import type { EscrowConditionKind, EscrowRow } from "./state.js";

/**
 * Pluggable condition evaluators. Each kind maps to a (row, ctx) → boolean
 * predicate. We pass everything the evaluator might need through `ctx` rather
 * than reaching into config or chain at evaluator time, so tests can drive
 * synthetic block heights, clocks, and passport / commit lookups.
 */

export interface ConditionContext {
  /** Server clock; tests inject a fixed Date. */
  now: Date;
  /** Current chain head, when known. */
  currentBlock?: bigint;
  /** Lookup hook for passport_binding conditions. */
  hasPassportBinding?: (wallet: string, anchorKind: string, anchorValue: string) => boolean;
}

export interface EvaluationResult {
  met: boolean;
  detail: string;
}

export function evaluateCondition(row: EscrowRow, ctx: ConditionContext): EvaluationResult {
  switch (row.condition_kind) {
    case "block_height": {
      if (ctx.currentBlock === undefined) {
        return { met: false, detail: "current block height unknown to server" };
      }
      const target = BigInt(row.condition_value);
      if (ctx.currentBlock >= target) {
        return { met: true, detail: `block ${ctx.currentBlock} >= target ${target}` };
      }
      return { met: false, detail: `block ${ctx.currentBlock} < target ${target}` };
    }
    case "timestamp": {
      const target = Date.parse(row.condition_value);
      if (!Number.isFinite(target)) return { met: false, detail: "invalid timestamp" };
      if (ctx.now.getTime() >= target) {
        return { met: true, detail: `now ${ctx.now.toISOString()} >= target ${row.condition_value}` };
      }
      return { met: false, detail: `now ${ctx.now.toISOString()} < target ${row.condition_value}` };
    }
    case "passport_binding": {
      const parsed = parsePassportSelector(row.condition_value);
      if (!parsed) return { met: false, detail: "passport_binding selector malformed" };
      const lookup = ctx.hasPassportBinding ?? defaultPassportLookup;
      const present = lookup(parsed.wallet, parsed.anchor_kind, parsed.anchor_value);
      return present
        ? { met: true, detail: `passport binding present for ${parsed.wallet}/${parsed.anchor_kind}` }
        : { met: false, detail: `no passport binding for ${parsed.wallet}/${parsed.anchor_kind}` };
    }
    case "commit_revealed": {
      const commitId = row.condition_value;
      const commit = getDb()
        .prepare(`SELECT state FROM random_commits WHERE id = ?`)
        .get(commitId) as { state: string } | undefined;
      if (!commit) return { met: false, detail: `no random commit ${commitId}` };
      if (commit.state === "revealed") {
        return { met: true, detail: `commit ${commitId} revealed` };
      }
      return { met: false, detail: `commit ${commitId} is ${commit.state}` };
    }
  }
}

interface PassportSelector {
  wallet: string;
  anchor_kind: string;
  anchor_value: string;
}

/**
 * passport_binding condition values look like:
 *   "0xabc...:ens:foo.eth"
 *   "0xabc...:domain:example.com"
 */
export function parsePassportSelector(value: string): PassportSelector | null {
  const parts = value.split(":");
  if (parts.length < 3) return null;
  const wallet = parts[0];
  const anchor_kind = parts[1];
  const anchor_value = parts.slice(2).join(":");
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) return null;
  if (!["ens", "domain", "gist"].includes(anchor_kind)) return null;
  if (!anchor_value) return null;
  return { wallet: wallet.toLowerCase(), anchor_kind, anchor_value };
}

function defaultPassportLookup(wallet: string, anchorKind: string, anchorValue: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 FROM passport_bindings
        WHERE wallet = ? AND anchor_kind = ? AND anchor_value = ?
          AND verified = 1 AND expires_at > ?
        LIMIT 1`,
    )
    .get(wallet.toLowerCase(), anchorKind, anchorValue, new Date().toISOString());
  return row !== undefined;
}

export function isValidConditionKind(kind: unknown): kind is EscrowConditionKind {
  return (
    kind === "block_height" ||
    kind === "timestamp" ||
    kind === "passport_binding" ||
    kind === "commit_revealed"
  );
}
