import { createHash } from "node:crypto";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import type { MultiremiExecutionGroup } from "@multiremi/contracts/types.js";

type RuntimeRow = {
  id: string;
  workspace_id: string | null;
  daemon_id: string | null;
  provider: string;
  execution_group_id: string | null;
};

export function backfillRuntimeExecutionGroups(
  db: SqlDatabase,
  runtimeId: string,
): void {
  const runtime = db
    .query(
      "SELECT id, workspace_id, daemon_id, provider, execution_group_id FROM multiremi_runtimes WHERE id = ?",
    )
    .get(runtimeId) as RuntimeRow | null;
  if (!runtime) return;
  const workspaceId = runtime.workspace_id ?? "local";
  const customId = runtime.execution_group_id;
  if (
    customId &&
    (customId.startsWith("eg_") ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(customId))
  )
    throw new Error("Invalid execution group identifier (eg_ is reserved)");
  if (customId && runtime.provider === "any")
    throw new Error(
      "Custom execution groups require a concrete Runtime provider",
    );
  const providers =
    runtime.provider === "any"
      ? ["claude", "codex", "antigravity"]
      : [runtime.provider];
  // A pre-daemon registration gaining its machine identity is still the same
  // target. Preserve its ID, or migrate references to an already known identity.
  if (runtime.daemon_id) {
    for (const provider of providers) {
      const previous = db
        .query(
          `SELECT id, machine_id FROM multiremi_execution_groups
        WHERE workspace_id = ? AND machine_id = ? AND provider = ?`,
        )
        .get(workspaceId, runtime.id, provider) as {
        id: string;
        machine_id: string | null;
      } | null;
      if (
        previous?.machine_id !== runtime.id ||
        runtime.daemon_id === runtime.id
      )
        continue;
      const canonical = db
        .query(
          "SELECT id FROM multiremi_execution_groups WHERE workspace_id = ? AND machine_id = ? AND provider = ?",
        )
        .get(workspaceId, runtime.daemon_id, provider) as { id: string } | null;
      if (canonical) {
        db.run(
          "UPDATE multiremi_agents SET execution_group_id = ? WHERE workspace_id = ? AND execution_group_id = ?",
          [canonical.id, workspaceId, previous.id],
        );
      } else {
        db.run(
          "UPDATE multiremi_execution_groups SET machine_id = ? WHERE workspace_id = ? AND id = ?",
          [runtime.daemon_id, workspaceId, previous.id],
        );
      }
    }
  }
  db.run("DELETE FROM multiremi_execution_group_members WHERE runtime_id = ?", [
    runtimeId,
  ]);
  for (const provider of providers) {
    const machineId = runtime.daemon_id ?? runtime.id;
    const existingDefault = !customId
      ? (db
          .query(
            "SELECT id FROM multiremi_execution_groups WHERE workspace_id = ? AND machine_id = ? AND provider = ?",
          )
          .get(workspaceId, machineId, provider) as { id: string } | null)
      : null;
    const id =
      customId ??
      existingDefault?.id ??
      `eg_${createHash("sha256")
        .update(JSON.stringify([workspaceId, machineId, provider]))
        .digest("hex")
        .slice(0, 32)}`;
    db.run(
      `INSERT INTO multiremi_execution_groups (id, workspace_id, provider, machine_id, created_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(workspace_id, id) DO NOTHING`,
      [
        id,
        workspaceId,
        provider,
        customId ? null : machineId,
        new Date().toISOString(),
      ],
    );
    const group = db
      .query(
        "SELECT provider FROM multiremi_execution_groups WHERE workspace_id = ? AND id = ?",
      )
      .get(workspaceId, id) as { provider: string };
    if (group.provider !== provider)
      throw new Error(
        "Execution group provider does not match Runtime provider",
      );
    db.run(
      "INSERT INTO multiremi_execution_group_members (runtime_id, provider, workspace_id, group_id) VALUES (?, ?, ?, ?)",
      [runtime.id, provider, workspaceId, id],
    );
  }
}

