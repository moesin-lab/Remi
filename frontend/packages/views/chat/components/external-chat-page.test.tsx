import type { ReactNode } from "react";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import { ApiError } from "@multiremi/core/api";
import type { ExternalChatHistory, ExternalChatProject, ExternalChatSource, ExternalChatSummary } from "@multiremi/core/chat";
import { externalChatReceiptStorageKey } from "@multiremi/core/chat";
import { defaultSessionStorage } from "@multiremi/core/platform";
import enChat from "../../locales/en/chat.json";
import enRuntimes from "../../locales/en/runtimes.json";

const backend = vi.hoisted(() => ({
  listRuntimes: vi.fn(), listExternalChatCatalog: vi.fn(), listExternalChats: vi.fn(), getExternalChatHistory: vi.fn(),
  sendExternalChatMessage: vi.fn(), getExternalChatReceipt: vi.fn(), interruptExternalChatTurn: vi.fn(), respondExternalChatRequest: vi.fn(),
  createChatSession: vi.fn(), listChatSessions: vi.fn(), sendChatMessage: vi.fn(), markChatSessionRead: vi.fn(), getSessionLog: vi.fn(), listAgents: vi.fn(), listProjects: vi.fn(),
}));
const navigation = vi.hoisted(() => ({ searchParams: new URLSearchParams(), replace: vi.fn(), select: vi.fn(), agent: vi.fn() }));
vi.mock("@multiremi/core/api", async original => ({ ...await original<typeof import("@multiremi/core/api")>(), api: backend }));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws" }));
vi.mock("@multiremi/core/paths", async original => {
  const actual = await original<typeof import("@multiremi/core/paths")>();
  return { ...actual, useWorkspacePaths: () => actual.paths.workspace("demo") };
});
vi.mock("@multiremi/core/chat", async original => ({
  ...await original<typeof import("@multiremi/core/chat")>(),
  useChatStore: Object.assign(vi.fn(), { getState: () => ({ setActiveSession: navigation.select, setSelectedAgentId: navigation.agent }) }),
}));
vi.mock("../../navigation", () => ({
  useNavigation: () => navigation,
  AppLink: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock("../../layout/page-header", () => ({ PageHeader: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("./chat-window", () => ({ ChatWindow: () => <div data-testid="remi-window" /> }));
import { ChatPage } from "./chat-page";
import { ExternalChatPage } from "./external-chat-page";
import { ExternalChatWindow } from "./external-chat-window";

const runtime = { id: "rt", name: "Codex", provider: "codex", workspace_id: "ws", daemon_id: "daemon", daemon_display_name: "Lab Mac", runtime_mode: "local", launch_header: "", status: "online", device_info: "macOS", metadata: { external_chats: 1 }, owner_id: "local", visibility: "private", last_seen_at: "now", created_at: "now", updated_at: "now" };
const project: ExternalChatProject = { id: "native:project", kind: "native", name: "Original native project", roots: ["/work/project", "/work/second-root"], readonly: true };
const source: ExternalChatSource = { id: "source", name: "Original Codex", home: "/home/user/.codex", provider: "codex", connection: "isolated", projects: [project] };
const chat: ExternalChatSummary = { id: "thread", source_id: "source", project_id: project.id, native_project_id: "native-id", title: "Original thread", cwd: "/work/project", created_at: 1, updated_at: 2, status: "idle", model: "original-model", model_provider: "original-provider", reasoning_effort: "high", readonly: true };
function history(patch: Partial<ExternalChatHistory> = {}): ExternalChatHistory {
  return { chat, turns: [{ id: "old-turn", status: "completed", items: [{ id: "original-item", type: "agentMessage", role: "assistant", text: "Original native history" }] }], requests: [], next_cursor: null, ...patch };
}
const clients: QueryClient[] = [];
function show(component: ReactNode = <ChatPage />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  const wrap = (child: ReactNode) => <I18nProvider locale="en" resources={{ en: { chat: enChat, runtimes: enRuntimes } }}><QueryClientProvider client={client}>{child}</QueryClientProvider></I18nProvider>;
  const view = render(wrap(component));
  return { ...view, client, update: (next: ReactNode) => view.rerender(wrap(next)) };
}
function WindowHarness({ initialDraft = "" }: { initialDraft?: string }) {
  const [draft, setDraft] = useState(initialDraft);
  return <ExternalChatWindow ws="ws" runtime="rt" source="source" thread="thread" online draft={draft} onDraftChange={setDraft} />;
}

beforeEach(() => {
  vi.resetAllMocks();
  window.sessionStorage.clear();
  navigation.searchParams = new URLSearchParams({ kind: "external", external_runtime: "rt", external_source: "source", external_thread: "thread" });
  navigation.replace.mockImplementation(url => { navigation.searchParams = new URLSearchParams(String(url).split("?")[1]); });
  backend.listRuntimes.mockResolvedValue([runtime]);
  backend.listExternalChatCatalog.mockResolvedValue({ sources: [source], warnings: [] });
  backend.listExternalChats.mockResolvedValue({ chats: [chat], projects: [project], next_cursor: null });
  backend.getExternalChatHistory.mockResolvedValue(history());
  backend.interruptExternalChatTurn.mockResolvedValue({ accepted: true });
  backend.respondExternalChatRequest.mockResolvedValue({ accepted: true });
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); window.sessionStorage.clear(); });

it("deep-links to native history while keeping source Project and config read-only and never invoking Remi Chat APIs", async () => {
  navigation.searchParams.set("session", "remi-must-not-open");
  show();
  expect(await screen.findByText("Original native history")).toBeInTheDocument();
  expect(screen.queryByTestId("remi-window")).not.toBeInTheDocument();
  expect(screen.getByText("original-model")).toBeInTheDocument();
  expect(screen.getByText("original-provider")).toBeInTheDocument();
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Search source projects" }));
  await user.click(await screen.findByRole("option", { name: "Original native project" }));
  expect(screen.getByText("Original native project")).toBeInTheDocument();
  expect(screen.getByText("/work/second-root")).toBeInTheDocument();
  expect(screen.getByText("Native project · Read-only")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Remi" })).toHaveAttribute("href", "/demo/chat");
  expect(navigation.select).not.toHaveBeenCalled();
  expect(navigation.agent).not.toHaveBeenCalled();
  for (const name of ["createChatSession", "listChatSessions", "sendChatMessage", "markChatSessionRead", "getSessionLog", "listAgents", "listProjects"] as const) expect(backend[name]).not.toHaveBeenCalled();
  expect(backend.sendExternalChatMessage).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: /Edit|Archive|Delete|Rename/ })).not.toBeInTheDocument();
});

it("keeps the existing Remi selection when switching to an external chat and returning", async () => {
  navigation.searchParams = new URLSearchParams({ session: "remi-original" });
  const view = show();
  expect(navigation.select).toHaveBeenCalledWith("remi-original");
  navigation.select.mockClear();
  navigation.searchParams = new URLSearchParams({ kind: "external", external_runtime: "rt", external_source: "source", external_thread: "thread" });
  view.update(<ChatPage />);
  await screen.findByText("Original native history");
  expect(navigation.select).not.toHaveBeenCalled();
  navigation.searchParams = new URLSearchParams();
  view.update(<ChatPage />);
  expect(screen.getByTestId("remi-window")).toBeInTheDocument();
  expect(navigation.select).not.toHaveBeenCalled();
});

it("pages and sorts native chats, filters by source project, and retains native selection in the URL", async () => {
  backend.listExternalChats.mockResolvedValueOnce({ chats: [{ ...chat, id: "older", title: "Older thread", updated_at: 1 }], projects: [project], next_cursor: "next-page" })
    .mockResolvedValue({ chats: [{ ...chat, id: "newer", title: "Newer thread", updated_at: 4 }], projects: [{ ...project, id: "directory:root", kind: "directory", name: "Discovered project" }], next_cursor: null });
  const user = userEvent.setup();
  const view = show(<ExternalChatPage />);
  await user.click(await screen.findByRole("button", { name: "Load more chats" }));
  const newer = await screen.findByRole("button", { name: /Newer thread/ });
  expect(newer.compareDocumentPosition(screen.getByRole("button", { name: /Older thread/ })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(backend.listExternalChats).toHaveBeenCalledWith("rt", "source", expect.objectContaining({ cursor: "next-page", limit: 50 }));
  await user.click(screen.getByRole("combobox", { name: "Search source projects" }));
  await user.click(await screen.findByRole("option", { name: "Discovered project" }));
  expect(screen.getByText("Discovered by directory · Read-only")).toBeInTheDocument();
  await user.click(screen.getByRole("combobox", { name: "Search source projects" }));
  await user.clear(screen.getByRole("combobox", { name: "Search source projects" }));
  await user.click(await screen.findByRole("option", { name: "Original native project" }));
  await waitFor(() => expect(backend.listExternalChats).toHaveBeenCalledWith("rt", "source", expect.objectContaining({ project_id: project.id })));
  await user.click(screen.getByRole("button", { name: /Newer thread/ }));
  expect(navigation.replace).toHaveBeenCalledWith("/demo/chat?kind=external&external_runtime=rt&external_source=source&external_thread=newer");
  view.update(<ExternalChatPage />);
  await waitFor(() => expect(backend.getExternalChatHistory).toHaveBeenCalledWith("rt", "source", "newer", expect.any(Object)));
});

it("keeps chats directly after a searchable Project selector even with hundreds of source projects", async () => {
  const projects: ExternalChatProject[] = Array.from({ length: 500 }, (_, index) => ({
    id: `directory:${index}`, kind: "directory", name: `Worktree ${index}`, roots: [`/worktrees/root-${index}`, `/worktrees/extra-${index}`], readonly: true,
  }));
  backend.listExternalChatCatalog.mockResolvedValue({ sources: [{ ...source, projects }], warnings: [] });
  backend.listExternalChats.mockResolvedValue({ chats: [chat], projects, next_cursor: null });
  const user = userEvent.setup();
  show(<ExternalChatPage />);
  const firstChat = await screen.findByRole("button", { name: /Original thread/ });
  const picker = screen.getByRole("combobox", { name: "Search source projects" });
  expect(picker).toHaveValue("All projects");
  expect(firstChat.previousElementSibling).toContainElement(picker);
  expect(screen.queryByText("Worktree 499")).not.toBeInTheDocument();
  expect(screen.queryByText("/worktrees/root-499")).not.toBeInTheDocument();
  expect(screen.queryAllByRole("option")).toHaveLength(0);

  await user.clear(picker);
  await user.type(picker, "Worktree 499");
  expect(picker).toHaveValue("Worktree 499");
  await user.click(await screen.findByRole("option", { name: "Worktree 499" }));
  expect(screen.getByText("Discovered by directory · Read-only")).toBeInTheDocument();
  expect(screen.getByText("/worktrees/root-499")).toBeInTheDocument();
  expect(screen.getByText("/worktrees/extra-499")).toBeInTheDocument();
  expect(screen.queryByText("/worktrees/root-0")).not.toBeInTheDocument();
  await waitFor(() => expect(backend.listExternalChats).toHaveBeenCalledWith("rt", "source", expect.objectContaining({ project_id: "directory:499" })));
  expect(backend.listProjects).not.toHaveBeenCalled();
});

it("distinguishes native source errors, empty results, offline runtimes and older unsupported runtimes", async () => {
  backend.listExternalChatCatalog.mockRejectedValueOnce(new Error("Cannot read source"));
  backend.listExternalChatCatalog.mockResolvedValue({ sources: [], warnings: [] });
  const user = userEvent.setup();
  const first = show();
  await user.click(await screen.findByRole("button", { name: "Retry" }));
  expect(await screen.findByText("No native Codex sources found.")).toBeInTheDocument();
  first.unmount();
  backend.listExternalChatCatalog.mockClear();
  backend.listRuntimes.mockResolvedValue([{ ...runtime, status: "offline" }]);
  const second = show();
  expect(await screen.findAllByText(/source Runtime is offline/)).not.toHaveLength(0);
  expect(backend.listExternalChatCatalog).not.toHaveBeenCalled();
  second.unmount();
  backend.listRuntimes.mockResolvedValue([{ ...runtime, metadata: {} }]);
  show();
  expect(await screen.findByText("Update this Runtime to browse external chats.")).toBeInTheDocument();
  expect(backend.listExternalChatCatalog).not.toHaveBeenCalled();
});

it("continues the same native thread with unchanged text and a UUID, without adding source configuration", async () => {
  backend.sendExternalChatMessage.mockImplementation((_runtime, _source, thread, input) => Promise.resolve({ request_id: input.request_id, thread_id: thread, turn_id: "native-turn", outcome: "accepted" }));
  const user = userEvent.setup();
  show(<WindowHarness />);
  await screen.findByText("Original native history");
  fireEvent.change(screen.getByRole("textbox", { name: "Message this native chat" }), { target: { value: "\nKeep the original context\n" } });
  await user.click(screen.getByRole("button", { name: "Continue this chat" }));
  await waitFor(() => expect(backend.sendExternalChatMessage).toHaveBeenCalledTimes(1));
  const input = backend.sendExternalChatMessage.mock.calls[0]?.[3];
  expect(backend.sendExternalChatMessage).toHaveBeenCalledWith("rt", "source", "thread", { text: "\nKeep the original context\n", request_id: expect.any(String) });
  expect(input.request_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(screen.getByRole("textbox", { name: "Message this native chat" })).toHaveValue("");
  expect(screen.getByRole("button", { name: "Continue this chat" })).toBeDisabled();
});

it("keeps unknown send outcomes blocked, reads the receipt, and never replays the POST", async () => {
  backend.sendExternalChatMessage.mockRejectedValue(new ApiError("Reply lost", 504, "Timeout", { error: "Reply lost", code: "TIMEOUT", outcome: "unknown" }));
  backend.getExternalChatReceipt.mockImplementation((_runtime, _source, thread, request_id) => Promise.resolve({ request_id, thread_id: thread, turn_id: null, outcome: "unknown" }));
  const user = userEvent.setup();
  const view = show(<WindowHarness />);
  await screen.findByText("Original native history");
  await user.type(screen.getByRole("textbox", { name: "Message this native chat" }), "Do not duplicate");
  await user.click(screen.getByRole("button", { name: "Continue this chat" }));
  expect(await screen.findByText(/Send outcome is unknown/)).toBeInTheDocument();
  await waitFor(() => expect(backend.getExternalChatReceipt).toHaveBeenCalled());
  expect(screen.getByRole("textbox", { name: "Message this native chat" })).toHaveValue("Do not duplicate");
  expect(screen.getByRole("button", { name: "Continue this chat" })).toBeDisabled();
  expect(backend.sendExternalChatMessage).toHaveBeenCalledTimes(1);
  backend.getExternalChatReceipt.mockImplementation((_runtime, _source, thread, request_id) => Promise.resolve({ request_id, thread_id: thread, turn_id: "new-turn", outcome: "accepted" }));
  await act(() => view.client.invalidateQueries({ queryKey: ["external-chat", "ws", "rt", "source", "receipt"] }));
  await waitFor(() => expect(screen.queryByText(/Send outcome is unknown/)).not.toBeInTheDocument());
  expect(screen.getByRole("textbox", { name: "Message this native chat" })).toHaveValue("");
  expect(backend.sendExternalChatMessage).toHaveBeenCalledTimes(1);
});

it("restores the unknown request after reload with a fresh QueryClient and only GETs its receipt", async () => {
  const key = externalChatReceiptStorageKey("ws", "rt", "source", "thread");
  backend.sendExternalChatMessage.mockImplementation((_runtime, _source, thread, input) => {
    expect(JSON.parse(window.sessionStorage.getItem(key)!)).toEqual({ request_id: input.request_id, thread_id: thread, turn_id: null, outcome: "unknown" });
    return Promise.reject(new TypeError("Native response lost"));
  });
  backend.getExternalChatReceipt.mockImplementation((_runtime, _source, thread, request_id) => Promise.resolve({ request_id, thread_id: thread, turn_id: null, outcome: "unknown" }));
  const user = userEvent.setup();
  const first = show(<WindowHarness initialDraft="Original private message" />);
  await screen.findByText("Original native history");
  await user.click(screen.getByRole("button", { name: "Continue this chat" }));
  await screen.findByText(/Send outcome is unknown/);
  const requestId = backend.sendExternalChatMessage.mock.calls[0]![3].request_id;
  expect(window.sessionStorage.getItem(key)).not.toContain("Original private message");
  first.unmount();
  first.client.clear();
  backend.getExternalChatReceipt.mockClear();

  const reloaded = show(<WindowHarness initialDraft="A new draft after reload" />);
  expect(reloaded.client).not.toBe(first.client);
  await screen.findByText("Original native history");
  expect(screen.getByRole("button", { name: "Continue this chat" })).toBeDisabled();
  await waitFor(() => expect(backend.getExternalChatReceipt).toHaveBeenCalledWith("rt", "source", "thread", requestId));
  expect(backend.sendExternalChatMessage).toHaveBeenCalledTimes(1);
  backend.getExternalChatReceipt.mockResolvedValue({ request_id: requestId, thread_id: "thread", turn_id: "confirmed-turn", outcome: "accepted" });
  backend.getExternalChatHistory.mockResolvedValue(history({ turns: [{ id: "confirmed-turn", status: "completed", items: [] }] }));
  await user.click(screen.getByRole("button", { name: "Check receipt" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Continue this chat" })).toBeEnabled());
  expect(screen.getByRole("textbox", { name: "Message this native chat" })).toHaveValue("A new draft after reload");
  expect(JSON.parse(window.sessionStorage.getItem(key)!)).toEqual({ request_id: requestId, thread_id: "thread", turn_id: "confirmed-turn", outcome: "accepted" });
  expect(backend.sendExternalChatMessage).toHaveBeenCalledTimes(1);
  expect(backend.sendChatMessage).not.toHaveBeenCalled();
});

it("retains the unknown send gate in memory and explains the reload limitation when storage is denied", async () => {
  vi.spyOn(defaultSessionStorage, "setItem").mockImplementation(() => { throw new Error("Storage denied"); });
  backend.sendExternalChatMessage.mockRejectedValue(new TypeError("Native response lost"));
  backend.getExternalChatReceipt.mockImplementation((_runtime, _source, thread, request_id) => Promise.resolve({ request_id, thread_id: thread, turn_id: null, outcome: "unknown" }));
  const user = userEvent.setup();
  show(<WindowHarness initialDraft="Track in memory" />);
  await screen.findByText("Original native history");
  await user.click(screen.getByRole("button", { name: "Continue this chat" }));
  expect(await screen.findByText(/Send receipts cannot be saved in this tab/)).toBeInTheDocument();
  await screen.findByText(/Send outcome is unknown/);
  expect(screen.getByRole("button", { name: "Continue this chat" })).toBeDisabled();
  expect(screen.getByRole("textbox", { name: "Message this native chat" })).toHaveValue("Track in memory");
  expect(backend.sendExternalChatMessage).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(backend.getExternalChatReceipt).toHaveBeenCalled());
});

it("disables new native turns while busy, and interrupts only the known native turn", async () => {
  backend.getExternalChatHistory.mockResolvedValue(history({ chat: { ...chat, status: "active" }, turns: [{ id: "running-native", status: "inProgress", items: [] }] }));
  const user = userEvent.setup();
  show(<WindowHarness />);
  expect(await screen.findByText(/This native chat is running/)).toBeInTheDocument();
  expect(screen.getByText(/Requests not attached/)).toBeInTheDocument();
  await user.type(screen.getByRole("textbox", { name: "Message this native chat" }), "Wait for this turn");
  expect(screen.getByRole("button", { name: "Continue this chat" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Stop native turn" }));
  await waitFor(() => expect(backend.interruptExternalChatTurn).toHaveBeenCalledWith("rt", "source", "thread", "running-native"));
  expect(backend.sendExternalChatMessage).not.toHaveBeenCalled();
});

it("keeps explicitly rejected text and newer edits when an uncertain receipt later confirms the original send", async () => {
  backend.sendExternalChatMessage.mockRejectedValueOnce(new ApiError("Busy", 409, "Conflict", { error: "Busy", code: "BUSY" }))
    .mockRejectedValueOnce(new TypeError("Acknowledgement lost"));
  backend.getExternalChatReceipt.mockImplementation((_runtime, _source, thread, request_id) => Promise.resolve({ request_id, thread_id: thread, turn_id: null, outcome: "unknown" }));
  const user = userEvent.setup();
  const view = show(<WindowHarness />);
  await screen.findByText("Original native history");
  const input = screen.getByRole("textbox", { name: "Message this native chat" });
  await user.type(input, "Original message");
  await user.click(screen.getByRole("button", { name: "Continue this chat" }));
  expect(await screen.findByText("Message was rejected. Your draft is retained.")).toBeInTheDocument();
  expect(input).toHaveValue("Original message");
  expect(backend.sendExternalChatMessage).toHaveBeenCalledTimes(1);
  expect(backend.getExternalChatReceipt).not.toHaveBeenCalled();
  expect(window.sessionStorage.getItem(externalChatReceiptStorageKey("ws", "rt", "source", "thread"))).toBeNull();
  await user.click(screen.getByRole("button", { name: "Continue this chat" }));
  await screen.findByText(/Send outcome is unknown/);
  await user.type(input, " plus next message");
  backend.getExternalChatReceipt.mockImplementation((_runtime, _source, thread, request_id) => Promise.resolve({ request_id, thread_id: thread, turn_id: "new-turn", outcome: "accepted" }));
  await act(() => view.client.invalidateQueries({ queryKey: ["external-chat", "ws", "rt", "source", "receipt"] }));
  await waitFor(() => expect(screen.queryByText(/Send outcome is unknown/)).not.toBeInTheDocument());
  expect(input).toHaveValue("Original message plus next message");
  expect(backend.sendExternalChatMessage).toHaveBeenCalledTimes(2);
});

it("prepends older turns while preserving newer native item and status updates without duplicate items", async () => {
  backend.getExternalChatHistory.mockResolvedValueOnce(history({ next_cursor: "older", turns: [{ id: "same-turn", status: "completed", items: [{ id: "same-item", type: "agentMessage", role: "assistant", text: "Updated answer" }] }] }))
    .mockResolvedValue(history({ turns: [{ id: "same-turn", status: "inProgress", items: [{ id: "earlier-item", type: "userMessage", role: "user", text: "Earlier input" }, { id: "same-item", type: "agentMessage", role: "assistant", text: "Stale answer" }] }] }));
  const user = userEvent.setup();
  show(<WindowHarness />);
  await user.click(await screen.findByRole("button", { name: "Load earlier turns" }));
  expect(await screen.findByText("Earlier input")).toBeInTheDocument();
  expect(screen.getAllByText("Updated answer")).toHaveLength(1);
  expect(screen.queryByText("Stale answer")).not.toBeInTheDocument();
  expect(screen.queryByText(/This native chat is running/)).not.toBeInTheDocument();
});

it("renders native tools, older history, approvals and user input without fabricating Remi tasks", async () => {
  const questions = [{ id: "q1", header: "Choose", question: "What next?", options: [{ label: "Option A", description: "Use A" }] }, { id: "q2", header: "Details", question: "Explain", is_secret: false }];
  backend.getExternalChatHistory.mockResolvedValueOnce(history({
    next_cursor: "older", requests: [{ id: "approval", thread_id: "thread", turn_id: "old-turn", kind: "command_approval", text: "Run command?" }, { id: "question", thread_id: "thread", turn_id: "old-turn", kind: "user_input", text: "Answer questions", questions }],
    turns: [{ id: "old-turn", status: "completed", items: [{ id: "tool", type: "commandExecution", role: "tool", text: "npm test\npassed" }] }],
  })).mockResolvedValue(history({ turns: [{ id: "earliest", status: "completed", items: [{ id: "early", type: "userMessage", role: "user", text: "Earlier question" }] }] }));
  const user = userEvent.setup();
  show(<WindowHarness />);
  const tool = await screen.findByText("commandExecution");
  await user.click(tool);
  expect(screen.getByText(/npm test/)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Load earlier turns" }));
  expect(await screen.findByText("Earlier question")).toBeInTheDocument();
  expect(backend.getExternalChatHistory).toHaveBeenCalledWith("rt", "source", "thread", expect.objectContaining({ cursor: "older" }));
});

it("submits attached approval and selected/free-text native question answers through their exact request IDs", async () => {
  backend.getExternalChatHistory.mockResolvedValue(history({ requests: [
    { id: "approval", thread_id: "thread", turn_id: "old-turn", kind: "file_approval", text: "Apply changes?" },
    { id: "question", thread_id: "thread", turn_id: "old-turn", kind: "user_input", text: "Answer questions", questions: [{ id: "q1", header: "Choose", question: "What next?", options: [{ label: "Option A", description: "Use A" }] }, { id: "q2", header: "Details", question: "Explain" }] },
  ] }));
  const user = userEvent.setup();
  show(<WindowHarness />);
  await user.click(await screen.findByRole("button", { name: "Approve" }));
  await waitFor(() => expect(backend.respondExternalChatRequest).toHaveBeenCalledWith("rt", "source", "thread", "approval", { decision: "accept" }));
  await user.click(screen.getByRole("radio", { name: /Option A/ }));
  await user.type(screen.getByRole("textbox", { name: "Explain" }), "Original answer");
  await user.click(screen.getByRole("button", { name: "Submit answer" }));
  await waitFor(() => expect(backend.respondExternalChatRequest).toHaveBeenCalledWith("rt", "source", "thread", "question", { answers: { q1: ["Option A"], q2: ["Original answer"] } }));
});
