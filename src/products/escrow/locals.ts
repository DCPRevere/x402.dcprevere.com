import type { EscrowConditionKind } from "./state.js";

export interface ParsedEscrowCreate {
  buyer: string;
  recipient: string;
  amount_usdc: string;
  condition_kind: EscrowConditionKind;
  condition_value: string;
  deadline: string;
  memo?: string;
}
