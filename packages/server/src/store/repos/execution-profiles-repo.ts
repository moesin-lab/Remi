import { createId, nowIso } from "@multiremi/ids.js";
import type { StoreContext } from "@multiremi/store/context.js";
import { parseExecutionConnectionProfile } from "@multiremi/contracts/execution-profile.js";
import type {
  ExecutionProfile,
  ExecutionProfileInput,
} from "@multiremi/contracts/execution-profile.js";
import {
  encryptRuntimeProviderKey,
  decryptRuntimeProviderKey,
} from "@multiremi/runtime-provider-credentials.js";
import { getGroupExecutionProfile } from "../execution-groups.js";
import { endpointRuntimeProfile } from "@multiremi/contracts/execution-endpoint.js";
import { ExecutionEndpointsRepo } from "./execution-endpoints-repo.js";

type Row = Omit<ExecutionProfile, "profile"> & { profile: string };
export class ExecutionProfilesRepo {
  constructor(private readonly ctx: StoreContext) {}

  get(
    id: string,
    workspaceId: string,
    revision?: number,
  ): ExecutionProfile | null {
    const row = this.ctx.db
      .query(
        `SELECT v.* FROM multiremi_execution_profile_versions v
      JOIN multiremi_execution_profiles p ON p.id = v.id AND p.workspace_id = v.workspace_id
      WHERE p.id = ? AND p.workspace_id = ? AND v.revision = ${revision === undefined ? "p.revision AND p.deleted_at IS NULL" : "?"}`,
      )
      .get(
        ...[id, workspaceId, ...(revision === undefined ? [] : [revision])],
      ) as Row | null;
    if (!row) return null;
    if (row.provider === ("endpoint" as string)) {
      const legacy = this.ctx.db.query(`SELECT provider,profile FROM multiremi_execution_profile_versions
        WHERE workspace_id=? AND id=? AND provider IN ('claude','codex') ORDER BY revision DESC LIMIT 1`)
        .get(workspaceId, id) as { provider: "claude" | "codex"; profile: string } | null;
      if (!legacy) return null;
      const policy = JSON.parse(legacy.profile);
      return { ...row, provider: legacy.provider,
        profile: endpointRuntimeProfile(id, JSON.parse(row.profile), legacy.provider, { model: policy.model, models: policy.models }) };
    }
    return { ...row, profile: JSON.parse(row.profile) };
  }

  list(workspaceId: string): ExecutionProfile[] {
    return (
      this.ctx.db
        .query(
          "SELECT id FROM multiremi_execution_profiles WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY name, id",
        )
        .all(workspaceId) as { id: string }[]
    ).map((row) => this.get(row.id, workspaceId)).filter((row): row is ExecutionProfile => row !== null);
  }

  getGroupExecutionProfile(
    groupId: string,
    workspaceId: string,
  ): import("@multiremi/contracts/execution-profile.js").ResolvedExecutionProfile | null {
    return getGroupExecutionProfile(this.ctx.db, groupId, workspaceId);
  }

