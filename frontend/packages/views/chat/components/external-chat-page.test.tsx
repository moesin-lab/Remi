import type { ReactNode } from "react";
import { useState, useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  listRuntimes: vi.fn(), listExternalChatCatalog: vi.fn(), listExternalChats: vi.fn(), getExternalChatHistory: vi.fn(), listExternalChatModels: vi.fn(),
  sendExternalChatMessage: vi.fn(), getExternalChatReceipt: vi.fn(), interruptExternalChatTurn: vi.fn(), respondExternalChatRequest: vi.fn(),
  createChatSession: vi.fn(), listChatSessions: vi.fn(), sendChatMessage: vi.fn(), markChatSessionRead: vi.fn(), getSessionLog: vi.fn(), listAgents: vi.fn(), listProjects: vi.fn(),
}));
const navigation = vi.hoisted(() => ({ searchParams: new URLSearchParams(), replace: vi.fn(), push: vi.fn(), select: vi.fn(), agent: vi.fn(), revision: 0, listeners: new Set<() => void>() }));
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
  useNavigation: () => {
    useSyncExternalStore(listener => { navigation.listeners.add(listener); return () => { navigation.listeners.delete(listener); }; }, () => navigation.revision);
    return navigation;
  },
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
function WindowHarness({ initialDraft = "", modelsSupported = false }: { initialDraft?: string; modelsSupported?: boolean }) {
  const [draft, setDraft] = useState(initialDraft);
  return <ExternalChatWindow ws="ws" runtime="rt" source="source" thread="thread" online modelsSupported={modelsSupported} draft={draft} onDraftChange={setDraft} />;
}

