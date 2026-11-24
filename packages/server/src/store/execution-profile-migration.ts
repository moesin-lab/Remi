import { createHash } from "node:crypto";
import { createId } from "@multiremi/ids.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import {
  encryptRuntimeProviderKey,
  decryptRuntimeProviderKey,
} from "@multiremi/runtime-provider-credentials.js";

/** One-time import preserves source rows for already frozen legacy task snapshots. */
export function migrateLegacyExecutionProfiles(db: SqlDatabase): void {
  const imported = new Map<string, string>();
  for (const provider of ["claude", "codex"] as const) {
    const rows = db
      .query(
        `SELECT p.runtime_id,p.profile,r.workspace_id,r.name FROM multiremi_runtime_${provider}_profiles p JOIN multiremi_runtimes r ON r.id=p.runtime_id`,
      )
      .all() as {
      runtime_id: string;
      profile: string;
      workspace_id: string | null;
      name: string;
    }[];
    for (const row of rows) {
      const workspaceId = row.workspace_id ?? "local";
      const profile = JSON.parse(row.profile);
      const identity = JSON.stringify([workspaceId, row.runtime_id, provider]);
      const id = `ep_migrated_${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
      imported.set(identity, id);
      if (
        db
          .query(
            "SELECT id FROM multiremi_execution_profiles WHERE workspace_id=? AND id=?",
          )
          .get(workspaceId, id)
      )
        continue;
      if (profile.credential_id) {
        const oldId = profile.credential_id;
        const credential = db
          .query(
            "SELECT ciphertext FROM multiremi_runtime_provider_credentials WHERE id=? AND runtime_id=?",
          )
          .get(oldId, row.runtime_id) as { ciphertext: string } | null;
        if (!credential)
          throw new Error(
            "Legacy Runtime profile credential is missing; restore it before migration",
          );
        const key = decryptRuntimeProviderKey(credential.ciphertext, {
          workspaceId,
          runtimeId: row.runtime_id,
          credentialId: oldId,
        });
        profile.credential_id = createId("rck");
        const ciphertext = encryptRuntimeProviderKey(key, {
          workspaceId,
          runtimeId: id,
          credentialId: profile.credential_id,
        });
        db.run(
          "INSERT INTO multiremi_execution_profile_credentials(id,profile_id,workspace_id,ciphertext) VALUES(?,?,?,?)",
          [profile.credential_id, id, workspaceId, ciphertext],
        );
      }
      db.run(
        "INSERT INTO multiremi_execution_profile_legacy_sources(profile_id,workspace_id,revision,runtime_id,provider,legacy_profile) VALUES(?,?,1,?,?,?)",
        [id, workspaceId, row.runtime_id, provider, row.profile],
      );
      const name = `${row.name} / ${profile.name}`;
      const time = new Date().toISOString();
      db.run(
        "INSERT INTO multiremi_execution_profiles(id,workspace_id,name,provider,revision,deleted_at) VALUES(?,?,?,?,1,NULL)",
        [id, workspaceId, name, provider],
      );
      db.run(
        "INSERT INTO multiremi_execution_profile_versions(id,workspace_id,name,provider,revision,profile,created_at,updated_at) VALUES(?,?,?,?,1,?,?,?)",
        [id, workspaceId, name, provider, JSON.stringify(profile), time, time],
      );
      imported.set(JSON.stringify([workspaceId, row.runtime_id, provider]), id);
    }
  }
  const groups = db
    .query(
      "SELECT id,workspace_id,provider FROM multiremi_execution_groups WHERE managed=0",
    )
    .all() as { id: string; workspace_id: string; provider: string }[];
  for (const group of groups) {
    const members = db
      .query(
        "SELECT runtime_id FROM multiremi_execution_group_members WHERE workspace_id=? AND group_id=?",
      )
      .all(group.workspace_id, group.id) as { runtime_id: string }[];
    const ids = members.map(
      (member) =>
        imported.get(
          JSON.stringify([
            group.workspace_id,
            member.runtime_id,
            group.provider,
          ]),
        ) ?? null,
    );
    if (ids.length && ids.every((id) => id === ids[0])) {
      db.run(
        "UPDATE multiremi_execution_groups SET name=COALESCE(name,id),profile_id=?,managed=1 WHERE workspace_id=? AND id=?",
        [ids[0], group.workspace_id, group.id],
      );
    }
  }
  // Heterogeneous legacy pools keep their routing; each imported connection also gets
  // an explicit group so editing the central Profile has a usable deployment target.
  for (const [identity, profileId] of imported) {
    const [workspaceId, runtimeId, provider] = JSON.parse(identity) as string[];
    if (
      db
        .query(
          "SELECT id FROM multiremi_execution_groups WHERE workspace_id=? AND profile_id=? AND managed=1",
        )
        .get(workspaceId, profileId)
    )
      continue;
    const groupId = `eg_${profileId}`;
    const row = db
      .query(
        "SELECT name FROM multiremi_execution_profiles WHERE workspace_id=? AND id=?",
      )
      .get(workspaceId, profileId) as { name: string };
    db.run(
      "INSERT INTO multiremi_execution_groups(id,workspace_id,name,provider,profile_id,managed,created_at) VALUES(?,?,?,?,?,1,?) ON CONFLICT(workspace_id,id) DO NOTHING",
      [
        groupId,
        workspaceId,
        row.name,
        provider,
        profileId,
        new Date().toISOString(),
      ],
    );
    db.run(
      "INSERT INTO multiremi_execution_group_members(runtime_id,provider,workspace_id,group_id) VALUES(?,?,?,?) ON CONFLICT(workspace_id,group_id,runtime_id) DO NOTHING",
      [runtimeId, provider, workspaceId, groupId],
    );
  }
}