  save(
    workspaceId: string,
    input: ExecutionProfileInput,
    id = createId("ep"),
  ): ExecutionProfile {
    if (
      typeof input.name !== "string" ||
      !input.name.trim() ||
      input.name.trim().length > 128
    )
      throw new Error("Profile name is required (maximum 128 characters)");
    if (input.provider !== "claude" && input.provider !== "codex")
      throw new Error("Profile provider must be claude or codex");
    const profile = parseExecutionConnectionProfile(input.provider, input.profile);
    if (!profile) throw new Error("A connection profile is required");
    const apiKey = input.api_key;
    if (
      apiKey !== undefined &&
      (typeof apiKey !== "string" ||
        !apiKey.trim() ||
        apiKey.length > 8192 ||
        /[\x00-\x1f\x7f]/.test(apiKey))
    )
      throw new Error("Invalid API key");
    if (apiKey !== undefined && profile.auth_mode !== "api_key")
      throw new Error("API keys require api_key authentication");

    return this.ctx.db.transaction(() => {
      this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
      // The write serializes concurrent revision allocation on both supported databases.
      this.ctx.db.run(
        "UPDATE multiremi_execution_profiles SET revision = revision WHERE id = ? AND workspace_id = ?",
        [id, workspaceId],
      );
      const previous = this.get(id, workspaceId);
      if (previous && previous.provider !== input.provider)
        throw new Error("Profile provider cannot be changed");
      const stored = this.ctx.db.query("SELECT provider FROM multiremi_execution_profiles WHERE workspace_id=? AND id=?")
        .get(workspaceId, id) as { provider: string } | null;
      if (stored?.provider === "endpoint") {
        const endpoints = new ExecutionEndpointsRepo(this.ctx);
        const current = endpoints.get(id, workspaceId)!;
        const saved = endpoints.save(workspaceId, { name: input.name, api_key: apiKey,
          connection: { ...current.connection, base_url: profile.base_url, auth_mode: profile.auth_mode,
            env_key: profile.env_key, auth_header: profile.auth_header ?? current.connection.auth_header } }, id);
        const policy = JSON.stringify({ ...(profile.model ? { model: profile.model } : {}), ...(profile.models ? { models: profile.models } : {}) });
        this.ctx.db.run("UPDATE multiremi_execution_groups SET model_policy=? WHERE workspace_id=? AND profile_id=? AND provider=?",
          [policy, workspaceId, id, input.provider]);
        return { ...saved, provider: input.provider, profile: { ...profile, credential_id: saved.connection.credential_id } };
      }
      if (profile.auth_mode === "api_key") {
        const credentialId =
          apiKey === undefined
            ? previous?.profile.credential_id
            : createId("rck");
        if (!credentialId)
          throw new Error("An API key is required for this connection");
        profile.credential_id = credentialId;
        if (typeof apiKey === "string") {
          const ciphertext = encryptRuntimeProviderKey(apiKey.trim(), {
            workspaceId,
            runtimeId: id,
            credentialId,
          });
          this.ctx.db.run(
            "INSERT INTO multiremi_execution_profile_credentials (id,profile_id,workspace_id,ciphertext) VALUES (?,?,?,?)",
            [credentialId, id, workspaceId, ciphertext],
          );
        }
      }
      const time = nowIso();
      const result: ExecutionProfile = {
        id,
        workspace_id: workspaceId,
        name: input.name.trim(),
        provider: input.provider,
        revision: (previous?.revision ?? 0) + 1,
        profile,
        created_at: previous?.created_at ?? time,
        updated_at: time,
      };
      this.ctx.db.run(
        `INSERT INTO multiremi_execution_profiles(id,workspace_id,name,provider,revision,deleted_at) VALUES(?,?,?,?,?,NULL)
        ON CONFLICT(workspace_id,id) DO UPDATE SET name=excluded.name,revision=excluded.revision`,
        [id, workspaceId, result.name, result.provider, result.revision],
      );
      this.ctx.db.run(
        "INSERT INTO multiremi_execution_profile_versions(id,workspace_id,name,provider,revision,profile,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
        [
          id,
          workspaceId,
          result.name,
          result.provider,
          result.revision,
          JSON.stringify(profile),
          result.created_at,
          time,
        ],
      );
      return result;
    })();
  }

  delete(id: string, workspaceId: string): void {
    this.ctx.db.transaction(() => {
      this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
      this.ctx.db.run(
        "UPDATE multiremi_execution_profiles SET revision=revision WHERE id=? AND workspace_id=?",
        [id, workspaceId],
      );
      if (
        this.ctx.db
          .query(
            "SELECT id FROM multiremi_execution_groups WHERE workspace_id=? AND profile_id=? LIMIT 1",
          )
          .get(workspaceId, id)
      )
        throw new Error("Profile is still used by an execution group");
      if (this.ctx.db.query("SELECT engine FROM multiremi_relay_config WHERE workspace_id=? AND endpoint_id=? LIMIT 1").get(workspaceId, id))
        throw new Error("Endpoint is still used by system AI features");
      this.ctx.db.run(
        "UPDATE multiremi_execution_profiles SET deleted_at=? WHERE id=? AND workspace_id=?",
        [nowIso(), id, workspaceId],
      );
    })();
  }

