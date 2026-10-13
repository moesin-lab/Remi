import { runtimeConnectionSnapshot, type RuntimeExecutionBinding, type RuntimeExecutionBindingAck, type RuntimeBindingModelCatalog } from "@multiremi/contracts/runtime-connection.js";
import type { StoreContext } from "@multiremi/store/context.js";
import { createId, nowIso } from "@multiremi/ids.js";

export class ExecutionBindingStatesRepo {
  constructor(private readonly ctx: StoreContext) {}

  getRuntimeExecutionBindings(runtimeId: string): RuntimeExecutionBinding[] {
    return this.ctx.db.transaction(() => {
      const runtime = this.ctx.db.query("SELECT workspace_id FROM multiremi_runtimes WHERE id = ?").get(runtimeId) as { workspace_id: string | null } | null;
      if (!runtime) return [];
      const workspaceId = runtime.workspace_id ?? "local";
      this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
      const rows = this.ctx.db.query(`SELECT g.id, g.provider, g.profile_id, p.revision, v.profile
        FROM multiremi_execution_group_members m
        JOIN multiremi_runtimes r ON r.id = m.runtime_id AND COALESCE(r.workspace_id, 'local') = m.workspace_id
        JOIN multiremi_execution_groups g ON g.workspace_id = m.workspace_id AND g.id = m.group_id
        LEFT JOIN multiremi_execution_profiles p ON p.workspace_id = g.workspace_id AND p.id = g.profile_id AND p.deleted_at IS NULL
        LEFT JOIN multiremi_execution_profile_versions v ON v.workspace_id = p.workspace_id AND v.id = p.id AND v.revision = p.revision
        WHERE m.runtime_id = ? AND g.managed = 1 ORDER BY g.id`).all(runtimeId) as Array<{
          id: string; provider: string; profile_id: string | null; revision: number | null; profile: string | null;
        }>;
      return rows.map(row => {
        // Membership changes and Runtime registration delete this generation.
        // A delayed acknowledgement can therefore never revive a removed binding.
        this.ctx.db.run(`INSERT INTO multiremi_execution_binding_generations
          (workspace_id, group_id, runtime_id, generation) VALUES (?, ?, ?, ?)
          ON CONFLICT(workspace_id, group_id, runtime_id) DO NOTHING`, [workspaceId, row.id, runtimeId, createId("ebg")]);
        const generation = this.ctx.db.query(`SELECT generation FROM multiremi_execution_binding_generations
          WHERE workspace_id = ? AND group_id = ? AND runtime_id = ?`).get(workspaceId, row.id, runtimeId) as { generation: string };
        return {
          generation: generation.generation,
          groupId: row.id,
          provider: row.provider,
          profileId: row.profile_id,
          profileRevision: row.revision,
          // The allowlist is a control-plane catalog contract. Older daemons
          // understand the selected/default model but reject unknown fields.
          profile: row.profile ? runtimeConnectionSnapshot(JSON.parse(row.profile)) : null,
        };
      });
    })();
  }