/** Discovery only reconciles existing memberships; users create new groups explicitly. */
export function syncRuntimeExecutionGroups(
  db: SqlDatabase,
  runtimeId: string,
): void {
  db.run(
    `DELETE FROM multiremi_execution_group_members WHERE runtime_id = ? AND NOT EXISTS (
    SELECT 1 FROM multiremi_runtimes r WHERE r.id = runtime_id
      AND COALESCE(r.workspace_id, 'local') = multiremi_execution_group_members.workspace_id
      AND (r.provider = multiremi_execution_group_members.provider OR r.provider = 'any'))`,
    [runtimeId],
  );
}

export function getExecutionGroup(
  db: SqlDatabase,
  id: string,
  workspaceId: string,
): MultiremiExecutionGroup | null {
  const row = db
    .query(
      "SELECT * FROM multiremi_execution_groups WHERE workspace_id = ? AND id = ?",
    )
    .get(workspaceId, id) as {
    id: string;
    workspace_id: string;
    provider: string;
    machine_id: string | null;
    created_at: string;
    name: string | null;
    profile_id: string | null;
    managed: number;
  } | null;
  if (!row) return null;
  const members = db
    .query(
      `SELECT m.runtime_id FROM multiremi_execution_group_members m
    JOIN multiremi_runtimes r ON r.id = m.runtime_id
    WHERE m.workspace_id = ? AND m.group_id = ? ORDER BY m.runtime_id`,
    )
    .all(workspaceId, id) as { runtime_id: string }[];
  const profile = row.profile_id
    ? (db
        .query(
          "SELECT revision FROM multiremi_execution_profiles WHERE workspace_id=? AND id=? AND deleted_at IS NULL",
        )
        .get(workspaceId, row.profile_id) as { revision: number } | null)
    : null;
  return {
    name: row.name ?? row.id,
    profileId: row.profile_id ?? null,
    profileRevision: profile?.revision ?? null,
    managed: row.managed === 1,
    id: row.id,
    workspaceId: row.workspace_id,
    provider: row.provider,
    machineId: row.machine_id,
    createdAt: row.created_at,
    runtimeIds: members.map((member) => member.runtime_id),
  };
}

export function listExecutionGroups(
  db: SqlDatabase,
  workspaceId: string,
): MultiremiExecutionGroup[] {
  const rows = db
    .query(
      "SELECT id FROM multiremi_execution_groups WHERE workspace_id = ? ORDER BY id",
    )
    .all(workspaceId) as { id: string }[];
  return rows.map((row) => getExecutionGroup(db, row.id, workspaceId)!);
}

export function runtimeExecutionGroupId(
  db: SqlDatabase,
  runtimeId: string,
  provider: string,
): string | null {
  const row = db
    .query(
      "SELECT m.group_id FROM multiremi_execution_group_members m JOIN multiremi_execution_groups g ON g.id=m.group_id AND g.workspace_id=m.workspace_id WHERE m.runtime_id = ? AND m.provider = ? AND g.managed=0 ORDER BY m.group_id LIMIT 1",
    )
    .get(runtimeId, provider) as { group_id: string } | null;
  return row?.group_id ?? null;
}

export function getGroupExecutionProfile(
  db: SqlDatabase,
  groupId: string,
  workspaceId: string,
): import("@multiremi/contracts/execution-profile.js").ExecutionProfile | null {
  const row = db
    .query(
      `SELECT v.* FROM multiremi_execution_groups g
    JOIN multiremi_execution_profiles p ON p.id=g.profile_id AND p.workspace_id=g.workspace_id AND p.deleted_at IS NULL
    JOIN multiremi_execution_profile_versions v ON v.id=p.id AND v.workspace_id=p.workspace_id AND v.revision=p.revision
    WHERE g.id=? AND g.workspace_id=?`,
    )
    .get(groupId, workspaceId) as Record<string, unknown> | null;
  return row
    ? ({
        ...row,
        profile: JSON.parse(row.profile as string),
      } as unknown as import("@multiremi/contracts/execution-profile.js").ExecutionProfile)
    : null;
}

