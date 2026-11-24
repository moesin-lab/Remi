import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { workspaceKeys } from "@multiremi/core/workspace/queries";
import { WSClient } from "@multiremi/core/api/ws-client";
import { createAuthStore, registerAuthStore } from "@multiremi/core/auth";
import { defaultStorage } from "@multiremi/core/platform";
import { useRealtimeSync } from "@multiremi/core/realtime";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type {
  SystemPromptSlots,
  SystemPromptState,
  SystemPromptVersionDetail,
  SystemPromptVersionSummary,
  WorkspacePromptSettings,
} from "@multiremi/core/types";
import enCommon from "../../locales/en/common.json";
import enSettings from "../../locales/en/settings.json";

const apiMocks = vi.hoisted(() => ({
  listMembers: vi.fn(),
  getWorkspacePromptSettings: vi.fn(),
  updateWorkspacePromptSettings: vi.fn(),
  getWorkspaceSystemPrompt: vi.fn(),
  updateWorkspaceSystemPrompt: vi.fn(),
  resetWorkspaceSystemPrompt: vi.fn(),
  listWorkspaceSystemPromptVersions: vi.fn(),
  getWorkspaceSystemPromptVersion: vi.fn(),
  restoreWorkspaceSystemPromptVersion: vi.fn(),
  previewWorkspaceSystemPrompt: vi.fn(),
}));

const copyText = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const toastMocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "workspace-1" }));
vi.mock("@multiremi/core/api", () => {
  class MockApiError extends Error {
    readonly status: number;
    readonly statusText: string;
    readonly body?: unknown;
    constructor(message: string, status: number, statusText = "Error", body?: unknown) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.statusText = statusText;
      this.body = body;
    }
  }
  return {
    api: apiMocks,
    ApiError: MockApiError,
  };
});
vi.mock("sonner", () => ({ toast: toastMocks }));
vi.mock("@multiremi/ui/lib/clipboard", () => ({ copyText }));

import { api, ApiError } from "@multiremi/core/api";
import { PromptsTab } from "./prompts-tab";

const TEST_RESOURCES = { en: { common: enCommon, settings: enSettings } };

const DEFAULT_SLOTS: SystemPromptSlots = {
  common: "",
  code_delivery: "Push branch and create PR.",
  chat_delivery: "Attach long reports.",
  issue_delivery: "Use Mermaid for short diagrams.",
  finishing: "Summarize changes and risks.",
};

function makeState(overrides: Partial<SystemPromptState> = {}): SystemPromptState {
  return {
    document: {
      id: null,
      key: "system-policy",
      workspaceId: "workspace-1",
      revision: 0,
      currentVersionId: null,
      mode: "default",
      ...(overrides.document ?? {}),
    },
    content: overrides.content ?? { ...DEFAULT_SLOTS },
    currentDefault: overrides.currentDefault ?? {
      revision: "default-rev-1111aaaa",
      contentHash: "a".repeat(64),
      content: { ...DEFAULT_SLOTS },
    },
    baseDefault: overrides.baseDefault ?? {
      revision: "default-rev-1111aaaa",
      contentHash: "a".repeat(64),
      content: { ...DEFAULT_SLOTS },
    },
    defaultUpdated: overrides.defaultUpdated ?? false,
    limits: overrides.limits ?? { maxCodePoints: 8_000 },
  };
}

function makeVersionSummary(
  versionNumber: number,
  overrides: Partial<SystemPromptVersionSummary> = {},
): SystemPromptVersionSummary {
  return {
    id: `ver-${versionNumber}`,
    documentId: "doc-1",
    workspaceId: "workspace-1",
    versionNumber,
    mode: "custom",
    operation: "edit",
    contentHash: String(versionNumber).repeat(64).slice(0, 64),
    baseDefaultRevision: "default-rev-1111aaaa",
    restoredFromVersionId: null,
    parentVersionId: versionNumber > 1 ? `ver-${versionNumber - 1}` : null,
    actor: {
      type: "human",
      operatorId: "local",
      userId: "user-1",
      displayName: "Alice",
    },
    createdAt: "2026-11-24T12:00:00.000Z",
    changeNote: null,
    requestId: `req-${versionNumber}`,
    isCurrent: false,
    ...overrides,
  };
}

