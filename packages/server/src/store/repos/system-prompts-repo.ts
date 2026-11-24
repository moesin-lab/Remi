import { createHash, randomUUID } from "node:crypto";
import { createId, nowIso } from "@multiremi/ids.js";
import type { StoreContext } from "../context.js";
import { runTurnExecutionMutation } from "../turn-execution-records.js";
import { LEGACY_PROMPT_POLICY_WAIT_REASON, PROMPT_POLICY_WAIT_REASON } from "../task-wait-reason.js";
import {
  MAX_SYSTEM_PROMPT_CODE_POINTS, normalizeSystemPromptContent, serializeSystemPromptContent, samePolicyOffer, type PolicyOfferIdentity,
  type SystemPromptActor, type SystemPromptContent, type SystemPromptDefault, type SystemPromptEditInput,
  type SystemPromptMode, type SystemPromptOperation, type SystemPromptPolicyBinding, type SystemPromptRestoreInput,
  type SystemPromptState, type SystemPromptVersion, type SystemPromptVersionList, type SystemPromptVersionSummary,
  type SystemPromptWriteInput, type SystemPromptWriteResult,
} from "@multiremi/contracts/system-prompt-policy.js";
import { CURRENT_SYSTEM_PROMPT_DEFAULT, hashSystemPromptContent, requiresPromptPolicyCapability } from "@shared/system-prompt-policy-hash.js";

type DocumentRow = { id: string; workspace_id: string; current_version_id: string | null; revision: number };
type DispatchPolicy = { protocol: 'adopt' | 'legacy'; state: 'proposed' | 'adopted' | 'revoked'; runtimeId: string; daemonId: string; receiptId?: string };
type VersionRow = {
  id: string; document_id: string; workspace_id: string; version_number: number;
  mode: SystemPromptMode; operation: SystemPromptOperation; content_snapshot_json: string; content_hash: string;
  base_default_revision: string; base_default_snapshot_json: string; restored_from_version_id: string | null;
  parent_version_id: string | null; actor_json: string; created_at: string; change_note: string | null;
  request_id: string | null; request_hash: string | null;
};
const SUMMARY_COLUMNS = "id,document_id,workspace_id,version_number,mode,operation,content_hash,base_default_revision,restored_from_version_id,parent_version_id,actor_json,created_at,change_note,request_id";
const SYSTEM_ACTOR: SystemPromptActor = { type: "system", operatorId: null, userId: null, displayName: "System" };

export class SystemPromptError extends Error {
  constructor(message: string, readonly code: "invalid_system_prompt" | "system_prompt_version_not_found" | "system_prompt_conflict" | "system_prompt_request_conflict", readonly currentRevision?: number) {
    super(message);
  }
}
function invalid(message: string): never { throw new SystemPromptError(message, "invalid_system_prompt"); }
function snapshot(json: string): SystemPromptContent {
  const parsed = JSON.parse(json);
  if (parsed.format !== 1) throw new Error("Unsupported System Prompt snapshot format");
  return normalizeSystemPromptContent(parsed.content);
}
function normalizeContent(value: unknown): SystemPromptContent {
  try { return normalizeSystemPromptContent(value); }
  catch (error) { return invalid(error instanceof Error ? error.message : String(error)); }
}

export class SystemPromptsRepo {
  constructor(private readonly ctx: StoreContext, private readonly catalog: () => Readonly<SystemPromptDefault> = () => CURRENT_SYSTEM_PROMPT_DEFAULT) {}

  private document(workspaceId: string): DocumentRow | null {
    return this.ctx.db.query("SELECT id,workspace_id,current_version_id,revision FROM multiremi_system_prompt_documents WHERE workspace_id=? AND key='system-policy'")
      .get(workspaceId) as DocumentRow | null;
  }