beforeEach(() => {
  vi.resetAllMocks();
  window.sessionStorage.clear();
  navigation.searchParams = new URLSearchParams({ kind: "external", external_runtime: "rt", external_source: "source", external_thread: "thread" });
  const navigate = (url: string) => {
    navigation.searchParams = new URLSearchParams(String(url).split("?")[1]);
    navigation.revision++;
    navigation.listeners.forEach(listener => listener());
  };
  navigation.replace.mockImplementation(navigate);
  navigation.push.mockImplementation(navigate);
  backend.listRuntimes.mockResolvedValue([runtime]);
  backend.listExternalChatCatalog.mockResolvedValue({ sources: [source], warnings: [] });
  backend.listExternalChats.mockResolvedValue({ chats: [chat], projects: [project], next_cursor: null });
  backend.getExternalChatHistory.mockResolvedValue(history());
  backend.listExternalChatModels.mockResolvedValue({ source_id: "source", models: [{ id: "source-native-id", name: "Source catalog model", description: "Source catalog description" }], next_cursor: null });
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
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Chat details" }));
  expect(await screen.findByText("original-provider")).toBeInTheDocument();
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("combobox", { name: "Search source projects" }));
  const native = await screen.findByRole("option", { name: /^Original native project/ });
  expect(within(native).getByText("/work/project · /work/second-root")).toBeInTheDocument();
  expect(within(native).getByText("Native project · Read-only")).toBeInTheDocument();
  await user.click(native);
  expect(screen.getByRole("combobox", { name: "Search source projects" })).toHaveValue("Original native project");
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

it("clears the old thread on Project change, preserves its draft and restores the filter from the URL", async () => {
  const user = userEvent.setup();
  const view = show(<ExternalChatPage />);
  await screen.findByText("Original native history");
  await user.type(screen.getByRole("textbox", { name: "Message this native chat" }), "Draft for this thread");
  await user.click(screen.getByRole("combobox", { name: "Search source projects" }));
  await user.click(await screen.findByRole("option", { name: /^Original native project/ }));
  expect(navigation.searchParams.get("external_project")).toBe(project.id);
  expect(navigation.searchParams.has("external_thread")).toBe(false);
  expect(screen.queryByRole("textbox", { name: "Message this native chat" })).not.toBeInTheDocument();
  expect(backend.sendExternalChatMessage).not.toHaveBeenCalled();
  await user.click(await screen.findByRole("button", { name: /Original thread/ }));
  expect(await screen.findByRole("textbox", { name: "Message this native chat" })).toHaveValue("Draft for this thread");
  view.unmount();
  show(<ExternalChatPage />);
  expect(await screen.findByRole("combobox", { name: "Search source projects" })).toHaveValue("Original native project");
  expect(navigation.searchParams.get("external_project")).toBe(project.id);
});

it("selects a sole native source without opening or sending to a thread", async () => {
  navigation.searchParams = new URLSearchParams({ kind: "external", external_runtime: "rt" });
  show(<ExternalChatPage />);
  await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/demo/chat?kind=external&external_runtime=rt&external_source=source"));
  expect(await screen.findByRole("button", { name: /Original thread/ })).toBeInTheDocument();
  expect(backend.getExternalChatHistory).not.toHaveBeenCalled();
  expect(backend.sendExternalChatMessage).not.toHaveBeenCalled();
});

it("shows a missing Project as unavailable and lets the user clear its URL filter", async () => {
  navigation.searchParams.set("external_project", "native:removed");
  const user = userEvent.setup();
  show(<ExternalChatPage />);
  const picker = await screen.findByRole("combobox", { name: "Search source projects" });
  expect(picker).toHaveValue("Project unavailable");
  await user.click(picker);
  await user.click(await screen.findByRole("option", { name: "All projects" }));
  expect(navigation.searchParams.has("external_project")).toBe(false);
  expect(picker).toHaveValue("All projects");
  expect(backend.sendExternalChatMessage).not.toHaveBeenCalled();
});

it("keeps the user's jump to latest when an older-history request resolves later", async () => {
  let finishOlder!: (value: ExternalChatHistory) => void;
  backend.getExternalChatHistory.mockResolvedValueOnce(history({ next_cursor: "older" }))
    .mockImplementationOnce(() => new Promise(resolve => { finishOlder = resolve; }));
  const user = userEvent.setup();
  show(<WindowHarness />);
  await screen.findByText("Original native history");
  const log = screen.getByRole("region", { name: "Chat messages" });
  let height = 1000;
  Object.defineProperty(log, "scrollHeight", { configurable: true, get: () => height });
  Object.defineProperty(log, "clientHeight", { configurable: true, value: 500 });
  log.scrollTop = 200;
  fireEvent.scroll(log);
  await user.click(screen.getByRole("button", { name: "Load earlier turns" }));
  await user.click(screen.getByRole("button", { name: "Jump to latest" }));
  height = 2000;
  await act(async () => finishOlder(history({ turns: [{ id: "earlier-turn", status: "completed", items: [{ id: "earlier", type: "userMessage", role: "user", text: "Earlier native question" }] }] })));
  await screen.findByText("Earlier native question");
  expect(log.scrollTop).toBe(height);
  expect(screen.queryByRole("button", { name: "Jump to latest" })).not.toBeInTheDocument();
});

it("uses Mod+Enter to continue while bare Enter and IME composition never send", async () => {
  backend.sendExternalChatMessage.mockImplementation((_runtime, _source, thread, input) => Promise.resolve({ request_id: input.request_id, thread_id: thread, turn_id: "native-turn", outcome: "accepted" }));
  show(<WindowHarness initialDraft={"Line one\nLine two"} />);
  await screen.findByText("Original native history");
  const input = screen.getByRole("textbox", { name: "Message this native chat" });
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.keyDown(input, { key: "Enter", ctrlKey: true, isComposing: true });
  expect(backend.sendExternalChatMessage).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter", metaKey: true });
  await waitFor(() => expect(backend.sendExternalChatMessage).toHaveBeenCalledTimes(1));
  expect(backend.sendExternalChatMessage.mock.calls[0]?.[3].text).toBe("Line one\nLine two");
  fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
  expect(backend.sendExternalChatMessage).toHaveBeenCalledTimes(1);
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
  await user.click(await screen.findByRole("option", { name: /^Discovered project/ }));
  expect(screen.getByRole("combobox", { name: "Search source projects" })).toHaveValue("Discovered project");
  await user.click(screen.getByRole("combobox", { name: "Search source projects" }));
  await user.clear(screen.getByRole("combobox", { name: "Search source projects" }));
  await user.click(await screen.findByRole("option", { name: /^Original native project/ }));
  await waitFor(() => expect(backend.listExternalChats).toHaveBeenCalledWith("rt", "source", expect.objectContaining({ project_id: project.id })));
  await user.click(screen.getByRole("button", { name: /Newer thread/ }));
  expect(navigation.push).toHaveBeenCalledWith("/demo/chat?kind=external&external_runtime=rt&external_source=source&external_thread=newer&external_project=native%3Aproject");
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
  expect(firstChat).toBeInTheDocument();
  expect(screen.queryByText("Worktree 499")).not.toBeInTheDocument();
  expect(screen.queryByText("/worktrees/root-499")).not.toBeInTheDocument();
  expect(screen.queryAllByRole("option")).toHaveLength(0);

  await user.clear(picker);
  await user.type(picker, "Worktree 499");
  expect(picker).toHaveValue("Worktree 499");
  const option = await screen.findByRole("option", { name: /^Worktree 499/ });
  expect(within(option).getByText("Discovered by directory · Read-only")).toBeInTheDocument();
  expect(within(option).getByText("/worktrees/root-499 · /worktrees/extra-499")).toBeInTheDocument();
  await user.click(option);
  expect(picker).toHaveValue("Worktree 499");
  expect(screen.queryByText("/worktrees/root-0")).not.toBeInTheDocument();
  await waitFor(() => expect(backend.listExternalChats).toHaveBeenCalledWith("rt", "source", expect.objectContaining({ project_id: "directory:499" })));
  expect(backend.listProjects).not.toHaveBeenCalled();
});

it("preserves a Project search and its option nodes when native chats finish loading and the parent rerenders", async () => {
  const projects: ExternalChatProject[] = [
    { id: "directory:main", kind: "directory", name: "markone", roots: ["/dev/aiden/markone"], readonly: true },
    { id: "native:worktree", kind: "native", name: "markone", roots: ["/dev/worktrees/markone-fix"], readonly: true },
    { id: "directory:cli", kind: "directory", name: "aiden-cli", roots: ["/dev/aiden/aiden-cli"], readonly: true },
  ];
  let resolveThreads!: (result: { chats: ExternalChatSummary[]; projects: ExternalChatProject[]; next_cursor: null }) => void;
  backend.listExternalChatCatalog.mockResolvedValue({ sources: [{ ...source, projects }], warnings: [] });
  backend.listExternalChats.mockImplementationOnce(() => new Promise(resolve => { resolveThreads = resolve; }));
  const user = userEvent.setup();
  const view = show(<ExternalChatPage />);
  const picker = await screen.findByRole("combobox", { name: "Search source projects" });
  await user.clear(picker);
  await user.type(picker, "markone");
  const options = await screen.findAllByRole("option", { name: /^markone/ });
  expect(options).toHaveLength(2);
  expect(within(options[0]!).getByText("Discovered by directory · Read-only")).toBeInTheDocument();
  expect(within(options[0]!).getByText("/dev/aiden/markone")).toBeInTheDocument();
  expect(within(options[1]!).getByText("Native project · Read-only")).toBeInTheDocument();
  expect(within(options[1]!).getByText("/dev/worktrees/markone-fix")).toBeInTheDocument();

  await act(async () => resolveThreads({ chats: [chat], projects: projects.map(row => ({ ...row, roots: [...row.roots] })), next_cursor: null }));
  await waitFor(() => expect(view.client.getQueryState(["external-chat", "ws", "rt", "source", "threads", ""])?.status).toBe("success"));
  view.update(<ExternalChatPage />);
  expect(picker).toHaveValue("markone");
  expect(screen.getAllByRole("option", { name: /^markone/ })).toHaveLength(2);
  expect(options.every(option => option.isConnected)).toBe(true);
  await user.click(options[1]!);
  await waitFor(() => expect(backend.listExternalChats).toHaveBeenCalledWith("rt", "source", expect.objectContaining({ project_id: "native:worktree" })));

  await user.clear(picker);
  await user.type(picker, "markone");
  const selectedOptions = await screen.findAllByRole("option", { name: /^markone/ });
  await act(async () => {
    view.client.setQueryData(["external-chat", "ws", "rt", "catalog"], {
      sources: [{ ...source, projects: projects.map(row => ({ ...row, roots: [...row.roots, "/updated-root"] })) }], warnings: [],
    });
  });
  view.update(<ExternalChatPage />);
  expect(picker).toHaveValue("markone");
  expect(screen.getAllByRole("option", { name: /^markone/ })).toHaveLength(2);
  expect(selectedOptions.every(option => option.isConnected)).toBe(true);
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

it("automatically loads every native model page and sends an explicit selection only on the next message", async () => {
  const firstModel = { id: "source-gemini-id", name: "Source Gemini", description: "First-page description" };
  const chosen = { id: "source-aiden-id", name: "Source Aiden", description: "Second-page description" };
  let resolveSecond!: (page: { source_id: string; models: typeof chosen[]; next_cursor: string }) => void;
  backend.listExternalChatModels.mockResolvedValueOnce({ source_id: "source", models: [firstModel], next_cursor: "second&page" })
    .mockImplementationOnce(() => new Promise(resolve => { resolveSecond = resolve; }))
    .mockResolvedValue({ source_id: "source", models: [firstModel, { id: "source-third-id", name: "Source third model", description: "Last page" }], next_cursor: null });
  let resolveSend!: (receipt: { request_id: string; thread_id: string; turn_id: string; outcome: "accepted" }) => void;
  backend.sendExternalChatMessage.mockImplementation(() => new Promise(resolve => { resolveSend = resolve; }));
  const user = userEvent.setup();
  show(<WindowHarness modelsSupported initialDraft="Keep my exact question" />);
  await screen.findByText("Original native history");
  await user.click(screen.getByRole("button", { name: "Model for next message" }));
  await screen.findByText("Current model: original-model");
  expect(screen.queryByRole("button", { name: "original-model" })).not.toBeInTheDocument();
  await waitFor(() => expect(backend.listExternalChatModels).toHaveBeenCalledWith("rt", "source", { cursor: "second&page", limit: 50 }));
  expect(screen.getByText("Loading source models…")).toBeInTheDocument();
  await act(async () => resolveSecond({ source_id: "source", models: [chosen], next_cursor: "last&page" }));
  await screen.findByRole("button", { name: /Source third model/ });
  expect(backend.listExternalChatModels).toHaveBeenCalledWith("rt", "source", { cursor: undefined, limit: 50 });
  expect(backend.listExternalChatModels).toHaveBeenCalledWith("rt", "source", { cursor: "last&page", limit: 50 });
  expect(screen.getAllByRole("button", { name: /Source Gemini/ })).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: /Source Aiden/ }));
  expect(screen.getByRole("button", { name: "Model for next message" })).toHaveTextContent("Source Aiden");
  expect(backend.sendExternalChatMessage).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Chat details" }));
  expect(await screen.findByText("original-model")).toBeInTheDocument();
  expect(screen.getByText("original-provider")).toBeInTheDocument();
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button", { name: "Continue this chat" }));
  await waitFor(() => expect(backend.sendExternalChatMessage).toHaveBeenCalledWith("rt", "source", "thread", { text: "Keep my exact question", request_id: expect.any(String), model: chosen.id }));
  expect(screen.getByRole("button", { name: "Model for next message" })).toBeDisabled();
  const sent = backend.sendExternalChatMessage.mock.calls[0]![3];
  await act(async () => resolveSend({ request_id: sent.request_id, thread_id: "thread", turn_id: "native-model-turn", outcome: "accepted" }));
  expect(screen.getByRole("button", { name: "Model for next message" })).toBeDisabled();
  expect(backend.sendChatMessage).not.toHaveBeenCalled();
});

