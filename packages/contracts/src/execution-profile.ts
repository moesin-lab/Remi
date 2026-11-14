import { parseRuntimeConnectionProfile, type RuntimeConnectionProfile } from "./runtime-connection.js";

/** Central connections can discover their default; task/legacy Runtime profiles remain strict. */
export function parseExecutionConnectionProfile(provider: "claude" | "codex" | "antigravity", value: unknown): (RuntimeConnectionProfile & { auth_header?: "bearer" | "x-api-key" }) | null {
  if (provider === "antigravity") return parseRuntimeConnectionProfile(value, "REMI_ANTIGRAVITY_", true);
  if (provider === "codex" || value === null) return parseRuntimeConnectionProfile(value, "REMI_CODEX_", true);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("profile must be an object or null");
  const { auth_header = "bearer", ...connection } = value as Record<string, unknown>;
  if (auth_header !== "bearer" && auth_header !== "x-api-key") throw new Error("Invalid profile auth_header");
  return { ...parseRuntimeConnectionProfile(connection, "REMI_CLAUDE_", true)!, auth_header };
}

/** Workspace-owned, immutable revision of a connection. Contains no plaintext secrets. */
export interface ExecutionProfile {
  id: string;
  workspace_id: string;
  name: string;
  provider: "claude" | "codex";
  revision: number;
  profile: RuntimeConnectionProfile;
  created_at: string;
  updated_at: string;
}
/** Provider-specific view resolved from a group's endpoint, including non-legacy engines. */
export type ResolvedExecutionProfile = Omit<ExecutionProfile, "provider"> & { provider: string };

export interface ExecutionProfileInput {
  name: string;
  provider: "claude" | "codex";
  profile: unknown;
  api_key?: unknown;
}

export interface ExecutionGroupInput {
  name: string;
  description?: string;
  provider: string;
  profile_id?: string | null;
  /** Canonical shared endpoint reference. Null explicitly selects local authentication. */
  endpoint_id?: string | null;
  model_policy?: import("./execution-endpoint.js").ExecutionModelPolicy;
  runtime_ids: string[];
  /** Save the group's connection and membership atomically. The engine is inherited
   * from the group; profile_id selects a shared profile to update, or null creates one. */
  connection?: Omit<ExecutionProfileInput, "provider">;
}
