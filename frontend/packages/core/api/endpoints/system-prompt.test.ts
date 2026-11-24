import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../client";
import { ApiContractError } from "../schema";
import { TurnDetailSchema } from "../schemas/messages";
import { applyWorkspaceUpdatedToCache } from "../../realtime/sync/workspace";
import { workspaceKeys } from "../../workspace/queries";
import type { SystemPromptSlots, SystemPromptState, SystemPromptVersionDetail } from "../../types";

const SLOTS: SystemPromptSlots = {
  common: "Be concise.",
  code_delivery: "Open a PR.",
  chat_delivery: "Attach long reports.",
  issue_delivery: "Use Mermaid for short diagrams.",
  finishing: "Summarize changes.",
};

const STATE: SystemPromptState = {
  document: {
    id: "doc_1",
    key: "system-policy",
    workspaceId: "ws_1",
    revision: 2,
    currentVersionId: "ver_2",
    mode: "custom",
  },
  content: SLOTS,
  currentDefault: {
    revision: "def_rev_new_12345678",
    contentHash: "a".repeat(64),
    content: { ...SLOTS, common: "" },
  },
  baseDefault: {
    revision: "def_rev_old_12345678",
    contentHash: "b".repeat(64),
    content: { ...SLOTS, common: "" },
  },
  defaultUpdated: true,
  limits: { maxCodePoints: 8000 },
};

