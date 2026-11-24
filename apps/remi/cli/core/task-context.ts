/**
 * The credential and turn a `remi` command run inside a task uses (PR 6 §2.4
 * and MUL-1 A2 §4.3).
 *
 * - Ordinary Chat lanes can outlive one attempt and update `MULTIREMI_TASK_CONTEXT_FILE`.
 * - Root attempts NEVER use disk context file fallback: they declare
 *   `MULTIREMI_ROOT_CARRIER=immutable_run_env` and receive their verified token
 *   and execution identity solely via that run's immutable process environment.
 *   Any violation (legacy context file present, missing env token, unsupported
 *   carrier mode) fails closed rather than falling back to disk files or user config.
 */
import {
  resolveTaskContext,
  ROOT_CARRIER_VIOLATION_MESSAGES,
  TASK_CONTEXT_PARKED_MESSAGE,
  type TaskContext,
} from "@shared/task-context-file.js";
import { CliError } from "./errors.js";

/**
 * The task's token:
 * - For `root_immutable_env`, strictly returns the verified immutable env token or
 *   throws `auth_required` on any carrier violation (never falls back to file or config).
 * - For ordinary lanes, returns the context file's token if readable, else `MULTIREMI_TOKEN`
 *   (an empty tombstone stays empty so no other credential stands in for it).
 */
export function taskCredential(env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  const context = resolveTaskContext(env);
  if (context.rootCarrier?.violation) {
    throw new CliError("auth_required", ROOT_CARRIER_VIOLATION_MESSAGES[context.rootCarrier.violation], {
      serverCode: context.rootCarrier.violation,
      details: {
        carrier_mode: context.rootCarrier.mode,
        violation: context.rootCarrier.violation,
      },
      hint: "Root runs must execute inside an isolated immutable run environment without MULTIREMI_TASK_CONTEXT_FILE.",
    });
  }
  if (context.parked) throw new CliError("auth_required", TASK_CONTEXT_PARKED_MESSAGE);
  if (context.source === "root_immutable_env") return context.token ?? "";
  return context.source === "file" ? context.token ?? undefined : env.MULTIREMI_TOKEN?.trim();
}

/** The task's turn: the root immutable env, context file, or `MULTIREMI_TURN_ID`; null outside a task. */
export function taskTurnId(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  return resolveTaskContext(env).turnId;
}

/** Non-secret root carrier diagnostics for `remi context` / `remi root context` (never includes tokens). */
export function taskCarrierInfo(env: Readonly<Record<string, string | undefined>> = process.env): TaskContext["rootCarrier"] | null {
  const context = resolveTaskContext(env);
  return context.rootCarrier ?? null;
}