it("can clear an explicit model choice and continue with the source's native model without an override", async () => {
  backend.sendExternalChatMessage.mockImplementation((_runtime, _source, thread, input) => Promise.resolve({ request_id: input.request_id, thread_id: thread, turn_id: "native-turn", outcome: "accepted" }));
  const user = userEvent.setup();
  show(<WindowHarness modelsSupported initialDraft="Use native defaults" />);
  await screen.findByText("Original native history");
  await user.click(screen.getByRole("button", { name: "Model for next message" }));
  await user.click(await screen.findByRole("button", { name: /Source catalog model/ }));
  await user.click(screen.getByRole("button", { name: "Model for next message" }));
  await user.click(screen.getByRole("button", { name: "Keep native model" }));
  await user.click(screen.getByRole("button", { name: "Continue this chat" }));
  await waitFor(() => expect(backend.sendExternalChatMessage).toHaveBeenCalledWith("rt", "source", "thread", { text: "Use native defaults", request_id: expect.any(String) }));
});

it("retains an explicit model after capability loss until the user clears it, without silently using a different native model", async () => {
  backend.sendExternalChatMessage.mockImplementation((_runtime, _source, thread, input) => input.model
    ? Promise.reject(new ApiError("Model selection unsupported", 409, "Conflict", { error: "Model selection unsupported", code: "MODEL_SELECTION_UNSUPPORTED" }))
    : Promise.resolve({ request_id: input.request_id, thread_id: thread, turn_id: "native-turn", outcome: "accepted" }));
  const user = userEvent.setup();
  const view = show(<WindowHarness modelsSupported initialDraft="Use my selected model" />);
  await screen.findByText("Original native history");
  await user.click(screen.getByRole("button", { name: "Model for next message" }));
  await user.click(await screen.findByRole("button", { name: /Source catalog model/ }));
  view.update(<WindowHarness modelsSupported={false} initialDraft="Use my selected model" />);
  expect(screen.getByRole("button", { name: "Model for next message" })).toHaveTextContent("Source catalog model");
  await user.click(screen.getByRole("button", { name: "Continue this chat" }));
  await waitFor(() => expect(backend.sendExternalChatMessage).toHaveBeenCalledWith("rt", "source", "thread", {
    text: "Use my selected model", request_id: expect.any(String), model: "source-native-id",
  }));
  await screen.findByText("Message was rejected. Your draft is retained.");
  expect(screen.getByRole("textbox", { name: "Message this native chat" })).toHaveValue("Use my selected model");
  await user.click(screen.getByRole("button", { name: "Model for next message" }));
  await screen.findByText(/Update this Runtime to choose a model/);
  expect(screen.queryByRole("button", { name: /Source catalog model/ })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Keep native model" }));
  expect(screen.getByRole("button", { name: "Model for next message" })).toHaveTextContent("original-model");
  await user.click(screen.getByRole("button", { name: "Continue this chat" }));
  await waitFor(() => expect(backend.sendExternalChatMessage).toHaveBeenLastCalledWith("rt", "source", "thread", {
    text: "Use my selected model", request_id: expect.any(String),
  }));
});

it("keeps legacy Runtime continuation available while explaining that model selection requires an upgrade", async () => {
  backend.sendExternalChatMessage.mockImplementation((_runtime, _source, thread, input) => Promise.resolve({ request_id: input.request_id, thread_id: thread, turn_id: "native-turn", outcome: "accepted" }));
  const user = userEvent.setup();
  show(<WindowHarness initialDraft="Legacy continuation" />);
  await screen.findByText("Original native history");
  await user.click(screen.getByRole("button", { name: "Model for next message" }));
  expect(await screen.findByText(/Update this Runtime to choose a model/)).toBeInTheDocument();
  expect(backend.listExternalChatModels).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button", { name: "Continue this chat" }));
  await waitFor(() => expect(backend.sendExternalChatMessage).toHaveBeenCalledWith("rt", "source", "thread", { text: "Legacy continuation", request_id: expect.any(String) }));
});

it("shows catalog failure and retry, distinguishes an empty catalog, and still permits native-default continuation", async () => {
  backend.listExternalChatModels.mockResolvedValueOnce({ source_id: "source", models: [{ id: "first-id", name: "First-page model", description: "Partial directory" }], next_cursor: "failed-page" })
    .mockRejectedValueOnce(new Error("Source model read failed"))
    .mockResolvedValue({ source_id: "source", models: [], next_cursor: null });
  backend.sendExternalChatMessage.mockImplementation((_runtime, _source, thread, input) => Promise.resolve({ request_id: input.request_id, thread_id: thread, turn_id: "native-turn", outcome: "accepted" }));
  const user = userEvent.setup();
  const view = show(<WindowHarness modelsSupported initialDraft="Continue anyway" />);
  await screen.findByText("Original native history");
  await user.click(screen.getByRole("button", { name: "Model for next message" }));
  expect(await screen.findByText("Could not load source models.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /First-page model/ })).toBeInTheDocument();
  expect(backend.listExternalChatModels).toHaveBeenCalledTimes(2);
  await user.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.queryByText("Could not load source models.")).not.toBeInTheDocument());
  expect(backend.listExternalChatModels).toHaveBeenCalledWith("rt", "source", { cursor: "failed-page", limit: 50 });
  await act(async () => view.client.resetQueries({ queryKey: ["external-chat", "ws", "rt", "source", "models"] }));
  expect(await screen.findByText("This source has no models in its catalog.")).toBeInTheDocument();
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button", { name: "Continue this chat" }));
  await waitFor(() => expect(backend.sendExternalChatMessage.mock.calls[0]?.[3]).toEqual({ text: "Continue anyway", request_id: expect.any(String) }));
});

it.each(["active", "unknown"])("locks model selection while the native chat is %s", async status => {
  if (status === "active") backend.getExternalChatHistory.mockResolvedValue(history({ chat: { ...chat, status: "active" } }));
  else {
    backend.sendExternalChatMessage.mockRejectedValue(new TypeError("Acknowledgement lost"));
    backend.getExternalChatReceipt.mockImplementation((_runtime, _source, thread, request_id) => Promise.resolve({ request_id, thread_id: thread, turn_id: null, outcome: "unknown" }));
  }
  const user = userEvent.setup();
  show(<WindowHarness modelsSupported initialDraft="Keep one native turn" />);
  await screen.findByText("Original native history");
  if (status === "unknown") {
    await user.click(screen.getByRole("button", { name: "Continue this chat" }));
    await screen.findByText(/Send outcome is unknown/);
  }
  expect(screen.getByRole("button", { name: "Model for next message" })).toBeDisabled();
  expect(backend.listExternalChatModels).not.toHaveBeenCalled();
});

it("isolates model selection across threads, sources and Runtimes while using each Runtime's capability", async () => {
  const otherSource = { ...source, id: "other-source" };
  backend.listRuntimes.mockResolvedValue([runtime, { ...runtime, id: "rt-models", metadata: { external_chats: 1, external_chat_models: 1 } }]);
  backend.listExternalChatCatalog.mockResolvedValue({ sources: [source, otherSource], warnings: [] });
  backend.getExternalChatHistory.mockImplementation((_runtime, sourceId, threadId) => Promise.resolve(history({ chat: { ...chat, id: threadId, source_id: sourceId } })));
  backend.listExternalChatModels.mockImplementation((runtimeId, sourceId) => Promise.resolve({ source_id: sourceId, models: [{ id: `${runtimeId}-${sourceId}-model`, name: "Scoped model", description: "Scoped source catalog" }], next_cursor: null }));
  const user = userEvent.setup();
  show(<ExternalChatPage />);
  await screen.findByText("Original native history");
  await user.click(screen.getByRole("button", { name: "Model for next message" }));
  await screen.findByText(/Update this Runtime to choose a model/);
  await user.keyboard("{Escape}");
  await act(async () => navigation.push("/demo/chat?kind=external&external_runtime=rt-models&external_source=source&external_thread=thread"));
  await screen.findByText("Original native history");
  await user.click(screen.getByRole("button", { name: "Model for next message" }));
  await user.click(await screen.findByRole("button", { name: /Scoped model/ }));
  expect(screen.getByRole("button", { name: "Model for next message" })).toHaveTextContent("Scoped model");
  await act(async () => navigation.push("/demo/chat?kind=external&external_runtime=rt-models&external_source=source&external_thread=other-thread"));
  await screen.findByText("Original native history");
  expect(screen.getByRole("button", { name: "Model for next message" })).toHaveTextContent("original-model");
  await user.click(screen.getByRole("button", { name: "Model for next message" }));
  await user.click(await screen.findByRole("button", { name: /Scoped model/ }));
  await act(async () => navigation.push("/demo/chat?kind=external&external_runtime=rt-models&external_source=other-source&external_thread=other-thread"));
  await screen.findByText("Original native history");
  expect(screen.getByRole("button", { name: "Model for next message" })).toHaveTextContent("original-model");
  await user.click(screen.getByRole("button", { name: "Model for next message" }));
  await screen.findByRole("button", { name: /Scoped model/ });
  expect(backend.listExternalChatModels).toHaveBeenCalledWith("rt-models", "other-source", expect.any(Object));
  expect(backend.listExternalChatModels).not.toHaveBeenCalledWith("rt", expect.anything(), expect.anything());
  expect(backend.sendExternalChatMessage).not.toHaveBeenCalled();
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
  const tool = await screen.findByText(enChat.external.activity_command);
  await user.click(tool.closest("details")!.parentElement!.closest("details")!.querySelector("summary")!);
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

it("keeps paths and native IDs in chat details while the list and header show only the conversation title", async () => {
  const user = userEvent.setup();
  show(<ExternalChatPage />);
  await screen.findByText("Original native history");
  const row = screen.getByRole("button", { name: /Original thread/ });
  expect(row).not.toHaveTextContent(chat.cwd);
  expect(row).toHaveAttribute("title", chat.title);
  expect(screen.queryByText(chat.cwd)).not.toBeInTheDocument();
  expect(screen.queryByText(source.home)).not.toBeInTheDocument();
  expect(screen.queryByText("native-id")).not.toBeInTheDocument();
  expect(screen.queryByText(enChat.external.config_readonly)).not.toBeInTheDocument();
  expect(screen.queryByRole("combobox", { name: "Codex source" })).not.toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Runtime" })).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Search source projects" })).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Chat details" }));
  expect(await screen.findByText(source.home)).toBeVisible();
  expect(screen.getByText(chat.cwd)).toBeVisible();
  expect(screen.getByText("native-id")).toBeVisible();
  expect(screen.getByText("thread", { selector: "dd" })).toBeVisible();
  expect(screen.getByText("rt", { selector: "dd" })).toBeVisible();
  expect(screen.getByText("source", { selector: "dd" })).toBeVisible();
  expect(screen.getByText(source.name, { selector: "dd" })).toBeVisible();
  expect(screen.getByText(project.name, { selector: "dd" })).toBeVisible();
  expect(screen.getByText("/work/project /work/second-root", { selector: "dd" })).toBeVisible();
  expect(screen.getByText(enChat.external.readonly)).toBeVisible();
});