  getKeyForRuntime(runtimeId: string, credentialId: string): string | null {
    const runtime = this.ctx.db
      .query("SELECT workspace_id FROM multiremi_runtimes WHERE id=?")
      .get(runtimeId) as { workspace_id: string | null } | null;
    if (!runtime) return null;
    const workspaceId = runtime.workspace_id ?? "local";
    const credential = this.ctx.db
      .query(
        "SELECT profile_id FROM multiremi_execution_profile_credentials WHERE workspace_id=? AND id=?",
      )
      .get(workspaceId, credentialId) as { profile_id: string } | null;
    if (!credential) return null;
    const current = this.credentialProfile(credential.profile_id, workspaceId);
    const bound =
      current?.profile.credential_id === credentialId &&
      this.ctx.db
        .query(
          `SELECT g.id FROM multiremi_execution_groups g
      JOIN multiremi_execution_group_members m ON m.workspace_id=g.workspace_id AND m.group_id=g.id
      WHERE g.workspace_id=? AND g.profile_id=? AND m.runtime_id=? LIMIT 1`,
        )
        .get(workspaceId, credential.profile_id, runtimeId);
    if (bound)
      return this.getKey(
        current!.id,
        workspaceId,
        current!.revision,
        credentialId,
      );
    const tasks = this.ctx.db
      .query(
        "SELECT codex_profile,claude_profile,execution_connection FROM multiremi_turn_execution_records WHERE runtime_id=? AND status IN ('dispatched','running','awaiting_human','waiting_local_directory')",
      )
      .all(runtimeId) as {
      codex_profile: string | null;
      claude_profile: string | null;
      execution_connection: string | null;
    }[];
    if (
      !tasks.some((task) =>
        (task.execution_connection && JSON.parse(task.execution_connection).profile?.credential_id === credentialId) ||
        [task.codex_profile, task.claude_profile].some(
          (value) => value && JSON.parse(value).credential_id === credentialId,
        ),
      )
    )
      return null;
    const versions = this.ctx.db
      .query(
        "SELECT revision,profile FROM multiremi_execution_profile_versions WHERE workspace_id=? AND id=?",
      )
      .all(workspaceId, credential.profile_id) as {
      revision: number;
      profile: string;
    }[];
    const version = versions.find(
      (row) => JSON.parse(row.profile).credential_id === credentialId,
    );
    return version
      ? this.getKey(
          credential.profile_id,
          workspaceId,
          version.revision,
          credentialId,
        )
      : null;
  }

  getKey(
    id: string,
    workspaceId: string,
    revision: number,
    credentialId: string,
  ): string | null {
    const profile = this.credentialProfile(id, workspaceId, revision);
    if (!profile || profile.profile.credential_id !== credentialId) return null;
    const row = this.ctx.db
      .query(
        "SELECT ciphertext FROM multiremi_execution_profile_credentials WHERE id=? AND profile_id=? AND workspace_id=?",
      )
      .get(credentialId, id, workspaceId) as { ciphertext: string } | null;
    return row
      ? decryptRuntimeProviderKey(row.ciphertext, {
          workspaceId,
          runtimeId: id,
          credentialId,
        })
      : null;
  }

  private credentialProfile(id: string, workspaceId: string, revision?: number) {
    const row = this.ctx.db.query(`SELECT v.id,v.revision,v.profile FROM multiremi_execution_profiles p
      JOIN multiremi_execution_profile_versions v ON v.workspace_id=p.workspace_id AND v.id=p.id
      WHERE p.id=? AND p.workspace_id=? AND ${revision === undefined ? "p.deleted_at IS NULL AND v.revision=p.revision" : "v.revision=?"}`)
      .get(id, workspaceId, ...(revision === undefined ? [] : [revision])) as { id: string; revision: number; profile: string } | null;
    return row ? { ...row, profile: JSON.parse(row.profile) as { credential_id?: string } } : null;
  }
}