  getSystemPrompt(workspaceId: string): SystemPromptState {
    const document = this.document(workspaceId);
    const version = document?.current_version_id ? this.getSystemPromptVersion(workspaceId, document.current_version_id) : null;
    if (document && (!version || version.versionNumber !== Number(document.revision))) throw new Error("System Prompt head is inconsistent");
    const currentDefault = this.catalog();
    const mode = version?.mode ?? "default";
    const baseContent = version?.baseDefaultSnapshot ?? currentDefault.content;
    const baseDefault = { revision: version?.baseDefaultRevision ?? currentDefault.revision,
      contentHash: hashSystemPromptContent(baseContent), content: baseContent };
    return {
      document: { id: document?.id ?? null, key: "system-policy", workspaceId,
        revision: Number(document?.revision ?? 0), currentVersionId: document?.current_version_id ?? null, mode },
      content: mode === "default" ? currentDefault.content : version!.content,
      currentDefault, baseDefault, defaultUpdated: baseDefault.revision !== currentDefault.revision,
      limits: { maxCodePoints: MAX_SYSTEM_PROMPT_CODE_POINTS },
    };
  }

  private summary(row: VersionRow, currentVersionId: string | null): SystemPromptVersionSummary {
    return { id: row.id, documentId: row.document_id, workspaceId: row.workspace_id, versionNumber: Number(row.version_number),
      mode: row.mode, operation: row.operation, contentHash: row.content_hash, baseDefaultRevision: row.base_default_revision,
      restoredFromVersionId: row.restored_from_version_id, parentVersionId: row.parent_version_id,
      actor: JSON.parse(row.actor_json), createdAt: row.created_at, changeNote: row.change_note, requestId: row.request_id,
      isCurrent: row.id === currentVersionId };
  }

  getSystemPromptVersion(workspaceId: string, versionId: string): SystemPromptVersion | null {
    const row = this.ctx.db.query(`SELECT v.* FROM multiremi_system_prompt_versions v
      JOIN multiremi_system_prompt_documents d ON d.id=v.document_id AND d.workspace_id=v.workspace_id
      WHERE v.workspace_id=? AND v.id=? AND d.key='system-policy'`).get(workspaceId, versionId) as VersionRow | null;
    return row ? { ...this.summary(row, this.document(workspaceId)?.current_version_id ?? null),
      content: snapshot(row.content_snapshot_json), baseDefaultSnapshot: snapshot(row.base_default_snapshot_json) } : null;
  }

