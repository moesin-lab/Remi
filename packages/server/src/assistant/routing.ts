import type { AssistantExecutor } from "@multiremi/contracts/assistant.js";

export interface AssistantRouteCandidate extends AssistantExecutor {
  workspaceId: string | null;
  archivedAt: string | null;
}

export interface AssistantRoutingSource {
  /** The adapter scopes lookups to its channel binding; the policy checks Agent tenancy. */
  findRoute(scope: "conversation" | "direct" | "group", conversationId?: string): AssistantRouteCandidate | null;
  /** Historical fallback semantics; lifecycle validation stays with the existing config path. */
  legacyDefault(): AssistantExecutor | null;
}

/** Conversation route > conversation-kind default > legacy configured executor.
 * No sessions are created here; Issue topic/thread isolation stays in the adapter.
 */
export function resolveAssistantExecutor(
  input: { workspaceId: string; conversationKind: "p2p" | "group"; conversationId?: string | null },
  source: AssistantRoutingSource,
): AssistantExecutor | null {
  const conversationId = input.conversationId == null ? undefined : String(input.conversationId).trim() || undefined;
  const scopes: Array<"conversation" | "direct" | "group"> = [];
  if (conversationId) scopes.push("conversation");
  scopes.push(input.conversationKind === "p2p" ? "direct" : "group");
  // Read candidates before selection, as the legacy adapter did.
  const candidates = scopes.map(scope => source.findRoute(scope, conversationId));
  for (const candidate of candidates) {
    if (!candidate || candidate.workspaceId !== input.workspaceId || candidate.archivedAt != null || !candidate.agentId) continue;
    return { agentId: candidate.agentId, agentName: candidate.agentName };
  }
  return source.legacyDefault();
}
