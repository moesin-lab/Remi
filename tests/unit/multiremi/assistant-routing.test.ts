import { describe, expect, it } from "bun:test";
import { resolveAssistantExecutor, type AssistantRouteCandidate, type AssistantRoutingSource } from "@multiremi/assistant/routing.js";

const executor = (agentId: string, overrides: Partial<AssistantRouteCandidate> = {}): AssistantRouteCandidate => ({
  agentId, agentName: agentId, workspaceId: "local", archivedAt: null, ...overrides,
});

function source(routes: Partial<Record<"conversation" | "direct" | "group", AssistantRouteCandidate>>): AssistantRoutingSource {
  return { findRoute: scope => routes[scope] ?? null, legacyDefault: () => ({ agentId: "legacy", agentName: "Legacy" }) };
}

describe("Assistant routing policy", () => {
  it("shares conversation precedence between channel adapters without a Runtime or bot", () => {
    const routes = source({ conversation: executor("exact"), direct: executor("direct"), group: executor("group") });
    for (const conversationKind of ["p2p", "group"] as const) {
      expect(resolveAssistantExecutor({ workspaceId: "local", conversationKind, conversationId: "thread" }, routes)?.agentId).toBe("exact");
    }
  });

  it("skips foreign, archived, missing and empty route Agents before fallback", () => {
    for (const invalid of [
      executor("foreign", { workspaceId: "other" }),
      executor("archived", { archivedAt: "2026-11-16" }),
      executor("missing", { workspaceId: null }),
      executor(""),
    ]) {
      const routes = source({ conversation: invalid, group: executor("group") });
      expect(resolveAssistantExecutor({ workspaceId: "local", conversationKind: "group", conversationId: "thread" }, routes)?.agentId).toBe("group");
      routes.findRoute = () => invalid;
      expect(resolveAssistantExecutor({ workspaceId: "local", conversationKind: "group", conversationId: "thread" }, routes)?.agentId).toBe("legacy");
    }
  });

  it("normalizes conversation ids and never looks up an empty conversation route", () => {
    const lookedUp: Array<[string, string | undefined]> = [];
    const routes: AssistantRoutingSource = {
      findRoute: (scope, id) => { lookedUp.push([scope, id]); return null; },
      legacyDefault: () => null,
    };
    expect(resolveAssistantExecutor({ workspaceId: "local", conversationKind: "p2p", conversationId: "  " }, routes)).toBeNull();
    expect(lookedUp.map(([scope]) => scope)).toEqual(["direct"]);
    lookedUp.length = 0;
    resolveAssistantExecutor({ workspaceId: "local", conversationKind: "group", conversationId: "  thread  " }, routes);
    expect(lookedUp).toEqual([["conversation", "thread"], ["group", "thread"]]);
  });

  it("does not read a legacy binding when a valid route already selected an executor", () => {
    const routes = source({ direct: executor("direct") });
    routes.legacyDefault = () => { throw new Error("should not read fallback"); };
    expect(resolveAssistantExecutor({ workspaceId: "local", conversationKind: "p2p" }, routes)).toEqual({ agentId: "direct", agentName: "direct" });
  });
});
