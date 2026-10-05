import type { RuntimeConnectionProfile } from "./runtime-connection.js";

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