  recordRuntimeExecutionBindingAcks(runtimeId: string, input: unknown): void {
    if (!Array.isArray(input) || input.length > 200) return;
    this.ctx.db.transaction(() => {
      const runtime = this.ctx.db.query("SELECT workspace_id FROM multiremi_runtimes WHERE id = ?").get(runtimeId) as { workspace_id: string | null } | null;
      if (!runtime) return;
      const desired = new Map(this.getRuntimeExecutionBindings(runtimeId).map(binding => [binding.groupId, binding]));
      for (const raw of input) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const ack = raw as RuntimeExecutionBindingAck;
        const binding = desired.get(ack.groupId);
        if (!binding || binding.generation !== ack.generation || binding.profileId !== ack.profileId || binding.profileRevision !== ack.profileRevision) continue;
        if (ack.status !== "ready" && ack.status !== "error") continue;
        if (binding.profileId !== null && (!binding.profile || binding.profileRevision === null)) continue;
        // The daemon sends only a fixed diagnostic. Do not persist arbitrary
        // remote error text that could expose a provider response or secret.
        const error = ack.status === "error" ? "Profile could not be applied; check provider compatibility and configured credentials" : null;
        const previous = this.ctx.db.query(`SELECT profile_id,profile_revision,generation,model_catalog
          FROM multiremi_execution_binding_states WHERE workspace_id=? AND group_id=? AND runtime_id=?`)
          .get(runtime.workspace_id ?? "local", ack.groupId, runtimeId) as {
            profile_id: string | null; profile_revision: number | null; generation: string; model_catalog: string | null;
          } | null;
        const catalog = ack.model_catalog === undefined ? null : normalizeBindingModelCatalog(ack.model_catalog, binding.provider)
          ?? { status: "error" as const, models: [] };
        const sameIdentity = previous?.profile_id === ack.profileId && previous?.profile_revision === ack.profileRevision
          && previous?.generation === ack.generation;
        const catalogJson = catalog ? JSON.stringify(catalog) : sameIdentity ? previous!.model_catalog : null;
        this.ctx.db.run(`INSERT INTO multiremi_execution_binding_states
          (workspace_id, group_id, runtime_id, profile_id, profile_revision, status, error, updated_at, generation, model_catalog)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id, group_id, runtime_id) DO UPDATE SET
          profile_id = excluded.profile_id, profile_revision = excluded.profile_revision,
          status = excluded.status, error = excluded.error, updated_at = excluded.updated_at, generation = excluded.generation,
          model_catalog = excluded.model_catalog`,
        [runtime.workspace_id ?? "local", ack.groupId, runtimeId, ack.profileId, ack.profileRevision, ack.status, error, nowIso(), ack.generation, catalogJson]);
        if (catalogJson !== previous?.model_catalog && catalogJson !== null) this.ctx.emitWorkspaceEvent({
          type: "daemon:models_updated", workspaceId: runtime.workspace_id ?? "local", actorType: "system", actorId: null,
          payload: { runtime_id: runtimeId, execution_group_id: ack.groupId },
        });
      }
    })();
  }

  getRuntimeBindingModelCatalog(groupId: string, runtimeId: string): RuntimeBindingModelCatalog | null {
    const desired = this.getRuntimeExecutionBindings(runtimeId).find(binding => binding.groupId === groupId);
    if (!desired?.profile || !this.isRuntimeExecutionBindingReady(groupId, runtimeId, desired.profileId, desired.profileRevision)) return null;
    const row = this.ctx.db.query(`SELECT model_catalog FROM multiremi_execution_binding_states
      WHERE group_id=? AND runtime_id=? AND generation=? AND profile_id=? AND profile_revision=?`)
      .get(groupId, runtimeId, desired.generation, desired.profileId, desired.profileRevision) as { model_catalog: string | null } | null;
    return row?.model_catalog ? JSON.parse(row.model_catalog) : null;
  }

  isRuntimeExecutionBindingReady(groupId: string, runtimeId: string, profileId: string | null, profileRevision: number | null): boolean {
    const desired = this.getRuntimeExecutionBindings(runtimeId).find(binding => binding.groupId === groupId);
    if (!desired || desired.profileId !== profileId || desired.profileRevision !== profileRevision) return false;
    if (profileId !== null && (!desired.profile || profileRevision === null)) return false;
    const row = this.ctx.db.query(`SELECT s.profile_id, s.profile_revision, s.status, s.generation
      FROM multiremi_execution_binding_states s JOIN multiremi_runtimes r
      ON r.id = s.runtime_id AND COALESCE(r.workspace_id, 'local') = s.workspace_id
      WHERE s.group_id = ? AND s.runtime_id = ?`).get(groupId, runtimeId) as {
        profile_id: string | null; profile_revision: number | null; status: string; generation: string | null;
      } | null;
    return row?.status === "ready" && row.generation === desired.generation && row.profile_id === profileId && row.profile_revision === profileRevision;
  }
}

/** Accept a bounded capability statement, never arbitrary remote objects or diagnostic text. */
function normalizeBindingModelCatalog(input: unknown, provider: string): RuntimeBindingModelCatalog | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as RuntimeBindingModelCatalog;
  if (!Array.isArray(value.models) || value.models.length > 200 || !["ready", "error"].includes(value.status)) return null;
  if (value.status === "error") return { status: "error", models: [] };
  const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0
    && value.length <= max && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
  const ids = new Set<string>();
  const models: RuntimeBindingModelCatalog["models"] = [];
  for (const model of value.models) {
    if (!model || typeof model !== "object" || !text(model.id, 200) || !text(model.label, 200)
      || typeof model.default !== "boolean" || ids.has(model.id)) return null;
    ids.add(model.id);
    const output: RuntimeBindingModelCatalog["models"][number] = { id: model.id, label: model.label, provider, default: model.default };
    if (model.thinking) {
      const thinking = model.thinking;
      const levels = thinking.supportedLevels ?? thinking.supported_levels;
      if (!Array.isArray(levels) || levels.length > 20 || (thinking.status !== undefined
        && !["supported", "unsupported", "unknown", "error"].includes(thinking.status))) return null;
      const seen = new Set<string>();
      for (const level of levels) {
        if (!level || !text(level.value, 64) || !text(level.label, 128) || seen.has(level.value)) return null;
        seen.add(level.value);
      }
      const defaultLevel = thinking.defaultLevel ?? thinking.default_level;
      if (defaultLevel !== undefined && (!text(defaultLevel, 64) || !seen.has(defaultLevel))) return null;
      output.thinking = {
        ...(thinking.status ? { status: thinking.status } : {}),
        supportedLevels: thinking.status && thinking.status !== "supported" ? [] : levels.map(level => ({ value: level.value, label: level.label })),
        ...(defaultLevel && (!thinking.status || thinking.status === "supported") ? { defaultLevel } : {}),
        ...(thinking.status === "error" ? { error: "Connection reasoning metadata unavailable" } : {}),
      };
    }
    if (model.catalog?.status === "ready") output.catalog = { status: "ready" };
    models.push(output);
  }
  return { status: "ready", models };
}
