import { normalizeDaemonClaimTask } from "./client.js";
import type { DaemonProtocolClient } from "./daemon-protocol-client.js";
import type { DaemonParsedFrame } from "../api/daemon-protocol/frames.js";
import type { DaemonTurnInput } from "@multiremi/contracts/daemon-protocol.js";
import { samePolicyOffer, type PolicyOfferIdentity } from '@multiremi/contracts/system-prompt-policy.js';
import { hashSystemPromptContent, LEGACY_BASELINE_DEFAULT_REVISION } from '@shared/system-prompt-policy-hash.js';
import type { MultiremiTaskReportOutbox } from './outbox.js';

export type DaemonTurnTask = NonNullable<ReturnType<typeof normalizeDaemonClaimTask>> & DaemonTurnInput;

/** No prompt/id fallback: old offers cannot enter the execution loop. */
export function normalizeDaemonTurnOffer(payload: Record<string, unknown>): DaemonTurnTask {
  const seq = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
  if ("prompt" in payload || typeof payload.turn_id !== "string" || !payload.turn_id
    || typeof payload.attempt_id !== "string" || !payload.attempt_id
    || !seq(payload.input_from_seq) || !seq(payload.input_to_seq)
    || payload.input_from_seq > payload.input_to_seq || !Array.isArray(payload.input_messages)) {
    throw new Error("invalid turn offer payload");
  }
  let previous = payload.input_from_seq;
  for (const input of payload.input_messages) {
    if (!input || typeof input !== "object" || input.kind !== "message" || typeof input.id !== "string"
      || typeof input.body_md !== "string" || !seq(input.seq)
      || input.seq <= previous || input.seq > payload.input_to_seq) throw new Error("invalid turn offer input range");
    previous = input.seq;
  }
  const task = normalizeDaemonClaimTask({ ...payload, id: payload.attempt_id,
    prompt: payload.input_messages.map(message => message.body_md).join("\n\n") });
  if (!task) throw new Error("invalid turn offer payload");
  return task as DaemonTurnTask;
}

export type OfferRejection = "disk_critical" | "capacity" | "claims_paused" | "draining" | "binary_skill_files_unsupported";

export function registerDaemonOfferHandler(client: DaemonProtocolClient, options: {
  runtimeId(): string | null;
  adoption?: { workspace(): string; daemon(): string; lane(): string; outbox(): MultiremiTaskReportOutbox; held(attemptId:string): boolean };
  /** Why this offer is refused, or null; it sees the task (PR 6 §2.5: a parked lane's offer skips `capacity`). */
  rejection(task: DaemonTurnTask, preparing: number): OfferRejection | null;
  run(task: DaemonTurnTask): void;
}): void {
  const pending = new Map<string,number>();
  let connection = 0;
  client.onWelcome(() => { connection++; pending.clear(); });
  client.registerFrameHandler("task.offer", async (frame: DaemonParsedFrame) => {
    if (!frame.rt || frame.rt !== options.runtimeId() || frame.seq === null) return;
    let task: DaemonTurnTask;
    try { task = normalizeDaemonTurnOffer(frame.payload); }
    catch {
      client.send({ t: "res", re: String(frame.seq), p: { ok: false, code: "report_shape_retired", retryable: false } });
      return;
    }
    // A replay of an accepted entity stays accepted even after local capacity filled.
    const key = "task.offer";
    const adoption = options.adoption;
    const policy = task.systemPromptPolicy;
    const respond = (ok: boolean, code?: string) => client.send({t:'res',re:String(frame.seq),p:{ok,code}});
    if (adoption?.held(task.id)) { respond(false, 'restart_policy_unverifiable'); return; }
    if (adoption && client.sharesCap('prompt.policy.adopt.v1')) {
      if (pending.has(task.id)) return;
      const generation = frame.payload.offer_generation;
      if (typeof generation !== 'string' || !generation || !policy || policy.workspaceId !== adoption.workspace()
        || task.workspaceId !== policy.workspaceId || hashSystemPromptContent(policy.content) !== policy.contentHash) {
        respond(false,'policy_offer_mismatch'); return;
      }
      const scope = {workspace_id:policy.workspaceId,daemon_id:adoption.daemon(),runtime_id:frame.rt,attempt_id:task.id};
      const desired = {...scope,offer_generation:generation,content_hash:policy.contentHash};
      const outbox = adoption.outbox();
      if (!outbox.canProveNewAttempt(task.createdAt)) { respond(false,'restart_policy_unverifiable'); return; }
      const owner = connection;
      pending.set(task.id,owner);
      try {
        let local = outbox.policyReceipt(scope);
        if (local && !samePolicyOffer(local, {...desired,receipt_id:local.receipt_id})) {
          if (local.state !== 'prepared') { respond(false,'policy_offer_mismatch'); return; }
          const status = await client.rpc('task.offer_status',local,frame.rt);
          if (status.state !== 'revoked_or_superseded' || !samePolicyOffer(local,status) || !outbox.transitionPolicyReceipt(local,'forget_revoked')) {
            respond(false,'policy_offer_mismatch'); return;
          }
          local = null;
        }
        if (connection !== owner) return;
        const reason = options.rejection(task,pending.size - 1);
        if (reason && local?.state !== 'launch_claimed') { respond(false,reason); return; }
        const receipt: PolicyOfferIdentity = local ?? outbox.preparePolicyReceipt(desired);
        if (!samePolicyOffer(receipt,{...desired,receipt_id:receipt.receipt_id})) { respond(false,'policy_offer_mismatch'); return; }
        const accepted = await client.rpc('task.offer_adopt',receipt,frame.rt);
        if (connection !== owner || accepted.state !== 'adopted' || !samePolicyOffer(receipt,accepted) || !client.sharesCap('prompt.policy.adopt.v1') || adoption.held(task.id)) return;
        if (accepted.grant !== 'first' && (accepted.grant !== 'replay' || !local)) { respond(false,'policy_offer_mismatch'); return; }
        if (outbox.transitionPolicyReceipt(receipt,'launch')) {
          outbox.recordNewAttempt(receipt,task.createdAt,adoption.lane());
          options.run(task);
        }
        respond(true);
      } finally { if (pending.get(task.id) === owner) pending.delete(task.id); }
      return;
    }
    if (adoption && adoption.outbox().uncertainHandoffs().length) { respond(false,'restart_policy_unverifiable'); return; }
    if (adoption && (frame.payload.offer_generation || (policy && (policy.mode !== 'default'
      || policy.defaultRevision !== LEGACY_BASELINE_DEFAULT_REVISION || hashSystemPromptContent(policy.content) !== LEGACY_BASELINE_DEFAULT_REVISION)))) {
      respond(false,'policy_offer_mismatch'); return;
    }
    if (!client.dedupe.claim(key, task.id)) {
      client.send({ t: "res", re: String(frame.seq), p: { ok: true } });
      return;
    }
    const code = options.rejection(task,pending.size);
    if (code) {
      client.dedupe.release(key, task.id);
      client.send({ t: "res", re: String(frame.seq), p: { ok: false, code } });
      return;
    }
    try {
      client.send({ t: "res", re: String(frame.seq), p: { ok: true } });
      options.run(task);
    } catch (error) {
      client.dedupe.release(key, task.id);
      throw error;
    }
  });
}