function makeVersionDetail(
  summary: SystemPromptVersionSummary,
  content: SystemPromptSlots,
): SystemPromptVersionDetail {
  return {
    ...summary,
    content,
    baseDefaultSnapshot: { ...DEFAULT_SLOTS },
  };
}

function renderPromptsTab(companion?: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <I18nProvider locale="en" resources={TEST_RESOURCES}>
          {children}
        </I18nProvider>
      </QueryClientProvider>
    );
  }
  return { ...render(<>{companion}<PromptsTab /></>, { wrapper: Wrapper }), queryClient };
}

describe("PromptsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.listMembers.mockResolvedValue([
      {
        id: "mem-1",
        workspace_id: "workspace-1",
        user_id: "local",
        role: "owner",
        name: "Local User",
        avatar_url: null,
        created_at: "2026-11-24T00:00:00Z",
      },
    ]);
    const emptyAppendix: WorkspacePromptSettings = {
      prompt: "",
      revision: 0,
      updatedAt: null,
      updatedBy: null,
    };
    apiMocks.getWorkspacePromptSettings.mockResolvedValue(emptyAppendix);
    apiMocks.updateWorkspacePromptSettings.mockResolvedValue({
      prompt: "Workspace appendix rule",
      revision: 1,
      updatedAt: "2026-11-24T12:00:00Z",
      updatedBy: "local",
    });
    apiMocks.getWorkspaceSystemPrompt.mockResolvedValue(makeState());
    apiMocks.listWorkspaceSystemPromptVersions.mockResolvedValue({
      versions: [],
      nextCursor: null,
    });
    apiMocks.previewWorkspaceSystemPrompt.mockResolvedValue({
      instructions: "# Remi notes\n\n{{issue_description}}",
      input: "{{current_request}}",
      sha256: { instructions: "a".repeat(64), input: "b".repeat(64) },
      content: { ...DEFAULT_SLOTS },
      scenario: "feishu-issue-topic-codex-linux",
      excludesLocalContext: true,
    });
  });

  it("renders three-zone layout, saves all five slots with change note, and collapses empty appendix by default", async () => {
    const user = userEvent.setup();
    const savedSlots: SystemPromptSlots = {
      ...DEFAULT_SLOTS,
      common: "Prefer concise bullet points.",
      finishing: "",
    };
    const savedState = makeState({
      document: {
        id: "doc-1",
        key: "system-policy",
        workspaceId: "workspace-1",
        revision: 2,
        currentVersionId: "ver-2",
        mode: "custom",
      },
      content: savedSlots,
    });
    apiMocks.updateWorkspaceSystemPrompt.mockResolvedValue({
      ...savedState,
      version: makeVersionDetail(
        makeVersionSummary(2, { isCurrent: true, changeNote: "Concise style" }),
        savedSlots,
      ),
      replayed: false,
    });

    renderPromptsTab();

    expect(await screen.findByText("Following platform default (Default)")).toBeInTheDocument();
    expect(screen.getByText(/Saved changes take effect on newly claimed runs/)).toBeInTheDocument();

    // Zone 2 appendix should be collapsed when empty
    expect(screen.queryByLabelText("Workspace supplementary prompt")).not.toBeInTheDocument();

    // Edit common slot and explicitly clear finishing slot
    const commonBox = screen.getByLabelText("General behavior");
    const finishingBox = screen.getByLabelText("Finishing summary");
    await user.type(commonBox, "Prefer concise bullet points.");
    await user.clear(finishingBox);
    await user.type(screen.getByLabelText("Change note (optional)"), "Concise style");
    await user.click(screen.getByRole("button", { name: "Save new version" }));

    await waitFor(() =>
      expect(apiMocks.updateWorkspaceSystemPrompt).toHaveBeenCalledWith(
        "workspace-1",
        expect.objectContaining({
          content: savedSlots,
          expectedRevision: 0,
          changeNote: "Concise style",
          baseDefaultRevision: "default-rev-1111aaaa",
          requestId: expect.any(String),
        }),
      ),
    );

    expect(await screen.findByText("Customized (Custom)")).toBeInTheDocument();
    expect(screen.getByText("Explicitly empty")).toBeInTheDocument();
  });

  it.each([true, false])("pairs the saved draft with the catalog visible when editing began (upgrade before edit=%s)", async (beforeEdit) => {
    const reset = makeState();
    reset.document = { ...reset.document, id: "doc-1", revision: 1, currentVersionId: "reset-A" };
    const slots = { ...DEFAULT_SLOTS, common: "catalog B" };
    const upgraded = makeState({ ...reset, content: slots, currentDefault: { revision: "B", contentHash: "b".repeat(64), content: slots }, defaultUpdated: true });
    apiMocks.getWorkspaceSystemPrompt.mockResolvedValue(beforeEdit ? upgraded : reset);
    const { queryClient } = renderPromptsTab();
    const box = await screen.findByLabelText("General behavior");
    expect(box).toHaveValue(beforeEdit ? "catalog B" : "");
    fireEvent.change(box, { target: { value: "my edit" } });
    if (!beforeEdit) await act(async () => { queryClient.setQueryData(workspaceKeys.systemPrompt("workspace-1"), upgraded); });
    fireEvent.click(screen.getByRole("button", { name: "Save new version" }));
    await waitFor(() => expect(apiMocks.updateWorkspaceSystemPrompt).toHaveBeenCalledWith("workspace-1", expect.objectContaining({
      content: { ...DEFAULT_SLOTS, common: "my edit" }, expectedRevision: 1,
      baseDefaultRevision: beforeEdit ? "B" : reset.currentDefault.revision,
    })));
  });

  it.each([false, true])("refetches policy and history for edit/reset/restore events with a dirty editor=%s", async dirty => {
    const ws = new WSClient("ws://localhost");
    const subscriptions = vi.spyOn(ws, "on");
    const authStore = createAuthStore({ api, storage: defaultStorage });
    registerAuthStore(authStore);
    function Sync() {
      useRealtimeSync(ws, { authStore });
      return null;
    }
    renderPromptsTab(<Sync />);
    const box = await screen.findByLabelText("General behavior");
    const receive = subscriptions.mock.calls.find(([event]) => event === "workspace:updated")![1];
    await waitFor(() => expect(apiMocks.listWorkspaceSystemPromptVersions).toHaveBeenCalledTimes(1));
    if (dirty) fireEvent.change(box, { target: { value: "unsaved local draft" } });
    for (const [index, operation] of (["edit", "reset", "rollback"] as const).entries()) {
      const version = makeVersionSummary(index + 2, { operation, mode: operation === "reset" ? "default" : "custom",
        isCurrent: true, changeNote: `remote ${operation}` });
      const state = makeState();
      state.document = { ...state.document, id: "doc-1", revision: version.versionNumber, currentVersionId: version.id, mode: version.mode };
      state.content = { ...DEFAULT_SLOTS, common: `content after ${operation}` };
      state.currentDefault = { ...state.currentDefault, revision: "catalog-B" };
      state.baseDefault = state.currentDefault;
      apiMocks.getWorkspaceSystemPrompt.mockResolvedValue(state);
      apiMocks.listWorkspaceSystemPromptVersions.mockResolvedValue({ versions: [version], nextCursor: null });
      await act(async () => { receive({ id: "workspace-1" }, "local", "member"); });
      expect(await screen.findByText(`remote ${operation}`)).toBeInTheDocument();
      await waitFor(() => expect(box).toHaveValue(dirty ? "unsaved local draft" : state.content.common));
      expect(apiMocks.getWorkspaceSystemPrompt).toHaveBeenCalledTimes(index + 2);
      expect(apiMocks.listWorkspaceSystemPromptVersions).toHaveBeenCalledTimes(index + 2);
    }
    if (dirty) {
      fireEvent.click(screen.getByRole("button", { name: "Save new version" }));
      await waitFor(() => expect(apiMocks.updateWorkspaceSystemPrompt).toHaveBeenCalledWith("workspace-1", expect.objectContaining({
        expectedRevision: 0, baseDefaultRevision: makeState().currentDefault.revision, content: { ...DEFAULT_SLOTS, common: "unsaved local draft" },
      })));
    }
  });

  it("enforces the 8,000 Unicode code point limit across all five slots", async () => {
    renderPromptsTab();
    const commonBox = await screen.findByLabelText("General behavior");

    fireEvent.change(commonBox, { target: { value: "x".repeat(8_001) } });

    const totalCounter = screen.getByText(/Total \d+ \/ 8000 code points/);
    expect(totalCounter).toHaveClass("text-destructive");
    expect(commonBox).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Save new version" })).toBeDisabled();
  });

  it("preserves user draft on 409 conflict, allows comparing with server latest, and saves onto the latest revision", async () => {
    const user = userEvent.setup();
    const initialState = makeState({
      document: {
        id: "doc-1",
        key: "system-policy",
        workspaceId: "workspace-1",
        revision: 2,
        currentVersionId: "ver-2",
        mode: "custom",
      },
      content: { ...DEFAULT_SLOTS, common: "Initial custom" },
    });
    const serverLatestState = makeState({
      document: {
        id: "doc-1",
        key: "system-policy",
        workspaceId: "workspace-1",
        revision: 3,
        currentVersionId: "ver-3",
        mode: "custom",
      },
      content: { ...DEFAULT_SLOTS, common: "Server concurrent edit" },
    });

    apiMocks.getWorkspaceSystemPrompt
      .mockResolvedValueOnce(initialState)
      .mockResolvedValueOnce(serverLatestState);

    apiMocks.updateWorkspaceSystemPrompt
      .mockRejectedValueOnce(
        new ApiError("Revision conflict", 409, "Conflict", {
          code: "system_prompt_conflict",
          currentRevision: 3,
        }),
      )
      .mockResolvedValueOnce({
        ...serverLatestState,
        document: { ...serverLatestState.document, revision: 4, currentVersionId: "ver-4" },
        content: { ...DEFAULT_SLOTS, common: "My preserved draft" },
        version: makeVersionDetail(
          makeVersionSummary(4, { isCurrent: true }),
          { ...DEFAULT_SLOTS, common: "My preserved draft" },
        ),
        replayed: false,
      });

    renderPromptsTab();
    const commonBox = await screen.findByLabelText("General behavior");
    await user.clear(commonBox);
    await user.type(commonBox, "My preserved draft");
    await user.click(screen.getByRole("button", { name: "Save new version" }));

    // Draft MUST stay preserved on 409 conflict
    expect(await screen.findByText("System Prompt was updated elsewhere")).toBeInTheDocument();
    expect(screen.getByLabelText("General behavior")).toHaveValue("My preserved draft");

    // Compare local draft with server latest
    await user.click(screen.getByRole("button", { name: "Compare draft with server latest" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Server concurrent edit")).toBeInTheDocument();
    expect(within(dialog).getByText("My preserved draft")).toBeInTheDocument();
    await user.keyboard("{Escape}");

    // Save preserved draft onto latest server revision v3
    await user.click(screen.getByRole("button", { name: "Save my draft onto v3" }));
    await waitFor(() =>
      expect(apiMocks.updateWorkspaceSystemPrompt).toHaveBeenLastCalledWith(
        "workspace-1",
        expect.objectContaining({
          expectedRevision: 3,
          content: { ...DEFAULT_SLOTS, common: "My preserved draft" },
        }),
      ),
    );
  });

  it("shows platform default updated notice when custom is behind latest default and opens comparison", async () => {
    const user = userEvent.setup();
    apiMocks.getWorkspaceSystemPrompt.mockResolvedValue(
      makeState({
        document: {
          id: "doc-1",
          key: "system-policy",
          workspaceId: "workspace-1",
          revision: 2,
          currentVersionId: "ver-2",
          mode: "custom",
        },
        content: { ...DEFAULT_SLOTS, finishing: "Custom finishing note." },
        currentDefault: {
          revision: "default-rev-2222bbbb",
          contentHash: "e".repeat(64),
          content: { ...DEFAULT_SLOTS, finishing: "New platform default finishing." },
        },
        baseDefault: {
          revision: "default-rev-1111aaaa",
          contentHash: "a".repeat(64),
          content: { ...DEFAULT_SLOTS },
        },
        defaultUpdated: true,
      }),
    );

    renderPromptsTab();
    expect(await screen.findByText("Platform built-in default has been updated")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Compare with latest default" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Custom finishing note.")).toBeInTheDocument();
    expect(within(dialog).getByText("New platform default finishing.")).toBeInTheDocument();
  });

  it("resets to platform default while preserving history and leaving workspace appendix untouched", async () => {
    const user = userEvent.setup();
    apiMocks.getWorkspacePromptSettings.mockResolvedValue({
      prompt: "Keep this appendix intact.",
      revision: 5,
      updatedAt: "2026-11-24T10:00:00Z",
      updatedBy: "local",
    });
    apiMocks.getWorkspaceSystemPrompt.mockResolvedValue(
      makeState({
        document: {
          id: "doc-1",
          key: "system-policy",
          workspaceId: "workspace-1",
          revision: 2,
          currentVersionId: "ver-2",
          mode: "custom",
        },
        content: { ...DEFAULT_SLOTS, common: "Custom behavior" },
      }),
    );
    const resetState = makeState({
      document: {
        id: "doc-1",
        key: "system-policy",
        workspaceId: "workspace-1",
        revision: 3,
        currentVersionId: "ver-3",
        mode: "default",
      },
      content: { ...DEFAULT_SLOTS },
    });
    apiMocks.resetWorkspaceSystemPrompt.mockResolvedValue({
      ...resetState,
      version: makeVersionDetail(
        makeVersionSummary(3, { mode: "default", operation: "reset", isCurrent: true }),
        { ...DEFAULT_SLOTS },
      ),
      replayed: false,
    });

    renderPromptsTab();

    // Non-empty appendix is expanded by default
    expect(await screen.findByLabelText("Workspace supplementary prompt")).toHaveValue(
      "Keep this appendix intact.",
    );

    await user.click(screen.getByRole("button", { name: "Reset to default" }));
    const alertDialog = await screen.findByRole("alertdialog");
    expect(
      within(alertDialog).getByText(/Independent workspace supplementary instructions below will not be cleared/),
    ).toBeInTheDocument();
    await user.click(within(alertDialog).getByRole("button", { name: "Reset to default" }));

    await waitFor(() =>
      expect(apiMocks.resetWorkspaceSystemPrompt).toHaveBeenCalledWith(
        "workspace-1",
        expect.objectContaining({
          expectedRevision: 2,
          requestId: expect.any(String),
        }),
      ),
    );
    expect(await screen.findByText("Following platform default (Default)")).toBeInTheDocument();
    expect(screen.getByLabelText("Workspace supplementary prompt")).toHaveValue(
      "Keep this appendix intact.",
    );
  });

  it("renders version history as plain text (XSS-safe), views details, diffs versions, and restores historical reset as new custom version", async () => {
    const user = userEvent.setup();
    const xssPayload = "<script>window.__xss=1</script><img src=x onerror=alert(1)>";
    const v3 = makeVersionSummary(3, {
      mode: "default",
      operation: "reset",
      isCurrent: true,
      changeNote: "Reset back to default",
    });
    const v2 = makeVersionSummary(2, {
      mode: "custom",
      operation: "edit",
      isCurrent: false,
      changeNote: xssPayload,
    });
    const v2Content: SystemPromptSlots = { ...DEFAULT_SLOTS, common: xssPayload };
    const v3Content: SystemPromptSlots = { ...DEFAULT_SLOTS };

    apiMocks.getWorkspaceSystemPrompt.mockResolvedValue(
      makeState({
        document: {
          id: "doc-1",
          key: "system-policy",
          workspaceId: "workspace-1",
          revision: 3,
          currentVersionId: "ver-3",
          mode: "default",
        },
        content: v3Content,
      }),
    );
    apiMocks.listWorkspaceSystemPromptVersions.mockResolvedValue({
      versions: [v3, v2],
      nextCursor: null,
    });
    apiMocks.getWorkspaceSystemPromptVersion.mockImplementation(async (_wsId: string, versionId: string) => {
      if (versionId === "ver-2") return makeVersionDetail(v2, v2Content);
      return makeVersionDetail(v3, v3Content);
    });
    const restoredState = makeState({
      document: {
        id: "doc-1",
        key: "system-policy",
        workspaceId: "workspace-1",
        revision: 4,
        currentVersionId: "ver-4",
        mode: "custom",
      },
      content: v3Content,
    });
    apiMocks.restoreWorkspaceSystemPromptVersion.mockResolvedValue({
      ...restoredState,
      version: makeVersionDetail(
        makeVersionSummary(4, {
          mode: "custom",
          operation: "rollback",
          restoredFromVersionId: "ver-3",
          isCurrent: true,
        }),
        v3Content,
      ),
      replayed: false,
    });

    renderPromptsTab();

    // XSS payload in history changeNote is rendered strictly as plain text
    expect(await screen.findByText(xssPayload)).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();

    // Inspect v2 detail
    const v2Row = document.querySelector<HTMLElement>('[data-version-row="2"]')!;
    await user.click(within(v2Row).getByRole("button", { name: "View" }));
    const detailDialog = await screen.findByRole("dialog");
    expect(within(detailDialog).getByText("Version v2")).toBeInTheDocument();
    expect(within(detailDialog).getAllByText(xssPayload).length).toBeGreaterThanOrEqual(1);
    expect(document.querySelector("script")).toBeNull();
    await user.keyboard("{Escape}");

    // Compare v2 vs v3
    await user.click(screen.getByRole("button", { name: "Compare versions" }));
    const compareDialog = await screen.findByRole("dialog");
    expect(await within(compareDialog).findByText(xssPayload)).toBeInTheDocument();
    await user.keyboard("{Escape}");

    // Restore historical reset/default version v3 -> explicitly warns it creates a Custom version
    const v3Row = document.querySelector<HTMLElement>('[data-version-row="3"]')!;
    await user.click(within(v3Row).getByRole("button", { name: "Restore" }));
    const restoreDialog = await screen.findByRole("alertdialog");
    expect(
      within(restoreDialog).getByText(/pins that exact historical text as a new Custom version/),
    ).toBeInTheDocument();
    await user.click(within(restoreDialog).getByRole("button", { name: "Restore as new version" }));

    await waitFor(() =>
      expect(apiMocks.restoreWorkspaceSystemPromptVersion).toHaveBeenCalledWith(
        "workspace-1",
        expect.objectContaining({
          versionId: "ver-3",
          expectedRevision: 3,
          requestId: expect.any(String),
        }),
      ),
    );
    await waitFor(() => {
      const modeBadge = document.querySelector<HTMLElement>('[data-system-prompt-mode="custom"]');
      expect(modeBadge).not.toBeNull();
      expect(modeBadge).toHaveTextContent("Customized (Custom)");
    });
  });

  it("opens Zone 3 read-only protocols & assembly preview with synthetic disclaimer and copy support", async () => {
    const user = userEvent.setup();
    renderPromptsTab();

    await user.click(await screen.findByRole("button", { name: "Protocols & preview" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Synthetic scenario preview/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Host Runtime Workspace local context/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText("AGENTS.md platform template")).toHaveTextContent(
      "{{issue_description}}",
    );
    expect(within(dialog).getByLabelText("Turn input platform template")).toHaveTextContent(
      "{{current_request}}",
    );

    const [copyInstructions, copyInput] = within(dialog).getAllByRole("button", { name: "Copy" });
    await user.click(copyInstructions!);
    expect(copyText).toHaveBeenLastCalledWith("# Remi notes\n\n{{issue_description}}");
    await user.click(copyInput!);
    expect(copyText).toHaveBeenLastCalledWith("{{current_request}}");
  });

  it("keeps both System Prompt and workspace appendix read-only for regular members", async () => {
    const user = userEvent.setup();
    apiMocks.listMembers.mockResolvedValue([
      {
        id: "mem-1",
        workspace_id: "workspace-1",
        user_id: "local",
        role: "member",
        name: "Regular Member",
        avatar_url: null,
        created_at: "2026-11-24T00:00:00Z",
      },
    ]);
    apiMocks.getWorkspacePromptSettings.mockResolvedValue({
      prompt: "Existing appendix",
      revision: 2,
      updatedAt: null,
      updatedBy: null,
    });

    renderPromptsTab();

    expect(await screen.findByLabelText("General behavior")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save new version" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Reset to default" })).not.toBeInTheDocument();

    const appendixBox = screen.getByLabelText("Workspace supplementary prompt");
    expect(appendixBox).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    // Still allowed to open read-only preview
    await user.click(screen.getByRole("button", { name: "Protocols & preview" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("enforces the 16,002 character limit on Zone 2 workspace supplementary instructions", async () => {
    apiMocks.getWorkspacePromptSettings.mockResolvedValue({
      prompt: "Existing appendix",
      revision: 2,
      updatedAt: null,
      updatedBy: null,
    });
    renderPromptsTab();

    const appendixBox = await screen.findByLabelText("Workspace supplementary prompt");
    fireEvent.change(appendixBox, { target: { value: "x".repeat(16_003) } });

    expect(screen.getByText("16003 / 16002")).toHaveClass("text-destructive");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});
