import type { ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { Agent, CreateSessionRequest, CreateSessionTaskRequest, Session, SessionTask } from "@multiremi/core/types";
import type { SessionLogRow } from "@multiremi/core/api/schemas/session-log";
import type { QuestionView } from "@multiremi/core/api/schemas";
import type { SessionLogListProps } from "../../common/session-log/session-log-list";
import enChat from "../../locales/en/chat.json";
import enIssues from "../../locales/en/issues.json";
import enCommon from "../../locales/en/common.json";
import enMessages from "../../locales/en/messages.json";

const backend = vi.hoisted(() => ({
  sessions: [] as Session[],
  tasks: {} as Record<string, SessionTask[]>,
  rows: {} as Record<string, SessionLogRow[]>,
  listSessions: vi.fn(), listTasks: vi.fn(), createSession: vi.fn(), createTask: vi.fn(),
  listMessages: vi.fn(), sendMessage: vi.fn(), sendChatMessage: vi.fn(), cancelTask: vi.fn(), readLog: vi.fn(), refreshLog: vi.fn(),
  getQuestion: vi.fn(), actOnQuestion: vi.fn(),
}));
const mockToast = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock("@multiremi/core/api", async importOriginal => {
  const actual = await importOriginal<typeof import("@multiremi/core/api")>();
  return { ...actual, api: {
    listChatWorkSessions: backend.listSessions,
    listChatWorkSessionTasks: backend.listTasks,
    createChatWorkSession: backend.createSession,
    createChatWorkSessionTask: backend.createTask,
    sendChatMessage: backend.sendChatMessage,
    listMessages: backend.listMessages,
    sendMessage: backend.sendMessage,
    cancelTaskById: backend.cancelTask,
    getQuestion: backend.getQuestion,
    actOnQuestion: backend.actOnQuestion,
  } };
});
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multiremi/core/paths", async importOriginal => {
  const actual = await importOriginal<typeof import("@multiremi/core/paths")>();
  return { ...actual, useWorkspaceSlug: () => "ws-1", useWorkspacePaths: () => actual.paths.workspace("ws-1") };
});
vi.mock("../../navigation", async importOriginal => {
  const actual = await importOriginal<typeof import("../../navigation")>();
  return { ...actual, AppLink: (props: ComponentProps<"a">) => <a {...props} /> };
});
vi.mock("sonner", () => ({ toast: mockToast }));
vi.mock("@multiremi/core/config", () => ({
  useConfigStore: (select: (state: { cdnDomain: string }) => unknown) => select({ cdnDomain: "" }),
}));
vi.mock("@multiremi/core/session-log/use-issue-log", () => ({
  useIssueLog: (sessionId: string) => {
    backend.readLog(sessionId);
    return {
      replica: {
        window: null,
        getSnapshot: () => ({ entries: backend.rows[sessionId] ?? [] }),
        refreshTailPreservingWindow: backend.refreshLog,
      },
      snapshot: { ready: true },
      error: false,
    };
  },
}));
// Keep filtering and row rendering real; the replica/virtual layout has its own tests.
vi.mock("../../common/session-log/session-log-list", () => ({
  SessionLogList: ({ sessionId, replica, transformEntries, renderEntry, header }: SessionLogListProps) => {
    const entries = replica.getSnapshot(sessionId).entries;
    const visible = transformEntries ? transformEntries(entries) : entries;
    return <div data-testid="work-session-log" data-session-id={sessionId}>
      {header}
      {visible.map(entry => <div key={entry.id}>{renderEntry?.({ entry, reservedHeight: null })}</div>)}
    </div>;
  },
}));
vi.mock("../../common/task-transcript/task-trace-dialog", () => ({
  TaskTraceDialog: ({ task, agentName, onOpenChange }: {
    task: SessionTask; agentName: string; onOpenChange: (open: boolean) => void;
  }) => <div role="dialog" aria-label={`${agentName} trace`}>
    <output data-testid="trace-task">{task.id}</output>
    <button onClick={() => onOpenChange(false)}>Close execution details</button>
  </div>,
}));

import { ChatWorkSessionsDialog } from "./chat-work-sessions-dialog";

const timestamp = "2026-10-08T10:00:00Z";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1", owner_type: "chat", owner_id: "chat-1", chat_id: "chat-1",
    issue_id: null, workspace_id: "ws-1", title: "Main work", status: "active", is_default: true,
    holds_workspace: true, parent_session_id: null, inherit_mode: "none", inherit_cutoff_seq: null,
    inherited_event_count: 0, summary: null, created_by_type: "member", created_by_id: "member-1",
    created_at: timestamp, updated_at: timestamp, participants: [], ...overrides,
  };
}