it("retains source choice when multiple sources exist and shows the newly selected source metadata on demand", async () => {
  const alternate = { ...source, id: "alternate", name: "Second Codex", home: "/alternate/.codex" };
  backend.listExternalChatCatalog.mockResolvedValue({ sources: [source, alternate], warnings: [] });
  backend.listExternalChats.mockImplementation((_runtime, currentSource) => Promise.resolve({ chats: [{ ...chat, source_id: currentSource }], projects: [project], next_cursor: null }));
  backend.getExternalChatHistory.mockImplementation((_runtime, currentSource) => Promise.resolve(history({ chat: { ...chat, source_id: currentSource } })));
  const user = userEvent.setup();
  show(<ExternalChatPage />);
  await screen.findByText("Original native history");
  await user.click(screen.getByRole("combobox", { name: "Codex source" }));
  const option = await screen.findByRole("option", { name: alternate.name });
  expect(option).not.toHaveTextContent(alternate.home);
  await user.click(option);
  expect(navigation.searchParams.get("external_source")).toBe(alternate.id);
  expect(navigation.searchParams.has("external_thread")).toBe(false);
  await user.click(await screen.findByRole("button", { name: /Original thread/ }));
  await screen.findByText("Original native history");
  expect(screen.queryByText(alternate.home)).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Chat details" }));
  expect(await screen.findByText(alternate.home)).toBeVisible();
  expect(screen.getByText(alternate.name, { selector: "dd" })).toBeVisible();
  expect(screen.queryByText(source.home)).not.toBeInTheDocument();
});

