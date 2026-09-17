import { createHash } from "node:crypto";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import type { MultiremiExecutionGroup } from "@multiremi/contracts/types.js";
import { parseRuntimeClaudeProfile } from "@multiremi/contracts/claude-profile";
import { parseRuntimeCodexProfile } from "@multiremi/contracts/codex-profile";
import { createId } from "@multiremi/ids.js";
import { encryptRuntimeProviderKey } from "@multiremi/runtime-provider-credentials.js";

export function getExecutionGroupProfile(db: SqlDatabase, workspaceId: string, groupId: string) {
  const row = db.query(`SELECT g.provider, p.profile FROM multiremi_execution_group_profiles p
    JOIN multiremi_execution_groups g ON g.workspace_id = p.workspace_id AND g.id = p.group_id
    WHERE p.workspace_id = ? AND p.group_id = ?`).get(workspaceId, groupId) as { provider: string; profile: string } | null;
  return row ? (row.provider === "claude" ? parseRuntimeClaudeProfile : parseRuntimeCodexProfile)(JSON.parse(row.profile)) : null;
}

/** The caller holds the workspace lifecycle lock shared with membership changes and claims. */
export function setExecutionGroupProfile(db: SqlDatabase, workspaceId: string, groupId: string, input: unknown, apiKey?: unknown) {
  const group = getExecutionGroup(db, groupId, workspaceId);
  if (!group || !["codex", "claude"].includes(group.provider)) throw new Error("A Codex or Claude execution group is required");
  const previous = getExecutionGroupProfile(db, workspaceId, groupId);
  const profile = (group.provider === "claude" ? parseRuntimeClaudeProfile : parseRuntimeCodexProfile)(input);
  if (apiKey !== undefined && (typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 8192 || /[\x00-\x1f\x7f]/.test(apiKey))) throw new Error("Invalid API key");
  if (apiKey !== undefined && profile?.auth_mode !== "api_key") throw new Error("API keys require api_key authentication");
  if (profile?.auth_mode === "api_key") {
    const credentialId = apiKey !== undefined ? createId("rck") : previous?.credential_id;
    if (!credentialId) throw new Error("An API key is required for this connection");
    profile.credential_id = credentialId;
    if (typeof apiKey === "string") {
      const scopeId = `execution-group:${groupId}`;
      const ciphertext = encryptRuntimeProviderKey(apiKey.trim(), { workspaceId, runtimeId: scopeId, credentialId });
      db.run(`INSERT INTO multiremi_execution_group_credentials (id, workspace_id, group_id, scope_id, ciphertext)
        VALUES (?, ?, ?, ?, ?)`, [credentialId, workspaceId, groupId, scopeId, ciphertext]);
    }
  }
  if (profile) db.run(`INSERT INTO multiremi_execution_group_profiles (workspace_id, group_id, profile) VALUES (?, ?, ?)
    ON CONFLICT(workspace_id, group_id) DO UPDATE SET profile = excluded.profile`, [workspaceId, groupId, JSON.stringify(profile)]);
  else db.run("DELETE FROM multiremi_execution_group_profiles WHERE workspace_id = ? AND group_id = ?", [workspaceId, groupId]);
  if (JSON.stringify(previous) !== JSON.stringify(profile)) {
    for (const runtimeId of group.runtimeIds) db.run("DELETE FROM multiremi_runtime_models WHERE runtime_id = ?", [runtimeId]);
  }
  return profile;
}