function makeTask(overrides: Partial<SessionTask> = {}): SessionTask {
  return {
    id: "task-1", agent_id: "agent-1", runtime_id: null, issue_id: null,
    chat_session_id: "chat-1", issue_session_id: "session-1", status: "queued", priority: 0,
    dispatched_at: null, started_at: null, completed_at: null, result: null, error: null,
    created_at: timestamp, ...overrides,
  };
}

function makeRow(overrides: Partial<SessionLogRow> = {}): SessionLogRow {
  return {
    id: "row-1", session_id: "session-1", seq: 1, revision: 1, kind: "message", visibility: "shown",
    author_type: "member", author_id: "member-1", task_id: null, parent_id: null,
    body_md: "Main persisted message", body_html: "<p>Main persisted message</p>", render_version: "1",
    metadata: {}, created_at: timestamp, updated_at: timestamp, deleted_at: null,
    resolved_at: null, resolved_by_type: null, resolved_by_id: null, ...overrides,
  };
}

function makeAgent(id: string, name: string): Agent {
  return {
    id, name, workspace_id: "ws-1", runtime_id: "runtime-1", description: "", instructions: "",
    avatar_url: null, runtime_mode: "local", runtime_config: {}, custom_args: [], visibility: "workspace",
    status: "idle", max_concurrent_tasks: 1, model: "test", owner_id: "member-1", skills: [],
    created_at: timestamp, updated_at: timestamp, archived_at: null, archived_by: null,
  };
}

const agents = [makeAgent("agent-1", "Alpha"), makeAgent("agent-2", "Beta")];
const clients: QueryClient[] = [];

function mount(props: Partial<ComponentProps<typeof ChatWorkSessionsDialog>> = {}) {
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false, staleTime: Infinity }, mutations: { retry: false },
  } });
  clients.push(client);
  return render(<QueryClientProvider client={client}>
    <I18nProvider locale="en" resources={{ en: { chat: enChat, issues: enIssues, common: enCommon, messages: enMessages } }}>
      <ChatWorkSessionsDialog wsId="ws-1" chatId="chat-1" agentId="agent-1" agents={agents}
        chatArchived={false} open={true} onOpenChange={vi.fn()} {...props} />
    </I18nProvider>
  </QueryClientProvider>);
}

beforeEach(() => {
  vi.resetAllMocks();
  backend.sessions = [
    makeSession(),
    makeSession({ id: "session-2", title: "Implementation", is_default: false }),
    makeSession({ id: "session-side", title: "Existing side chat", is_default: false,
      parent_session_id: "session-1", holds_workspace: false, inherit_mode: "snapshot" }),
  ];
  backend.tasks = {};
  backend.rows = {
    "session-1": [makeRow()],
    "session-2": [makeRow({ id: "row-2", session_id: "session-2", body_md: "Implementation message",
      body_html: "<p>Implementation message</p>" })],
  };
  backend.listSessions.mockImplementation(async () => backend.sessions);
  backend.listTasks.mockImplementation(async (_chatId: string, sessionId: string) => backend.tasks[sessionId] ?? []);
  backend.refreshLog.mockResolvedValue(undefined);
  backend.listMessages.mockResolvedValue({ messages: [], next_cursor: null });
  backend.sendMessage.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
});

