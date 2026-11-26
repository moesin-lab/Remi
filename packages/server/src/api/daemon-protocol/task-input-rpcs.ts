import { PlannedRestartError } from "@multiremi/store/planned-restarts.js";
import type { PlannedRestartCheckpoint } from "@multiremi/contracts/planned-restart.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import type { DaemonProtocolLayer } from "./index.js";
import type { DaemonParsedFrame } from "./frames.js";
import type { DaemonProtocolSession } from "./session.js";
import { daemonAgentPluginDesiredResponse } from "../wire/agent-plugins.js";
import type { DaemonTurnBridge, DaemonTurnRpc } from "./turn-bridge.js";
import { fitRestartResumeToBudget } from "./offer-budget.js";
import { samePolicyOffer, type SystemPromptPolicyBinding } from '@multiremi/contracts/system-prompt-policy.js';
import { hashSystemPromptContent } from '@shared/system-prompt-policy-hash.js';

const denied = (code = "invalid_report") => ({ ok: false, code, retryable: false });

export function registerTaskInputRpcs(layer: DaemonProtocolLayer, store: MultiremiStore, kick: (runtimeId: string) => void,
  turns: DaemonTurnBridge = store.getDaemonTurnBridge(),
  prepareResume?: (task: NonNullable<ReturnType<MultiremiStore["getTaskWithAgent"]>>) => Promise<Record<string, unknown> | null>): void {
  const authorized = async (frame: DaemonParsedFrame, session: DaemonProtocolSession): Promise<boolean> => {
    if (!frame.rt || !session.runtimeIds.includes(frame.rt)) return false;
    const runtime = await layer.authorizeRuntimeForTest({ accessToken: session.ownerAccessToken,
      masterToken: session.ownerAccessToken === null }, session.daemonId, frame.rt);
    return runtime.ok;
  };
  for (const type of ["turn.input", "turn.decision", "turn.decision.get", "turn.decision.expire", "turn.decision.consume"] as const) {
    layer.registerRpcHandler(type, async (frame, session) => {
      if (!await authorized(frame, session)) return denied("authority_revoked");
      const p = frame.payload;
      if (typeof p.turn_id !== "string" || !p.turn_id || typeof p.attempt_id !== "string" || !p.attempt_id || "task_id" in p) return denied();
      if (type === "turn.input" && (!Number.isSafeInteger(p.input_to_seq) || (p.input_to_seq as number) < 0
        || !Array.isArray(p.message_ids) || p.message_ids.some(id => typeof id !== "string" || !id))) return denied();
      if (type === "turn.decision" && (typeof p.body_md !== "string" || typeof p.dedupe_key !== "string" || !p.dedupe_key
        || !Array.isArray(p.options) || p.options.some(option => !option || typeof option.label !== "string" || typeof option.value !== "string")
        || !p.metadata || typeof p.metadata !== "object" || Array.isArray(p.metadata)
        || (p.timeout_ms !== undefined && (typeof p.timeout_ms !== "number" || !Number.isFinite(p.timeout_ms) || p.timeout_ms < 0)))) return denied();
      if (type !== "turn.input" && type !== "turn.decision" && (typeof p.message_id !== "string" || !p.message_id)) return denied();
      if (type === "turn.decision.expire" && p.status !== "cancelled" && p.status !== "timeout") return denied();
      if (type === "turn.decision.consume" && (typeof p.reply_message_id !== "string" || !p.reply_message_id)) return denied();
      const result = await turns.rpc(type as DaemonTurnRpc, p, { runtimeId: frame.rt!, daemonId: session.daemonId,
        workspaceId: store.getRuntimeLite(frame.rt!)!.workspaceId ?? "local" });
      if (result.ok === true) kick(frame.rt!);
      return result;
    });
  }
  for (const type of ["turn.restart.checkpoint", "turn.restart.suspend"] as const) {
    layer.registerRpcHandler(type, async (frame, session) => {
      if (!await authorized(frame, session)) return denied("authority_revoked");
      const p = frame.payload;
      if (typeof p.attempt_id !== "string" || typeof p.turn_id !== "string") return denied();
      const task = store.getTaskIdentity(p.attempt_id);
      if (!task || task.runtimeId !== frame.rt || task.workspaceId !== (store.getRuntimeLite(frame.rt!)?.workspaceId ?? "local")) return denied("authority_revoked");
      const scope = { runtimeId: frame.rt!, daemonId: session.daemonId, workspaceId: task.workspaceId };
      try {
        const restarts = store.plannedRestarts();
        const handoff = restarts.get(p.attempt_id);
        if (!handoff || handoff.turn_id !== p.turn_id || handoff.handoff_id !== p.handoff_id
          || handoff.generation !== p.generation) return denied("stale_execution");
        if (type === "turn.restart.checkpoint") return { ok: true, checkpoint: restarts.checkpointReferences(p.attempt_id, scope) };
        if (!p.checkpoint || typeof p.checkpoint !== "object" || Array.isArray(p.checkpoint)) return denied();
        const committed = restarts.suspend(p.attempt_id, handoff.handoff_id, handoff.generation,
          p.checkpoint as unknown as PlannedRestartCheckpoint, scope);
        kick(frame.rt!);
        return { ok: true, handoff: committed };
      } catch (error) {
        if (error instanceof PlannedRestartError) return denied(error.code);
        throw error;
      }
    });
  }
  for (const method of ['turn.restart.resume','turn.restart.resume_bound']) layer.registerRpcHandler(method, async (frame, session) => {
    if (!await authorized(frame, session)) return denied("authority_revoked");
    const p = frame.payload;
    if (typeof p.attempt_id !== "string" || typeof p.handoff_id !== "string"
      || typeof p.consumer_id !== "string" || p.consumer_id.length < 16 || p.consumer_id.length > 256 || !prepareResume) return denied();
    const task = store.getTaskWithAgent(p.attempt_id);
    if (!task || task.runtimeId !== frame.rt) return denied("authority_revoked");
    const scope = { runtimeId: frame.rt!, daemonId: session.daemonId, workspaceId: task.workspaceId };
    const bound = method === 'turn.restart.resume_bound';
    if (bound && (!session.supportsPromptPolicy || !session.supportsPlannedRestart)) return denied('restart_policy_mismatch');
    try {
      if (store.plannedRestarts().reconcileTerminal(task.id, scope, p.handoff_id)) return denied("restart_terminal");
      const handoff = store.plannedRestarts().get(task.id);
      if (!handoff || handoff.handoff_id !== p.handoff_id || handoff.turn_id !== p.turn_id) return denied("stale_execution");
      if (handoff.state === "suspended" && store.getTaskUsageRunRuntime(task.id, p.consumer_id)) return denied("stale_execution");
      // Hydration/token creation can await, so prepare before the locked CAS.
      // The CAS rechecks attempt, daemon, drain and consumer authority afterwards.
      const offer = await prepareResume(task);
      if (!offer) return denied(store.plannedRestarts().reconcileTerminal(task.id, scope, p.handoff_id)
        ? "restart_terminal" : "stale_execution");
      let reply: Record<string, any> | null = null;
      const delivery = (generation: number, checkpoint: PlannedRestartCheckpoint) => {
        const questions = (checkpoint.question_ids ?? []).map(id => store.getMessage(id)).filter(Boolean);
        reply = fitRestartResumeToBudget({ ...offer, ...turns.offerInput(task) }, questions, generation, frame.rt!);
        if (!reply) throw new PlannedRestartError("capacity");
        if (bound) {
          const proof = checkpoint.policy_receipt;
          const fitted = reply.task;
          const policy = fitted?.system_prompt_policy as SystemPromptPolicyBinding | undefined;
          if (!proof || fitted.attempt_id !== proof.attempt_id || fitted.turn_id !== proof.turn_id || !policy || policy.workspaceId !== proof.workspace_id
            || policy.contentHash !== proof.content_hash || hashSystemPromptContent(policy.content) !== proof.content_hash) throw new PlannedRestartError('restart_policy_mismatch');
        }
      };
      const consumerId = p.consumer_id;
      const receipt = store.plannedRestarts().resume(task.id, p.handoff_id, consumerId, scope, (generation, checkpoint, phase) => {
        // Check the complete, current package under the CAS locks. A capacity
        // failure rolls back Q preparation and generation before any run grant.
        delivery(generation, checkpoint);
        if (phase === 'activate') {
          store.reportTaskUsageSnapshot(task.id, { version: 2, runId: consumerId,
            revision: 0, complete: false, units: [] }, scope);
        }
        if (!store.isTaskUsageExecutionAuthorized(task.id, consumerId, scope.runtimeId)) throw new PlannedRestartError('stale_execution');
      }, bound ? current => {
        const proof = current.checkpoint?.policy_receipt;
        const policy = offer.system_prompt_policy as SystemPromptPolicyBinding | undefined;
        if (!proof || !samePolicyOffer(proof,p) || proof.handoff_id !== current.handoff_id || proof.turn_id !== current.turn_id
          || proof.prior_restart_generation !== p.generation || proof.attempt_id !== task.id || proof.workspace_id !== scope.workspaceId
          || proof.runtime_id !== scope.runtimeId || proof.daemon_id !== scope.daemonId || !policy || policy.workspaceId !== proof.workspace_id
          || policy.contentHash !== proof.content_hash || hashSystemPromptContent(policy.content) !== proof.content_hash
          || store.systemPromptsRepo().offerStatus(proof) !== 'adopted') throw new PlannedRestartError('restart_policy_mismatch');
      } : undefined);
      return bound ? { ...(reply as Record<string,unknown> | null), policy_receipt:receipt.checkpoint!.policy_receipt } : reply;
    } catch (error) {
      // Completion can win while asynchronous offer preparation is in flight.
      if (store.plannedRestarts().reconcileTerminal(task.id, scope, p.handoff_id)) return denied("restart_terminal");
      if (error instanceof PlannedRestartError && error.code === "capacity") {
        try {
          store.plannedRestarts().rejectUndeliverableResume(task.id, p.handoff_id, p.consumer_id, scope);
        } catch (rejection) {
          if (rejection instanceof PlannedRestartError) return denied(rejection.code);
          throw rejection;
        }
      }
      if (error instanceof PlannedRestartError) return denied(error.code);
      throw error;
    }
  });
  layer.registerRpcHandler("plugin.desired", async (frame, session) => {
    if (!await authorized(frame, session)) return denied("authority_revoked");
    return { ok: true, ...daemonAgentPluginDesiredResponse(store.getRuntimeAgentPluginDesiredSnapshot(frame.rt!)) };
  });
}