  listSystemPromptVersions(workspaceId: string, options: { cursor?: string; limit?: number } = {}): SystemPromptVersionList {
    const limit = options.limit ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid("limit must be an integer from 1 to 100");
    let cursor: { version: number; id: string } | null = null;
    if (options.cursor !== undefined) {
      try {
        cursor = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8"));
        if (!cursor || !Number.isSafeInteger(cursor.version) || cursor.version < 1 || typeof cursor.id !== "string" || !cursor.id) throw new Error();
      } catch { invalid("Invalid System Prompt version cursor"); }
    }
    const document = this.document(workspaceId);
    if (!document) return { versions: [], nextCursor: null };
    const rows = this.ctx.db.query(`SELECT ${SUMMARY_COLUMNS} FROM multiremi_system_prompt_versions
      WHERE workspace_id=? AND document_id=?${cursor ? " AND (version_number < ? OR (version_number = ? AND id < ?))" : ""}
      ORDER BY version_number DESC,id DESC LIMIT ?`).all(workspaceId, document.id,
        ...(cursor ? [cursor.version, cursor.version, cursor.id] : []), limit + 1) as VersionRow[];
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return { versions: page.map(row => this.summary(row, document.current_version_id)),
      nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ version: Number(last.version_number), id: last.id })).toString("base64url") : null };
  }

  editSystemPrompt(workspaceId: string, input: SystemPromptEditInput, actor: SystemPromptActor): SystemPromptWriteResult {
    return this.write(workspaceId, "edit", input, actor);
  }
  resetSystemPrompt(workspaceId: string, input: SystemPromptWriteInput, actor: SystemPromptActor): SystemPromptWriteResult {
    return this.write(workspaceId, "reset", input, actor);
  }
  restoreSystemPrompt(workspaceId: string, input: SystemPromptRestoreInput, actor: SystemPromptActor): SystemPromptWriteResult {
    return this.write(workspaceId, "rollback", input, actor);
  }

  private write(workspaceId: string, operation: "edit" | "reset" | "rollback", input: SystemPromptWriteInput, actor: SystemPromptActor): SystemPromptWriteResult {
    if (!input || typeof input !== "object" || Array.isArray(input)) invalid("A request object is required");
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) invalid("expectedRevision must be a non-negative integer");
    if (typeof input.requestId !== "string" || !input.requestId.trim() || input.requestId.length > 200 || /[\x00-\x1f\x7f]/.test(input.requestId)) invalid("requestId must be a non-empty identifier of at most 200 characters");
    if (input.changeNote !== undefined && (typeof input.changeNote !== "string" || Array.from(input.changeNote).length > 1000 || input.changeNote.includes("\0"))) invalid("changeNote must be text of at most 1000 characters");
    const changeNote = input.changeNote?.replace(/\r\n?/g, "\n") ?? null;
    const edited = operation === "edit" ? normalizeContent((input as SystemPromptEditInput).content) : null;
    const requestedBase = operation === "edit" ? (input as SystemPromptEditInput).baseDefaultRevision : undefined;
    if (requestedBase !== undefined && (typeof requestedBase !== "string" || !requestedBase || requestedBase.length > 200)) invalid("Invalid baseDefaultRevision");
    const sourceId = operation === "rollback" ? (input as SystemPromptRestoreInput).versionId : null;
    if (operation === "rollback" && (typeof sourceId !== "string" || !sourceId)) invalid("versionId is required");
    const requestHash = createHash("sha256").update(JSON.stringify({ operation, expectedRevision: input.expectedRevision,
      content: edited, baseDefaultRevision: requestedBase ?? null, versionId: sourceId, changeNote })).digest("hex");
    return this.ctx.db.transaction(() => {
      this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
      if (!this.ctx.workspaces().getWorkspace(workspaceId)) invalid("Workspace not found");
      let document = this.document(workspaceId);
      // Replay precedes the CAS and default/restore resolution: a response lost after commit is safe to retry.
      if (document) {
        const replay = this.ctx.db.query("SELECT id,request_hash FROM multiremi_system_prompt_versions WHERE workspace_id=? AND document_id=? AND request_id=?")
          .get(workspaceId, document.id, input.requestId) as { id: string; request_hash: string } | null;
        if (replay) {
          if (replay.request_hash !== requestHash) throw new SystemPromptError("requestId was already used for another System Prompt request", "system_prompt_request_conflict", Number(document.revision));
          return { ...this.getSystemPrompt(workspaceId), version: this.getSystemPromptVersion(workspaceId, replay.id)!, replayed: true };
        }
      }
      const revision = Number(document?.revision ?? 0);
      if (input.expectedRevision !== revision) throw new SystemPromptError("System Prompt changed; reload before saving", "system_prompt_conflict", revision);
      const currentDefault = this.catalog();
      let baseDefault = currentDefault;
      if (requestedBase && requestedBase !== currentDefault.revision) {
        const known = document ? this.ctx.db.query(`SELECT base_default_snapshot_json FROM multiremi_system_prompt_versions
          WHERE workspace_id=? AND document_id=? AND base_default_revision=? ORDER BY version_number DESC LIMIT 1`)
          .get(workspaceId, document.id, requestedBase) as { base_default_snapshot_json: string } | null : null;
        if (!known) invalid("baseDefaultRevision is not a known default for this workspace");
        const content = snapshot(known.base_default_snapshot_json);
        baseDefault = { revision: requestedBase, contentHash: hashSystemPromptContent(content), content };
      }
      const restored = sourceId ? this.getSystemPromptVersion(workspaceId, sourceId) : null;
      if (sourceId && !restored) throw new SystemPromptError("System Prompt version not found", "system_prompt_version_not_found");
      if (restored) baseDefault = { revision: restored.baseDefaultRevision, content: restored.baseDefaultSnapshot,
        contentHash: hashSystemPromptContent(restored.baseDefaultSnapshot) };
      if (!document) {
        const id = createId("spd");
        const time = nowIso();
        this.ctx.db.run(`INSERT INTO multiremi_system_prompt_documents (id,workspace_id,key,current_version_id,revision,created_at,updated_at)
          VALUES (?,?,'system-policy',NULL,0,?,?)`, [id, workspaceId, time, time]);
        document = { id, workspace_id: workspaceId, current_version_id: null, revision: 0 };
        if (operation === "edit") {
          const initial = this.append(document, "initialize", "default", currentDefault.content, currentDefault, SYSTEM_ACTOR, null, null, null, null);
          document = { ...document, revision: initial.versionNumber, current_version_id: initial.id };
        }
      }
      const version = this.append(document, operation, operation === "reset" ? "default" : "custom",
        edited ?? restored?.content ?? currentDefault.content, baseDefault, actor, changeNote, input.requestId, requestHash, restored?.id ?? null);
      if (!requiresPromptPolicyCapability(version.mode, currentDefault.revision)) {
        runTurnExecutionMutation(this.ctx.db, `UPDATE multiremi_turn_execution_records SET wait_reason = NULL, updated_at = ?
          WHERE workspace_id = ? AND status IN ('queued', 'dispatched') AND wait_reason IN (?,?)`,
        [nowIso(), workspaceId, PROMPT_POLICY_WAIT_REASON, LEGACY_PROMPT_POLICY_WAIT_REASON]);
      }
      this.ctx.emitWorkspaceEvent({ type: "workspace:updated", workspaceId, actorType: actor.type === "human" ? "member" : "system",
        actorId: actor.operatorId, payload: { id: workspaceId } });
      this.ctx.emitWorkspaceEvent({ type: "daemon:dispatch_conditions_changed", workspaceId, actorType: "system", actorId: null,
        payload: { reason: "system_prompt_changed" } });
      return { ...this.getSystemPrompt(workspaceId), version, replayed: false };
    })();
  }

  private append(document: DocumentRow, operation: SystemPromptOperation, mode: SystemPromptMode, content: SystemPromptContent,
    baseDefault: Readonly<SystemPromptDefault>, actor: SystemPromptActor, changeNote: string | null, requestId: string | null,
    requestHash: string | null, restoredFromVersionId: string | null): SystemPromptVersion {
    const id = createId("spv");
    const time = nowIso();
    const versionNumber = Number(document.revision) + 1;
    this.ctx.db.run(`INSERT INTO multiremi_system_prompt_versions
      (id,document_id,workspace_id,version_number,mode,operation,content_snapshot_json,content_hash,base_default_revision,
       base_default_snapshot_json,restored_from_version_id,parent_version_id,actor_json,created_at,change_note,request_id,request_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, document.id, document.workspace_id, versionNumber, mode, operation,
      serializeSystemPromptContent(content), hashSystemPromptContent(content), baseDefault.revision, serializeSystemPromptContent(baseDefault.content),
      restoredFromVersionId, document.current_version_id, JSON.stringify(actor), time, changeNote, requestId, requestHash]);
    const updated = this.ctx.db.run(`UPDATE multiremi_system_prompt_documents SET current_version_id=?,revision=?,updated_at=?
      WHERE id=? AND workspace_id=? AND revision=?`, [id, versionNumber, time, document.id, document.workspace_id, Number(document.revision)]);
    if (updated.changes !== 1) throw new SystemPromptError("System Prompt changed; reload before saving", "system_prompt_conflict", Number(document.revision));
    return this.getSystemPromptVersion(document.workspace_id, id)!;
  }

  private storedAttempt(taskId: string): (SystemPromptPolicyBinding & { offerGeneration?: string; confirmed?: boolean; dispatch?: DispatchPolicy }) | null {
    const row = this.ctx.db.query("SELECT binding_json FROM multiremi_attempt_system_prompts WHERE task_id=?").get(taskId) as { binding_json: string } | null;
    return row ? JSON.parse(row.binding_json) : null;
  }

  getAttemptSystemPrompt(taskId: string): SystemPromptPolicyBinding | null {
    const stored = this.storedAttempt(taskId);
    if (!stored) return null;
    const { offerGeneration, confirmed, dispatch, ...binding } = stored;
    return binding;
  }

  matchesOffer(taskId: string, generation: string | undefined): boolean {
    const stored = this.storedAttempt(taskId);
    return (generation === undefined && stored?.dispatch?.protocol !== 'adopt') || stored?.offerGeneration === generation;
  }

  dispatchPolicy(taskId: string) { return this.storedAttempt(taskId)?.dispatch; }

  acceptsReport(taskId: string, scope: {workspaceId:string;runtimeId:string;daemonId:string}, payload: Record<string,unknown>): boolean {
    const dispatch = this.dispatchPolicy(taskId);
    if (dispatch?.protocol !== 'adopt') return payload.receipt_id === undefined && payload.offer_generation === undefined && payload.content_hash === undefined;
    if (dispatch.state !== 'adopted' || typeof payload.receipt_id !== 'string' || typeof payload.offer_generation !== 'string' || typeof payload.content_hash !== 'string') return false;
    const status = this.offerStatus({attempt_id:taskId,workspace_id:scope.workspaceId,runtime_id:scope.runtimeId,daemon_id:scope.daemonId,
      offer_generation:payload.offer_generation,content_hash:payload.content_hash,receipt_id:payload.receipt_id});
    return status === 'adopted' || status === 'terminal';
  }

  withReportPolicy<T>(workspace: string, action: () => T): T {
    return this.ctx.db.transaction(() => { this.ctx.lockWorkspaceRuntimeLifecycle(workspace); return action(); })();
  }

  revokeOffer(taskId: string, generation?: string): boolean {
    const stored = this.storedAttempt(taskId);
    if (!stored?.dispatch) return this.matchesOffer(taskId, generation);
    if (stored.dispatch.state !== 'proposed' || !this.matchesOffer(taskId, generation)) return false;
    stored.dispatch.state = 'revoked';
    this.ctx.db.run('UPDATE multiremi_attempt_system_prompts SET binding_json=? WHERE task_id=?', [JSON.stringify(stored), taskId]);
    return true;
  }

  offerStatus(identity: PolicyOfferIdentity) {
    const stored = this.storedAttempt(identity.attempt_id);
    const task = this.ctx.tasks().getTask(identity.attempt_id);
    const dispatch = stored?.dispatch;
    if (!task || !stored || dispatch?.protocol !== 'adopt' || task.workspaceId !== identity.workspace_id
      || task.runtimeId !== identity.runtime_id || dispatch.runtimeId !== identity.runtime_id || dispatch.daemonId !== identity.daemon_id
      || this.ctx.runtimes().getRuntimeLite(identity.runtime_id)?.daemonId !== identity.daemon_id) return 'unknown';
    if (!samePolicyOffer(identity, { ...identity, offer_generation: stored.offerGeneration, content_hash: hashSystemPromptContent(stored.content),
      receipt_id: dispatch.receiptId ?? identity.receipt_id }) || stored.contentHash !== identity.content_hash) return 'revoked_or_superseded';
    if (!['queued','dispatched','running','awaiting_human','waiting_local_directory'].includes(task.status)) return 'terminal';
    return dispatch.state === 'revoked' ? 'revoked_or_superseded' : dispatch.state;
  }

  adoptOffer(identity: PolicyOfferIdentity): boolean {
    return this.ctx.db.transaction(() => {
      this.ctx.lockWorkspaceRuntimeLifecycle(identity.workspace_id);
      const state = this.offerStatus(identity);
      if (state === 'adopted') return true;
      if (state !== 'proposed') return false;
      const row = runTurnExecutionMutation(this.ctx.db, `UPDATE multiremi_turn_execution_records SET accepted_at=?
        WHERE id=? AND runtime_id=? AND status='dispatched' AND offered_at IS NOT NULL`, [nowIso(), identity.attempt_id, identity.runtime_id]);
      if (row.changes !== 1) return false;
      const stored = this.storedAttempt(identity.attempt_id)!;
      this.ctx.db.run('UPDATE multiremi_attempt_system_prompts SET binding_json=? WHERE task_id=?', [JSON.stringify({ ...stored, confirmed: true,
        dispatch: { ...stored.dispatch, state: 'adopted', receiptId: identity.receipt_id } }), identity.attempt_id]);
      return true;
    })();
  }

  canResendToLegacy(taskId: string): boolean {
    const previous = this.storedAttempt(taskId);
    return !previous || previous.legacyCompatible || (previous.offerGeneration !== undefined && !previous.confirmed);
  }

  confirmOffer(taskId: string): void {
    const stored = this.storedAttempt(taskId);
    if (stored && !stored.confirmed) this.ctx.db.run("UPDATE multiremi_attempt_system_prompts SET binding_json=? WHERE task_id=?",
      [JSON.stringify({ ...stored, confirmed: true, dispatch: stored.dispatch ? { ...stored.dispatch, state:'adopted' } : undefined }), taskId]);
  }

  validateAttemptSystemPrompt(taskId: string, reported: unknown): void {
    const bound = this.getAttemptSystemPrompt(taskId);
    if (reported == null && (!bound || bound.legacyCompatible)) return;
    if (!bound || !reported || typeof reported !== "object" || Array.isArray(reported)) throw new Error("System Prompt binding mismatch");
    const candidate = reported as Record<string, unknown>;
    for (const key of ["format", "workspaceId", "documentId", "versionId", "versionNumber", "mode", "defaultRevision", "contentHash", "legacyCompatible"] as const) {
      if (candidate[key] !== bound[key]) throw new Error("System Prompt binding mismatch");
    }
    if (serializeSystemPromptContent(normalizeSystemPromptContent(candidate.content)) !== serializeSystemPromptContent(bound.content)) throw new Error("System Prompt binding content mismatch");
  }

  /** Caller owns the claim transaction and already holds W; no post-accept mutation is permitted. */
  bindAttemptSystemPrompt(taskId: string, workspaceId: string, options: { legacyCompatible: boolean; offerGeneration?: string; protocol?: 'adopt' | 'legacy' }): SystemPromptPolicyBinding {
    if (!this.ctx.db.inTransaction) throw new Error("System Prompt binding requires the claim transaction");
    const task = this.ctx.tasks().getTask(taskId);
    if (!task || task.workspaceId !== workspaceId) throw new Error("System Prompt binding task/workspace mismatch");
    const previous = this.storedAttempt(taskId);
    if (previous?.dispatch && previous.dispatch.state !== 'revoked') throw new Error('Policy offer is still owned by its original dispatch');
    const generation = options.offerGeneration ?? randomUUID();
    if (previous?.confirmed || (previous && !previous.offerGeneration && task.acceptedAt && task.offeredAt) || !["queued", "dispatched"].includes(task.status)) {
      if (previous) {
        this.ctx.db.run("UPDATE multiremi_attempt_system_prompts SET binding_json=? WHERE task_id=?",
          [JSON.stringify({ ...previous, offerGeneration: generation, confirmed: true }), taskId]);
        return this.getAttemptSystemPrompt(taskId)!;
      }
      throw new Error("Accepted attempt System Prompt binding is immutable");
    }
    const state = this.getSystemPrompt(workspaceId);
    if (options.legacyCompatible && requiresPromptPolicyCapability(state.document.mode, state.currentDefault.revision)) {
      throw new Error(PROMPT_POLICY_WAIT_REASON);
    }
    const binding: SystemPromptPolicyBinding = { format: 1, workspaceId, documentId: state.document.id,
      versionId: state.document.currentVersionId, versionNumber: state.document.revision, mode: state.document.mode,
      defaultRevision: state.currentDefault.revision, content: state.content, contentHash: hashSystemPromptContent(state.content),
      legacyCompatible: options.legacyCompatible };
    const dispatch = options.protocol && task.runtimeId ? { protocol: options.protocol, state: 'proposed', runtimeId: task.runtimeId,
      daemonId: this.ctx.runtimes().getRuntimeLite(task.runtimeId)?.daemonId } : undefined;
    this.ctx.db.run(`INSERT INTO multiremi_attempt_system_prompts (task_id,workspace_id,document_id,version_id,binding_json,created_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET workspace_id=excluded.workspace_id,document_id=excluded.document_id,
      version_id=excluded.version_id,binding_json=excluded.binding_json,created_at=excluded.created_at`,
      [taskId, workspaceId, binding.documentId, binding.versionId, JSON.stringify({ ...binding, offerGeneration: generation, confirmed: false, dispatch }), nowIso()]);
    return binding;
  }
}
