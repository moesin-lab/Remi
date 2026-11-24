import type { PolicyOfferIdentity } from './system-prompt-policy.js';

export interface RestartPolicyReceipt extends PolicyOfferIdentity {
  turn_id: string;
  handoff_id: string;
  prior_restart_generation: number;
}

/** References and receipts only: no credentials, message bodies or provider input. */
export interface PlannedRestartCheckpoint {
  version: 1;
  session_id: string | null;
  work_dir: string | null;
  trace_head: number;
  input_ack_seq: number;
  delivered_message_ids: string[];
  /** Original native waits; bodies and answers remain server-owned. */
  question_ids?: string[];
  policy_receipt?: RestartPolicyReceipt;
}

/** Compare the operation being retried, excluding process-local callback identities. */
export function restartQuestionKey(metadata: Record<string, unknown>): string {
  const tool = metadata.tool_call as Record<string, unknown> | null | undefined;
  const subagent = metadata.subagent as Record<string, unknown> | undefined;
  const value = metadata.kind === "permission"
    ? { kind: metadata.kind, tool: tool ? Object.fromEntries(Object.entries(tool).filter(([key]) => key !== "toolCallId" && key !== "status")) : null,
        options: metadata.options, subagent: subagent?.item_id ?? null }
    : { kind: metadata.kind, message: metadata.message, questions: metadata.questions, subagent: subagent?.item_id ?? null };
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])) : item;
  return JSON.stringify(canonical(value));
}