export function saveExecutionGroup(
  db: SqlDatabase,
  workspaceId: string,
  id: string,
  input: import("@multiremi/contracts/execution-profile.js").ExecutionGroupInput,
): MultiremiExecutionGroup {
  if (
    typeof input.name !== "string" ||
    !input.name.trim() ||
    input.name.length > 128
  )
    throw new Error("Group name is required (maximum 128 characters)");
  if (!["claude", "codex", "antigravity"].includes(input.provider))
    throw new Error("Invalid execution provider");
  if (
    !Array.isArray(input.runtime_ids) ||
    input.runtime_ids.some((id) => typeof id !== "string") ||
    new Set(input.runtime_ids).size !== input.runtime_ids.length
  )
    throw new Error("runtime_ids must contain unique Runtime IDs");
  if (input.profile_id !== null && typeof input.profile_id !== "string")
    throw new Error("profile_id must be a Profile ID or null");
  return db.transaction(() => {
    const old = getExecutionGroup(db, id, workspaceId);
    if (old && old.provider !== input.provider)
      throw new Error("Group provider cannot be changed");
    if (input.profile_id) {
      db.run(
        "UPDATE multiremi_execution_profiles SET revision=revision WHERE id=? AND workspace_id=?",
        [input.profile_id, workspaceId],
      );
      const p = db
        .query(
          "SELECT provider FROM multiremi_execution_profiles WHERE workspace_id=? AND id=? AND deleted_at IS NULL",
        )
        .get(workspaceId, input.profile_id) as { provider: string } | null;
      if (!p || p.provider !== input.provider)
        throw new Error("Profile is missing or has a different provider");
    }
    for (const runtimeId of input.runtime_ids) {
      const r = db
        .query(
          "SELECT workspace_id,provider FROM multiremi_runtimes WHERE id=?",
        )
        .get(runtimeId) as {
        workspace_id: string | null;
        provider: string;
      } | null;
      if (
        !r ||
        (r.workspace_id ?? "local") !== workspaceId ||
        (r.provider !== input.provider && r.provider !== "any")
      )
        throw new Error("Runtime is missing or incompatible with this group");
    }
    db.run(
      `INSERT INTO multiremi_execution_groups(id,workspace_id,provider,machine_id,created_at,name,profile_id,managed) VALUES(?,?,?,NULL,?,?,?,1)
      ON CONFLICT(workspace_id,id) DO UPDATE SET name=excluded.name,profile_id=excluded.profile_id,managed=1,machine_id=NULL`,
      [
        id,
        workspaceId,
        input.provider,
        new Date().toISOString(),
        input.name.trim(),
        input.profile_id,
      ],
    );
    // A new assignment must not inherit an in-flight acknowledgement for an older binding.
    db.run(
      "DELETE FROM multiremi_execution_binding_generations WHERE workspace_id=? AND group_id=?",
      [workspaceId, id],
    );
    db.run(
      "DELETE FROM multiremi_execution_binding_states WHERE workspace_id=? AND group_id=?",
      [workspaceId, id],
    );
    for (const runtimeId of old?.runtimeIds ?? []) {
      if (!input.runtime_ids.includes(runtimeId))
        db.run(
          "DELETE FROM multiremi_execution_binding_states WHERE workspace_id=? AND group_id=? AND runtime_id=?",
          [workspaceId, id, runtimeId],
        );
    }
    db.run(
      "DELETE FROM multiremi_execution_group_members WHERE workspace_id=? AND group_id=?",
      [workspaceId, id],
    );
    for (const runtimeId of input.runtime_ids)
      db.run(
        "INSERT INTO multiremi_execution_group_members(runtime_id,provider,workspace_id,group_id) VALUES(?,?,?,?)",
        [runtimeId, input.provider, workspaceId, id],
      );
    return getExecutionGroup(db, id, workspaceId)!;
  })();
}

export function deleteExecutionGroup(
  db: SqlDatabase,
  id: string,
  workspaceId: string,
): void {
  db.transaction(() => {
    db.run(
      "DELETE FROM multiremi_execution_binding_generations WHERE workspace_id=? AND group_id=?",
      [workspaceId, id],
    );
    if (
      db
        .query(
          "SELECT id FROM multiremi_agents WHERE workspace_id=? AND execution_group_id=? LIMIT 1",
        )
        .get(workspaceId, id)
    )
      throw new Error("Execution group is still used by an agent");
    db.run(
      "DELETE FROM multiremi_execution_binding_states WHERE workspace_id=? AND group_id=?",
      [workspaceId, id],
    );
    db.run(
      "DELETE FROM multiremi_execution_group_members WHERE workspace_id=? AND group_id=?",
      [workspaceId, id],
    );
    db.run(
      "DELETE FROM multiremi_execution_groups WHERE workspace_id=? AND id=?",
      [workspaceId, id],
    );
  })();
}