/** Preserve distinct legacy connections instead of picking a winner and sharing its key. */
export function migrateExecutionGroupProfiles(db: SqlDatabase): void {
  const groups = db.query("SELECT id, workspace_id, provider FROM multiremi_execution_groups ORDER BY workspace_id, id").all() as { id: string; workspace_id: string; provider: string }[];
  for (const group of groups) {
    if (group.provider !== "codex" && group.provider !== "claude") continue;
    const members = db.query(`SELECT m.runtime_id, p.profile FROM multiremi_execution_group_members m
      LEFT JOIN multiremi_runtime_${group.provider}_profiles p ON p.runtime_id = m.runtime_id
      WHERE m.workspace_id = ? AND m.group_id = ? ORDER BY m.runtime_id`).all(group.workspace_id, group.id) as { runtime_id: string; profile: string | null }[];
    const partitions = new Map<string | null, string[]>();
    for (const member of members) partitions.set(member.profile, [...(partitions.get(member.profile) ?? []), member.runtime_id]);
    let first = true;
    // Keep unconfigured/any-provider members in the original default group.
    // An any-provider Runtime cannot persist a provider-specific custom group ID.
    const ordered = [...partitions].sort(([left], [right]) => left === null ? -1 : right === null ? 1 : 0);
    for (const [profile, runtimeIds] of ordered) {
      const groupId = first ? group.id : `migrated_${createHash("sha256").update(JSON.stringify([group.workspace_id, group.id, runtimeIds])).digest("hex").slice(0, 32)}`;
      first = false;
      if (groupId !== group.id) {
        db.run(`INSERT INTO multiremi_execution_groups (id, workspace_id, provider, machine_id, created_at)
          VALUES (?, ?, ?, NULL, ?)`, [groupId, group.workspace_id, group.provider, new Date().toISOString()]);
        for (const runtimeId of runtimeIds) {
          db.run("UPDATE multiremi_runtimes SET execution_group_id = ? WHERE id = ?", [groupId, runtimeId]);
          db.run("UPDATE multiremi_execution_group_members SET group_id = ? WHERE runtime_id = ? AND provider = ?", [groupId, runtimeId, group.provider]);
          db.run("UPDATE multiremi_agents SET execution_group_id = ? WHERE runtime_id = ? AND provider = ?", [groupId, runtimeId, group.provider]);
        }
      }
      if (profile) db.run("INSERT INTO multiremi_execution_group_profiles (workspace_id, group_id, profile) VALUES (?, ?, ?)", [group.workspace_id, groupId, profile]);
      for (const runtimeId of runtimeIds) {
        // Copy immutable encrypted versions without requiring the encryption key at startup.
        // scope_id retains the old AAD; new writes use the group's identity.
        db.run(`INSERT INTO multiremi_execution_group_credentials (id, workspace_id, group_id, scope_id, ciphertext)
          SELECT id, ?, ?, runtime_id, ciphertext FROM multiremi_runtime_provider_credentials WHERE runtime_id = ?
          ON CONFLICT(id) DO NOTHING`, [group.workspace_id, groupId, runtimeId]);
        db.run(`DELETE FROM multiremi_runtime_${group.provider}_profiles WHERE runtime_id = ?`, [runtimeId]);
      }
    }
  }
}

type RuntimeRow = { id: string; workspace_id: string | null; daemon_id: string | null; provider: string; execution_group_id: string | null };