it("keeps the approval working directory and command visible without opening general chat details", async () => {
  backend.getExternalChatHistory.mockResolvedValue(history({ requests: [{
    id: "approval", thread_id: "thread", turn_id: "old-turn", kind: "command_approval",
    text: "Run `git status` in:\n\n`/approval/workspace`",
  }] }));
  show(<ExternalChatPage />);
  expect(await screen.findByText("/approval/workspace")).toBeVisible();
  expect(screen.getByText("git status")).toBeVisible();
  expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
  expect(screen.queryByText(chat.cwd)).not.toBeInTheDocument();
  expect(screen.queryByText(source.home)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Chat details" })).toBeInTheDocument();
});

it("lets the user explicitly recover an unavailable source even when only one replacement source exists", async () => {
  navigation.searchParams.set("external_source", "removed-source");
  const user = userEvent.setup();
  show(<ExternalChatPage />);
  await user.click(await screen.findByRole("combobox", { name: "Codex source" }));
  await user.click(await screen.findByRole("option", { name: source.name }));
  expect(navigation.searchParams.get("external_source")).toBe(source.id);
  expect(navigation.searchParams.has("external_thread")).toBe(false);
  expect(screen.queryByRole("combobox", { name: "Codex source" })).not.toBeInTheDocument();
  expect(backend.sendExternalChatMessage).not.toHaveBeenCalled();
});
