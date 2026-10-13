import { parseRuntimeConnectionProfile, type RuntimeConnectionProfile } from "./runtime-connection.js";

/** Central connections can discover their default; task/legacy Runtime profiles remain strict. */
export function parseExecutionConnectionProfile(provider: "claude" | "codex", value: unknown): (RuntimeConnectionProfile & { auth_header?: "bearer" | "x-api-key" }) | null {
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
  profile_id: string | null;
  runtime_ids: string[];
  /** Save the group's connection and membership atomically. The engine is inherited
   * from the group; profile_id selects a shared profile to update, or null creates one. */
  connection?: Omit<ExecutionProfileInput, "provider">;
}