export function syncRuntimeExecutionGroups(db: SqlDatabase, runtimeId: string): void {
  const runtime = db.query("SELECT id, workspace_id, daemon_id, provider, execution_group_id FROM multiremi_runtimes WHERE id = ?").get(runtimeId) as RuntimeRow | null;
  if (!runtime) return;
  const workspaceId = runtime.workspace_id ?? "local";
  const customId = runtime.execution_group_id;
  if (customId && (customId.startsWith("eg_") || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(customId))) throw new Error("Invalid execution group identifier (eg_ is reserved)");
  if (customId && runtime.provider === "any") throw new Error("Custom execution groups require a concrete Runtime provider");
  const providers = runtime.provider === "any" ? ["claude", "codex", "antigravity"] : [runtime.provider];
  // A pre-daemon registration gaining its machine identity is still the same
  // target. Preserve its ID, or migrate references to an already known identity.
  if (runtime.daemon_id) {
    for (const provider of providers) {
      const previous = db.query(`SELECT id, machine_id FROM multiremi_execution_groups
        WHERE workspace_id = ? AND machine_id = ? AND provider = ?`).get(workspaceId, runtime.id, provider) as { id: string; machine_id: string | null } | null;
      if (previous?.machine_id !== runtime.id || runtime.daemon_id === runtime.id) continue;
      const canonical = db.query("SELECT id FROM multiremi_execution_groups WHERE workspace_id = ? AND machine_id = ? AND provider = ?")
        .get(workspaceId, runtime.daemon_id, provider) as { id: string } | null;
      if (canonical) {
        db.run("UPDATE multiremi_agents SET execution_group_id = ? WHERE workspace_id = ? AND execution_group_id = ?", [canonical.id, workspaceId, previous.id]);
      } else {
        db.run("UPDATE multiremi_execution_groups SET machine_id = ? WHERE workspace_id = ? AND id = ?", [runtime.daemon_id, workspaceId, previous.id]);
      }
    }
  }
  db.run("DELETE FROM multiremi_execution_group_members WHERE runtime_id = ?", [runtimeId]);
  for (const provider of providers) {
    const machineId = runtime.daemon_id ?? runtime.id;
    const existingDefault = !customId ? db.query("SELECT id FROM multiremi_execution_groups WHERE workspace_id = ? AND machine_id = ? AND provider = ?")
      .get(workspaceId, machineId, provider) as { id: string } | null : null;
    const id = customId ?? existingDefault?.id ?? `eg_${createHash("sha256").update(JSON.stringify([workspaceId, machineId, provider])).digest("hex").slice(0, 32)}`;
    db.run(`INSERT INTO multiremi_execution_groups (id, workspace_id, provider, machine_id, created_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(workspace_id, id) DO NOTHING`, [id, workspaceId, provider, customId ? null : machineId, new Date().toISOString()]);
    const group = db.query("SELECT provider FROM multiremi_execution_groups WHERE workspace_id = ? AND id = ?").get(workspaceId, id) as { provider: string };
    if (group.provider !== provider) throw new Error("Execution group provider does not match Runtime provider");
    db.run("INSERT INTO multiremi_execution_group_members (runtime_id, provider, workspace_id, group_id) VALUES (?, ?, ?, ?)", [runtime.id, provider, workspaceId, id]);
  }
}

export function getExecutionGroup(db: SqlDatabase, id: string, workspaceId: string): MultiremiExecutionGroup | null {
  const row = db.query("SELECT * FROM multiremi_execution_groups WHERE workspace_id = ? AND id = ?").get(workspaceId, id) as { id: string; workspace_id: string; provider: string; machine_id: string | null; created_at: string } | null;
  if (!row) return null;
  const members = db.query(`SELECT m.runtime_id FROM multiremi_execution_group_members m
    JOIN multiremi_runtimes r ON r.id = m.runtime_id
    WHERE m.workspace_id = ? AND m.group_id = ? ORDER BY m.runtime_id`).all(workspaceId, id) as { runtime_id: string }[];
  return { id: row.id, workspaceId: row.workspace_id, provider: row.provider, machineId: row.machine_id, createdAt: row.created_at, runtimeIds: members.map(member => member.runtime_id) };
}

export function listExecutionGroups(db: SqlDatabase, workspaceId: string): MultiremiExecutionGroup[] {
  const rows = db.query("SELECT id FROM multiremi_execution_groups WHERE workspace_id = ? ORDER BY id").all(workspaceId) as { id: string }[];
  return rows.map(row => getExecutionGroup(db, row.id, workspaceId)!);
}

export function runtimeExecutionGroupId(db: SqlDatabase, runtimeId: string, provider: string): string | null {
  const row = db.query("SELECT group_id FROM multiremi_execution_group_members WHERE runtime_id = ? AND provider = ?").get(runtimeId, provider) as { group_id: string } | null;
  return row?.group_id ?? null;
}