describe("ChatWorkSessionsDialog", () => {
  it("lists work Sessions and reads tasks and persisted logs for the local selection", async () => {
    mount();
    expect(await screen.findByText("Main persisted message")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: enIssues.detail.main_session })).toHaveAttribute("aria-pressed", "true");
    expect(backend.listSessions).toHaveBeenCalledWith("chat-1");
    expect(backend.listTasks).toHaveBeenCalledWith("chat-1", "session-1");
    expect(backend.readLog).toHaveBeenCalledWith("session-1");

    fireEvent.click(screen.getByRole("button", { name: "Implementation" }));

    expect(await screen.findByText("Implementation message")).toBeInTheDocument();
    expect(screen.queryByText("Main persisted message")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Implementation" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(backend.listTasks).toHaveBeenCalledWith("chat-1", "session-2"));
    expect(backend.readLog).toHaveBeenCalledWith("session-2");
    expect(backend.sendChatMessage).not.toHaveBeenCalled();
  });

  it("creates a work Session from the empty state and selects it after success", async () => {
    backend.sessions = [];
    let resolveCreation!: (session: Session) => void;
    backend.createSession.mockReturnValueOnce(new Promise<Session>(resolve => { resolveCreation = resolve; }));
    mount();
    expect(await screen.findByText(enChat.work_sessions.empty)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    fireEvent.change(await screen.findByLabelText("Session name"), { target: { value: "  Implementation  " } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(backend.createSession).toHaveBeenCalledWith("chat-1", {
      title: "Implementation", holds_workspace: true,
    }));
    expect(screen.getByLabelText("Session name")).toHaveValue("  Implementation  ");
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    expect(backend.listTasks).not.toHaveBeenCalled();
    const created = makeSession({ id: "created", title: "Implementation", is_default: false });
    backend.sessions = [created];
    await act(async () => resolveCreation(created));

    await waitFor(() => expect(screen.queryByLabelText("Session name")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Implementation" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("work-session-log")).toHaveAttribute("data-session-id", "created");
    await waitFor(() => expect(backend.listTasks).toHaveBeenCalledWith("chat-1", "created"));
  });

  it("creates a discussion with the chosen root Chat Session as its parent", async () => {
    backend.createSession.mockImplementationOnce(async (_chatId: string, input: CreateSessionRequest) => {
      const created = makeSession({ id: "review", title: input.title, is_default: false, holds_workspace: false,
        parent_session_id: input.parent_session_id ?? null, inherit_mode: "snapshot" });
      backend.sessions = [...backend.sessions, created];
      return created;
    });
    mount();
    await screen.findByLabelText("Task instructions");
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    fireEvent.change(await screen.findByLabelText("Session name"), { target: { value: "Review" } });
    fireEvent.click(screen.getByRole("button", { name: "Discussion" }));
    const inherit = screen.getByRole("combobox", { name: "Inherit from" });
    expect(inherit).toHaveValue("session-1");
    expect(screen.getByRole("option", { name: "Implementation" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Existing side chat" })).not.toBeInTheDocument();
    fireEvent.change(inherit, { target: { value: "session-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(backend.createSession).toHaveBeenCalledWith("chat-1", {
      title: "Review", holds_workspace: false, parent_session_id: "session-2",
    }));
    await waitFor(() => expect(screen.getByTestId("work-session-log")).toHaveAttribute("data-session-id", "review"));
    expect(screen.getByRole("button", { name: "Review" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "Side chat" })).not.toBeInTheDocument();
  });

  it("opens Side chat as a discussion inheriting from the selected root Session", async () => {
    backend.createSession.mockRejectedValueOnce(new Error("Creation unavailable"));
    mount();
    await screen.findByLabelText("Task instructions");
    fireEvent.click(screen.getByRole("button", { name: "Implementation" }));
    fireEvent.click(screen.getByRole("button", { name: "Side chat" }));
    fireEvent.change(await screen.findByLabelText("Session name"), { target: { value: "Review this branch" } });
    expect(screen.getByRole("button", { name: "Work" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Discussion" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("combobox", { name: "Inherit from" })).toHaveValue("session-2");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("Creation unavailable"));
    expect(backend.createSession).toHaveBeenCalledWith("chat-1", {
      title: "Review this branch", holds_workspace: false, parent_session_id: "session-2",
    });
    expect(screen.getByLabelText("Session name")).toHaveValue("Review this branch");
    expect(screen.getByRole("combobox", { name: "Inherit from" })).toHaveValue("session-2");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("button", { name: "Implementation" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("work-session-log")).toHaveAttribute("data-session-id", "session-2");
  });

  it("delegates an explicit SessionTask to the selected agent and clears only a successful prompt", async () => {
    backend.createTask.mockImplementationOnce(async (_chatId: string, sessionId: string, input: CreateSessionTaskRequest) => {
      const task = makeTask({ issue_session_id: sessionId, agent_id: input.agent_id });
      backend.tasks[sessionId] = [task];
      return task;
    });
    mount();
    const prompt = await screen.findByLabelText("Task instructions");
    fireEvent.change(prompt, { target: { value: "  Investigate the failing build  " } });
    fireEvent.change(screen.getByRole("combobox", { name: "Task agent" }), { target: { value: "agent-2" } });
    expect(backend.createTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delegate task" }));

    await waitFor(() => expect(backend.createTask).toHaveBeenCalledWith("chat-1", "session-1", {
      agent_id: "agent-2", prompt: "Investigate the failing build",
    }));
    await waitFor(() => expect(prompt).toHaveValue(""));
    expect(await screen.findByText("Beta · Queued")).toBeInTheDocument();
    expect(backend.refreshLog).toHaveBeenCalledTimes(1);
    expect(backend.sendChatMessage).not.toHaveBeenCalled();
  });

  it("preserves the task prompt and selected Session after a rejected delegation", async () => {
    backend.createTask.mockRejectedValueOnce(new Error("No runtime available"));
    mount();
    await screen.findByLabelText("Task instructions");
    fireEvent.click(screen.getByRole("button", { name: "Implementation" }));
    const prompt = screen.getByLabelText("Task instructions");
    fireEvent.change(prompt, { target: { value: "Retry the build here" } });
    fireEvent.click(screen.getByRole("button", { name: "Delegate task" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("No runtime available");
    expect(backend.createTask).toHaveBeenCalledWith("chat-1", "session-2", {
      agent_id: "agent-1", prompt: "Retry the build here",
    });
    expect(prompt).toHaveValue("Retry the build here");
    expect(screen.getByRole("button", { name: "Implementation" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("work-session-log")).toHaveAttribute("data-session-id", "session-2");
    expect(screen.getByRole("button", { name: "Delegate task" })).toBeEnabled();
    expect(backend.refreshLog).not.toHaveBeenCalled();
    expect(backend.sendChatMessage).not.toHaveBeenCalled();
  });

  it("renders persisted terminal results and agent messages with the matching task trace entry", async () => {
    backend.tasks["session-1"] = [
      makeTask({ id: "completed-task", status: "completed", completed_at: timestamp }),
      makeTask({ id: "failed-task", status: "failed", error: "Provider rejected the request", completed_at: timestamp }),
      makeTask({ id: "cancelled-task", status: "cancelled", completed_at: timestamp }),
    ];
    backend.rows["session-1"] = [
      makeRow({ id: "completed-row", kind: "turn", task_id: "completed-task", body_md: "Original delegation",
        body_html: "<p>Original delegation</p>", metadata: { final_reply_md: "Saved final build result" } }),
      makeRow({ id: "failed-row", seq: 2, kind: "turn", task_id: "failed-task",
        body_md: "Persisted execution failure", body_html: "<p>Persisted execution failure</p>" }),
      makeRow({ id: "cancelled-row", seq: 3, kind: "turn", task_id: "cancelled-task",
        body_md: "Cancelled work remains readable", body_html: "<p>Cancelled work remains readable</p>" }),
      makeRow({ id: "agent-row", seq: 4, author_type: "agent", author_id: "agent-1",
        body_md: "Agent progress note", body_html: "<p>Agent progress note</p>" }),
      makeRow({ id: "envelope-row", seq: 5, metadata: { envelope: true },
        body_md: "Internal envelope", body_html: "<p>Internal envelope</p>" }),
    ];
    mount();

    expect(await screen.findByText("Saved final build result")).toBeInTheDocument();
    expect(screen.queryByText("Original delegation")).not.toBeInTheDocument();
    expect(screen.getByText("Persisted execution failure")).toBeInTheDocument();
    expect(screen.getByText("Cancelled work remains readable")).toBeInTheDocument();
    expect(screen.getByText("Agent progress note")).toBeInTheDocument();
    expect(screen.queryByText("Internal envelope")).not.toBeInTheDocument();
    expect(await screen.findByText("Provider rejected the request")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Alpha · Completed · Execution details" }));
    expect(screen.getByTestId("trace-task")).toHaveTextContent("completed-task");
    fireEvent.click(screen.getByRole("button", { name: "Close execution details" }));
    expect(screen.queryByTestId("trace-task")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Alpha · Failed · Execution details" }));
    expect(screen.getByTestId("trace-task")).toHaveTextContent("failed-task");
    expect(backend.sendChatMessage).not.toHaveBeenCalled();
  });

  it("renders a persisted final message once and keeps its completed turn prompt readable", async () => {
    backend.tasks["session-1"] = [makeTask({ status: "completed", completed_at: timestamp })];
    backend.rows["session-1"] = [
      makeRow({ id: "turn-1", kind: "turn", task_id: "task-1", body_md: "Investigate the build failure",
        body_html: "<p>Investigate the build failure</p>",
        metadata: { final_entry_id: "reply-1", final_reply_md: "single final result" } }),
      makeRow({ id: "reply-1", seq: 2, author_type: "agent", author_id: "agent-1", task_id: "task-1",
        body_md: "single final result", body_html: "<p>single final result</p>" }),
    ];
    mount();

    expect(await screen.findByText("Investigate the build failure")).toBeInTheDocument();
    expect(screen.getAllByText("single final result")).toHaveLength(1);
    expect(await screen.findByRole("button", { name: "Alpha · Completed · Execution details" })).toBeInTheDocument();
  });

  it("keeps canonical messages carrying envelope metadata and omits deleted bodies", async () => {
    backend.rows["session-1"] = [
      makeRow({ id: "canonical", message_kind: "request", sender_type: "member", metadata: { envelope: { recipient: "agent-1" } }, body_md: "Canonical work message", body_html: null }),
      makeRow({ id: "deleted", deleted_at: timestamp, body_md: "Deleted private body", body_html: null }),
      makeRow({ id: "hidden", visibility: "hidden", body_md: "Hidden private body", body_html: null }),
    ];
    mount();
    expect(await screen.findByText("Canonical work message")).toBeInTheDocument();
    expect(screen.queryByText("Deleted private body")).not.toBeInTheDocument();
    expect(screen.queryByText("Hidden private body")).not.toBeInTheDocument();
  });

  it("answers a paused work turn in its actual Session instead of the owning Chat", async () => {
    backend.tasks["session-1"] = [makeTask({ status: "awaiting_human", turn_id: "turn-1" })];
    const request = { kind: "permission", payload: { tool_call: { title: "Run scoped build" }, options: [{ optionId: "allow", kind: "allow_once", name: "Allow once" }] } };
    backend.listMessages.mockResolvedValue({ messages: [{ id: "decision-1", task_id: "turn-1", created_at: timestamp, resolved_at: null, metadata: { human_request: request } }], next_cursor: null });
    const question: QuestionView = {
      id: "decision-1", kind: "permission", session_id: "session-1", workspace_id: "ws-1",
      source_issue_id: null, source_agent_id: "agent-1", source_turn_id: "turn-1", source_attempt_id: "task-1",
      original_questions: [], original_message: "Run scoped build", original_context: null,
      options: [{ label: "Allow once", value: "allow" }], summary: null,
      current_handler: { type: "member", id: "member-1" }, stage: "human", route_revision: 7,
      answer_revision: 0, status: "pending", wait_status: "waiting", wait_reason: null, answer: null,
      history: [{ type: "created", actor: null, at: timestamp, route_revision: 7 }], actions: { allowed: ["answer"] },
    };
    backend.getQuestion.mockResolvedValue(question);
    const answered: QuestionView = {
      ...question, status: "answered", answer_revision: 1, actions: { allowed: [] },
      answer: { response: { option_id: "allow" }, body_md: "Allow once", actor: { type: "member", id: "member-1" },
        at: timestamp, reply_message_id: "answer-1" },
    };
    backend.actOnQuestion.mockResolvedValue(answered);

    mount();
    const viewQuestion = await screen.findByRole("button", { name: "View question" });
    expect(backend.getQuestion).not.toHaveBeenCalled();
    fireEvent.click(viewQuestion);
    fireEvent.click(await screen.findByRole("button", { name: "Allow once" }));
    fireEvent.click(screen.getByRole("button", { name: /History and details/ }));
    expect(screen.getByRole("link", { name: "Source · session-1" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Source · chat-1" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));

    await waitFor(() => expect(backend.actOnQuestion).toHaveBeenCalledWith("decision-1", "answer", expect.objectContaining({
      expected_route_revision: 7, response: { option_id: "allow" },
    })));
    expect(backend.listMessages).toHaveBeenCalledWith("session-1", { message_kind: "decision", cursor: undefined });
    expect(backend.listMessages).not.toHaveBeenCalledWith("chat-1", expect.anything());
    expect(backend.getQuestion).toHaveBeenCalledWith("decision-1");
    await expect(backend.getQuestion.mock.results[0]?.value).resolves.toMatchObject({ session_id: "session-1", source_turn_id: "turn-1" });
    expect(backend.sendMessage).not.toHaveBeenCalled();
    expect(backend.sendChatMessage).not.toHaveBeenCalled();
  });

  it.each(["chat", "session"] as const)("disables task submission for an archived %s", async archived => {
    if (archived === "session") backend.sessions = [makeSession({ status: "archived" })];
    mount({ chatArchived: archived === "chat" });

    expect(await screen.findByLabelText("Task instructions")).toBeDisabled();
    const create = screen.getByRole("button", { name: "New session" });
    if (archived === "chat") expect(create).toBeDisabled();
    else expect(create).toBeEnabled();
    expect(screen.getByRole("button", { name: "Delegate task" })).toBeDisabled();
    expect(screen.getByText(enChat.work_sessions.archived_hint)).toBeInTheDocument();
    expect(backend.createSession).not.toHaveBeenCalled();
    expect(backend.createTask).not.toHaveBeenCalled();
  });
});
