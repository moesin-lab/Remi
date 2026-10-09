import type { z } from "zod";
import type { AgentTask } from "../types";
import type { TurnSchema, AttemptSchema } from "./schemas/messages";

const text = (value: unknown): string | null => typeof value === "string" ? value : null;

export function turnToTask(turn: z.infer<typeof TurnSchema>, attempt?: z.infer<typeof AttemptSchema>): AgentTask {
  const execution = attempt ?? turn.current_attempt;
  const state = attempt && attempt.id !== turn.current_attempt_id ? attempt.status : turn.status;
  const status: AgentTask["status"] = state === "pending" || state === "offered" ? "queued"
    : state === "accepted" ? "dispatched" : state === "lost" ? "failed"
    : state as AgentTask["status"];

  return {
    id: execution?.id ?? turn.current_attempt_id ?? turn.id, turn_id: turn.id,
    agent_id: turn.agent_id, issue_id: text(turn.issue_id) ?? "", issue_session_id: turn.session_id,
    chat_session_id: turn.chat_session_id !== undefined ? turn.chat_session_id ?? undefined
      : turn.session_id.startsWith("chat_") ? turn.session_id : undefined,
    runtime_id: text(execution?.runtime_id), status, priority: typeof turn.priority === "number" ? turn.priority : 0,
    dispatched_at: text(attempt?.accepted_at), started_at: attempt?.started_at ?? turn.started_at,
    completed_at: attempt?.ended_at ?? turn.ended_at, created_at: turn.created_at,
    error: execution?.error ?? null,
    failure_reason: (text(execution?.failure_reason) ?? undefined) as AgentTask["failure_reason"],
    result: null, attempt: attempt?.attempt_no,
    execution_model: attempt?.execution_model ?? null, execution_thinking_level: text(attempt?.execution_thinking_level),
    executionModel: attempt?.execution_model ?? null, executionThinkingLevel: attempt?.execution_thinking_level,
    usage: attempt?.usage, fallbackSwitched: attempt?.fallback_switched, switchReason: attempt?.switch_reason,
    progress_summary: text(execution?.progress_summary),
    progress_step: typeof execution?.progress_step === "number" ? execution.progress_step : null,
    progress_total: typeof execution?.progress_total === "number" ? execution.progress_total : null,
    wait_reason: text(attempt?.wait_reason),
    prompt: text(turn.legacy_prompt) ?? undefined,
  };
}
