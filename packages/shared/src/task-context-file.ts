/**
 * The task context file (PR 6 §2.4) and root immutable run env carrier (MUL-1 A2 §4.3):
 *
 * - Ordinary Chat lanes that may park receive `MULTIREMI_TASK_CONTEXT_FILE`, a stable
 *   path the daemon rewrites (tmp + rename) whenever an attempt starts on the process
 *   and clears (`token: null`) when the lane parks with no attempt.
 * - Root attempts NEVER use disk context file fallback: each root run executes in an
 *   isolated process with `MULTIREMI_ROOT_CARRIER=immutable_run_env` and its verified
 *   `MULTIREMI_TOKEN`, `MULTIREMI_ATTEMPT_ID`, and receipt metadata injected directly
 *   into that run's immutable process environment. If `MULTIREMI_ROOT_CARRIER` is set
 *   alongside `MULTIREMI_TASK_CONTEXT_FILE` or without a verified env token, readers
 *   fail closed rather than falling back to a context file or user config token.
 */
import { readFileSync } from "node:fs";

export const TASK_CONTEXT_FILE_ENV = "MULTIREMI_TASK_CONTEXT_FILE";
export const ROOT_CARRIER_MODE_ENV = "MULTIREMI_ROOT_CARRIER";
export const ROOT_CARRIER_IMMUTABLE_ENV = "immutable_run_env" as const;
export const ROOT_RECEIPT_ID_ENV = "MULTIREMI_ROOT_RECEIPT_ID";
export const ROOT_DELIVERY_VERSION_ENV = "MULTIREMI_ROOT_DELIVERY_VERSION";
export const ROOT_RUN_GENERATION_ENV = "MULTIREMI_ROOT_RUN_GENERATION";

/** What a reader gets while the lane is parked (no attempt, no credential). */
export const TASK_CONTEXT_PARKED_MESSAGE = "后台任务所在的轮已结束，暂无有效凭据";

export type RootCarrierViolationCode =
  | "root_context_file_forbidden"
  | "root_immutable_env_missing"
  | "root_carrier_unsupported";

export const ROOT_CARRIER_VIOLATION_MESSAGES: Readonly<Record<RootCarrierViolationCode, string>> = {
  root_context_file_forbidden:
    "Root run uses immutable env carrier and must not inherit MULTIREMI_TASK_CONTEXT_FILE.",
  root_immutable_env_missing:
    "Root run immutable env carrier is missing its verified MULTIREMI_TOKEN.",
  root_carrier_unsupported:
    "Unsupported MULTIREMI_ROOT_CARRIER value; expected immutable_run_env.",
};

/** The file's JSON. */
export interface TaskContextFile {
  token: string | null;
  turn_id: string | null;
  attempt_id: string | null;
  /** ISO 8601. */
  written_at: string;
}

export interface TaskContext {
  token: string | null;
  turnId: string | null;
  attemptId: string | null;
  /** Where it came from: the context file, ordinary spawn env, or root immutable run env. */
  source: "file" | "env" | "root_immutable_env";
  /** The file says no attempt runs on the process (it is parked). */
  parked: boolean;
  /** Present when the process declared a root carrier. */
  rootCarrier?: {
    mode: string;
    receiptId: string | null;
    deliveryVersion: number | null;
    runGeneration: number | null;
    violation: RootCarrierViolationCode | null;
  };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInt(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** The context file at `path`, when it is readable and well formed; null otherwise. */
export function readTaskContextFile(path: string): TaskContextFile | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> | null;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (value.token !== null && typeof value.token !== "string") return null;
    return { token: text(value.token), turn_id: text(value.turn_id), attempt_id: text(value.attempt_id),
      written_at: typeof value.written_at === "string" ? value.written_at : "" };
  } catch {
    return null;
  }
}

/**
 * The task's token, turn and attempt:
 * - When `MULTIREMI_ROOT_CARRIER` is declared, strictly resolves from immutable run env
 *   and never reads or falls back to `MULTIREMI_TASK_CONTEXT_FILE`.
 * - Otherwise preserves legacy behavior: readable `MULTIREMI_TASK_CONTEXT_FILE` wins, else env.
 */
export function resolveTaskContext(env: Readonly<Record<string, string | undefined>> = process.env): TaskContext {
  const rootCarrierMode = text(env[ROOT_CARRIER_MODE_ENV]);
  if (rootCarrierMode !== null) {
    const receiptId = text(env[ROOT_RECEIPT_ID_ENV]);
    const deliveryVersion = positiveInt(env[ROOT_DELIVERY_VERSION_ENV]);
    const runGeneration = positiveInt(env[ROOT_RUN_GENERATION_ENV]);
    const hasLegacyContextFile = text(env[TASK_CONTEXT_FILE_ENV]) !== null;
    const token = text(env.MULTIREMI_TOKEN);
    let violation: RootCarrierViolationCode | null = null;
    if (rootCarrierMode !== ROOT_CARRIER_IMMUTABLE_ENV) {
      violation = "root_carrier_unsupported";
    } else if (hasLegacyContextFile) {
      violation = "root_context_file_forbidden";
    } else if (token === null) {
      violation = "root_immutable_env_missing";
    }
    return {
      token: violation ? null : token,
      turnId: text(env.MULTIREMI_TURN_ID),
      attemptId: text(env.MULTIREMI_ATTEMPT_ID),
      source: "root_immutable_env",
      parked: false,
      rootCarrier: {
        mode: rootCarrierMode,
        receiptId,
        deliveryVersion,
        runGeneration,
        violation,
      },
    };
  }
  const path = text(env[TASK_CONTEXT_FILE_ENV]);
  const file = path ? readTaskContextFile(path) : null;
  if (file) {
    return { token: file.token, turnId: file.turn_id, attemptId: file.attempt_id, source: "file", parked: file.token === null };
  }
  return { token: text(env.MULTIREMI_TOKEN), turnId: text(env.MULTIREMI_TURN_ID), attemptId: text(env.MULTIREMI_ATTEMPT_ID),
    source: "env", parked: false };
}
