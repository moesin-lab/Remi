/** Assistant domain vocabulary. Contains neither IM credentials nor host assignment. */
export interface AssistantExecutor {
  agentId: string;
  agentName: string;
}

/** Target model for persisted assistants; Phase 1 does not expose a CRUD API yet. */
export interface Assistant {
  id: string;
  workspaceId: string;
  name: string;
  mainChatSessionId: string | null;
  defaultAgentId: string;
  supervisionPolicy: "manual" | "background";
}

/** Per-channel opt-ins, distinct from transport enabled/allowlist settings. */
export interface AssistantChannelCapabilities {
  main: boolean;
  currentSessionQuestions: boolean;
  currentSessionApprovals: boolean;
  workspaceQuestions: boolean;
  workspaceApprovals: boolean;
  notifications: boolean;
  briefings: boolean;
}

/** Defaults for NEW bindings. Legacy bindings retain existing behavior until migrated. */
export const DEFAULT_ASSISTANT_CHANNEL_CAPABILITIES: Readonly<AssistantChannelCapabilities> = Object.freeze({
  main: true,
  currentSessionQuestions: true,
  currentSessionApprovals: true,
  workspaceQuestions: false,
  workspaceApprovals: false,
  notifications: false,
  briefings: false,
});