const VERSION_DETAIL: SystemPromptVersionDetail = {
  id: "ver_2",
  documentId: "doc_1",
  workspaceId: "ws_1",
  versionNumber: 2,
  mode: "custom",
  operation: "edit",
  contentHash: "c".repeat(64),
  baseDefaultRevision: "def_rev_old_12345678",
  restoredFromVersionId: null,
  parentVersionId: "ver_1",
  actor: {
    type: "human",
    operatorId: "local",
    userId: "user_1",
    displayName: "Alice",
  },
  createdAt: "2026-11-24T12:00:00.000Z",
  changeNote: "Tune common tone",
  requestId: "req_1",
  isCurrent: true,
  content: SLOTS,
  baseDefaultSnapshot: { ...SLOTS, common: "" },
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("System Prompt API endpoints and schemas", () => {
  it("calls all 7 System Prompt endpoints with exact paths, methods, and strict parsing", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(STATE))
      .mockResolvedValueOnce(jsonResponse({ ...STATE, version: VERSION_DETAIL, replayed: false }))
      .mockResolvedValueOnce(jsonResponse({ ...STATE, version: { ...VERSION_DETAIL, operation: "reset", mode: "default" }, replayed: false }))
      .mockResolvedValueOnce(jsonResponse({ versions: [VERSION_DETAIL], nextCursor: "cursor_2" }))
      .mockResolvedValueOnce(jsonResponse(VERSION_DETAIL))
      .mockResolvedValueOnce(jsonResponse({ ...STATE, version: { ...VERSION_DETAIL, operation: "rollback" }, replayed: false }))
      .mockResolvedValueOnce(jsonResponse({
        instructions: "# AGENTS",
        input: "turn input",
        sha256: { instructions: "a".repeat(64), input: "b".repeat(64) },
        content: SLOTS,
        scenario: "feishu-issue-topic-codex-linux",
        excludesLocalContext: true,
      }));

    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient("https://api.example.test");

    const loaded = await client.getWorkspaceSystemPrompt("ws_1");
    expect(loaded.document.revision).toBe(2);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.example.test/api/workspaces/ws_1/system-prompt");

    const updated = await client.updateWorkspaceSystemPrompt("ws_1", {
      content: SLOTS,
      expectedRevision: 1,
      requestId: "req_1",
      changeNote: "Tune common tone",
      baseDefaultRevision: "def_rev_old_12345678",
    });
    expect(updated.version.id).toBe("ver_2");
    expect(fetchMock.mock.calls[1]![1]!.method).toBe("PUT");

    const reset = await client.resetWorkspaceSystemPrompt("ws_1", {
      expectedRevision: 2,
      requestId: "req_2",
      changeNote: "Back to default",
    });
    expect(reset.version.operation).toBe("reset");
    expect(fetchMock.mock.calls[2]![0]).toBe("https://api.example.test/api/workspaces/ws_1/system-prompt/reset");

    const page = await client.listWorkspaceSystemPromptVersions("ws_1", { cursor: "cur_1", limit: 10 });
    expect(page.versions).toHaveLength(1);
    expect(page.nextCursor).toBe("cursor_2");
    expect(fetchMock.mock.calls[3]![0]).toBe("https://api.example.test/api/workspaces/ws_1/system-prompt/versions?cursor=cur_1&limit=10");

    const detail = await client.getWorkspaceSystemPromptVersion("ws_1", "ver_2");
    expect(detail.content.common).toBe("Be concise.");
    expect(fetchMock.mock.calls[4]![0]).toBe("https://api.example.test/api/workspaces/ws_1/system-prompt/versions/ver_2");

    const restored = await client.restoreWorkspaceSystemPromptVersion("ws_1", {
      versionId: "ver_2",
      expectedRevision: 3,
      requestId: "req_3",
    });
    expect(restored.version.operation).toBe("rollback");
    expect(fetchMock.mock.calls[5]![0]).toBe("https://api.example.test/api/workspaces/ws_1/system-prompt/restore");

    const preview = await client.previewWorkspaceSystemPrompt("ws_1", { content: SLOTS });
    expect(preview.excludesLocalContext).toBe(true);
    expect(preview.scenario).toBe("feishu-issue-topic-codex-linux");
    expect(fetchMock.mock.calls[6]![0]).toBe("https://api.example.test/api/workspaces/ws_1/system-prompt/preview");
  });

  it("rejects malformed 2xx payloads strictly on System Prompt endpoints", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ broken: true })));
    const client = new ApiClient("https://api.example.test");
    await expect(client.getWorkspaceSystemPrompt("ws_1")).rejects.toBeInstanceOf(ApiContractError);
  });

  it("parses system_prompt_policy on TurnDetailSchema and degrades cleanly when absent or malformed", () => {
    const baseTurn = {
      id: "turn_1",
      session_id: "sess_1",
      seq: 1,
      agent_id: "agt_1",
      status: "completed",
      current_attempt_id: "att_1",
      input_from_seq: 0,
      input_to_seq: 1,
      created_at: "2026-11-24T12:00:00Z",
      started_at: null,
      ended_at: null,
      ended_reason: null,
    };

    const withPolicy = TurnDetailSchema.parse({
      turn: baseTurn,
      input: {
        from_seq: 0,
        to_seq: 1,
        messages: [],
        legacy_prompt: null,
        sent_prompt: "hello",
        instructions: "# AGENTS",
        system_prompt_policy: {
          format: 1,
          workspaceId: "ws_1",
          documentId: "doc_1",
          versionId: "ver_2",
          versionNumber: 2,
          mode: "custom",
          defaultRevision: "def_rev_1234",
          content: SLOTS,
          contentHash: "d".repeat(64),
          legacyCompatible: false,
        },
      },
    });
    expect(withPolicy.input?.system_prompt_policy?.versionNumber).toBe(2);
    expect(withPolicy.input?.system_prompt_policy?.mode).toBe("custom");

    const withoutPolicy = TurnDetailSchema.parse({
      turn: baseTurn,
      input: {
        from_seq: 0,
        to_seq: 1,
        messages: [],
        legacy_prompt: null,
        sent_prompt: "hello",
      },
    });
    expect(withoutPolicy.input?.system_prompt_policy).toBeNull();

    const malformedPolicy = TurnDetailSchema.parse({
      turn: baseTurn,
      input: {
        from_seq: 0,
        to_seq: 1,
        messages: [],
        legacy_prompt: null,
        system_prompt_policy: { bad: true },
      },
    });
    expect(malformedPolicy.input?.system_prompt_policy).toBeNull();
  });

  it("invalidates document and history for the sparse policy event without replacing workspace data", () => {
    const qc = new QueryClient();
    const workspace = { id: "local", name: "Existing", issue_prefix: "MUL" };
    qc.setQueryData(workspaceKeys.list(), [workspace]);
    const document = workspaceKeys.systemPrompt("local");
    const history = workspaceKeys.systemPromptVersions("local");
    const foreign = workspaceKeys.systemPrompt("other");
    for (const key of [document, history, foreign]) qc.setQueryData(key, {});
    applyWorkspaceUpdatedToCache(qc, { id: "local" });
    expect(qc.getQueryState(document)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(history)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(foreign)?.isInvalidated).toBe(false);
    expect(qc.getQueryData(workspaceKeys.list())).toEqual([workspace]);
  });

  it("invalidates workspace systemPrompt queries on workspace:updated realtime events", () => {
    const qc = new QueryClient();
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    applyWorkspaceUpdatedToCache(qc, {
      workspace: {
        id: "ws_1",
        name: "Local",
        slug: "local",
        description: null,
        context: null,
        settings: {},
        repos: [],
        issue_prefix: "MUL",
        avatar_url: null,
        created_at: "2026-11-24T00:00:00Z",
        updated_at: "2026-11-24T00:00:00Z",
      },
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: workspaceKeys.systemPrompt("ws_1"),
    });
  });
});
