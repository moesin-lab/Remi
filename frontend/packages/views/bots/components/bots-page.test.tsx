import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { Bot, BotSender } from "@multiremi/core/bots";
import { botKeys } from "@multiremi/core/bots/queries";
import enBots from "../../locales/en/bots.json";
import { BotsPage } from "./bots-page";

const workspace = vi.hoisted(() => ({ id: "ws-1", role: "owner" as string | null }));
const api = vi.hoisted(() => ({
  listBots: vi.fn(), getBot: vi.fn(), createBot: vi.fn(), updateBot: vi.fn(), deleteBot: vi.fn(),
  listBotSenders: vi.fn(), updateBotSender: vi.fn(), listAgents: vi.fn(), listRuntimes: vi.fn(),
}));
vi.mock("@multiremi/core/api", () => ({ api }));
vi.mock("@multiremi/core/permissions", () => ({ useCurrentMember: () => ({ role: workspace.role }) }));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => workspace.id }));
vi.mock("../../runtimes/components/runtime-workspace-picker", () => ({ WorkLocationPicker: () => <span>Work location picker</span> }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function fixture(): Bot {
  return {
    id: "bot-1", workspace_id: "ws-1", name: "Release helper", enabled: true, revision: 1,
    default_target: { kind: "agent", agent_id: "agent-1", runtime_id: null, project_id: null, runtime_workspace_id: null },
    platform_bindings: [{ id: "account-1", platform: "feishu", domain: "feishu", app_id: "cli_1", host_runtime_id: "runtime-1", enabled: true, app_secret_configured: true, app_secret_hint: "••••", status: "offline", last_error: "Connection lost", last_seen_at: null }],
    routes: [], allowlist_enabled: false,
    issue_notifications: { platform_binding_id: "account-1", chat_id: "group-1" },
    created_at: "2026-09-14T00:00:00Z", updated_at: "2026-09-14T00:00:00Z",
  };
}
let bot: Bot;
let senders: BotSender[];

beforeEach(() => {
  vi.clearAllMocks();
  workspace.id = "ws-1";
  workspace.role = "owner";
  bot = fixture();
  senders = ["sender-1", "sender-2"].map((id, index) => ({ id, bot_id: "bot-1", platform_binding_id: "account-1", external_id: `ou_${index}`, display_name: "Same name", allowed: false, first_seen_at: "2026-09-14T00:00:00Z", last_seen_at: "2026-09-14T00:00:00Z" }));
  api.listBots.mockImplementation(async (wsId: string) => ({ bots: wsId === "ws-1" ? [bot] : [] }));
  api.getBot.mockImplementation(async () => bot);
  api.listBotSenders.mockImplementation(async () => ({ senders }));
  api.listAgents.mockResolvedValue([{ id: "agent-1", name: "Agent One", archived_at: null }]);
  api.listRuntimes.mockResolvedValue([{ id: "runtime-1", name: "Mac", provider: "codex", status: "online" }]);
  api.updateBot.mockImplementation(async (_id, input) => { bot = { ...bot, ...input, platform_bindings: bot.platform_bindings, revision: bot.revision + 1 }; return bot; });
  api.deleteBot.mockResolvedValue({ deleted: true });
  api.updateBotSender.mockImplementation(async (_ws, _bot, senderId, allowed) => {
    senders = senders.map(sender => sender.id === senderId ? { ...sender, allowed } : sender);
    return senders.find(sender => sender.id === senderId);
  });
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) { return <QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { bots: enBots } }}>{children}</I18nProvider></QueryClientProvider>; }
  const view = render(<BotsPage />, { wrapper: Wrapper });
  return { ...view, client, user: userEvent.setup() };
}

async function openBot(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /Release helper/ }));
  await screen.findByRole("textbox", { name: "Bot name" });
}

describe("Bots page", () => {
  it.each(["member", null])("keeps bot configuration readable without offering writes for role %s", async (role) => {
    workspace.role = role;
    const { user } = mount();
    expect(await screen.findByRole("button", { name: "Create bot" })).toBeDisabled();
    await openBot(user);
    expect(screen.getByLabelText("Bot name")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    for (const button of await screen.findAllByRole("button", { name: "Allow" })) expect(button).toBeDisabled();
    expect(api.updateBot).not.toHaveBeenCalled();
    expect(api.updateBotSender).not.toHaveBeenCalled();
  });

  it("shows actual connection failure separately from enabled configuration and stops without losing notification settings", async () => {
    const { user } = mount();
    await openBot(user);
    expect(screen.getByText("Offline")).toBeInTheDocument();
    expect(screen.getByText("Connection lost")).toBeInTheDocument();
    expect(screen.queryByText("Online")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(api.updateBot).toHaveBeenCalledWith("bot-1", expect.objectContaining({
      workspace_id: "ws-1", enabled: false, issue_notifications: { platform_binding_id: "account-1", chat_id: "group-1" },
      platform_bindings: [expect.objectContaining({ id: "account-1", app_secret_op: "keep" })],
    })));
    expect(JSON.stringify(api.updateBot.mock.calls[0])).not.toContain("app_secret_configured");
  });

  it("keeps same-name senders distinct and allows then revokes the selected account", async () => {
    const { user } = mount();
    await openBot(user);
    const rows = await screen.findAllByRole("listitem");
    expect(rows).toHaveLength(2);
    await user.click(within(rows[1]!).getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(api.updateBotSender).toHaveBeenLastCalledWith("ws-1", "bot-1", "sender-2", true));
    await user.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(api.updateBotSender).toHaveBeenLastCalledWith("ws-1", "bot-1", "sender-2", false));
  });

  it("does not overwrite a dirty form during a status refresh", async () => {
    const { user, client } = mount();
    await openBot(user);
    const name = screen.getByRole("textbox", { name: "Bot name" });
    await user.clear(name);
    await user.type(name, "Unsaved helper");
    act(() => client.setQueryData(botKeys.detail("ws-1", "bot-1"), { ...bot, name: "Remote helper" }));
    expect(name).toHaveValue("Unsaved helper");
    expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Back to bots" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("Discard unsaved changes?");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(name).toHaveValue("Unsaved helper");
  });

  it("preserves unsaved name and secret when a background refresh fails then recovers", async () => {
    const { user, client } = mount();
    await openBot(user);
    const name = screen.getByRole("textbox", { name: "Bot name" });
    const secret = screen.getByLabelText("App Secret");
    await user.clear(name);
    await user.type(name, "Unsaved helper");
    await user.type(secret, "unsaved-secret");
    api.getBot.mockRejectedValueOnce(new Error("temporary network failure"));
    await act(async () => { await client.invalidateQueries({ queryKey: botKeys.detail("ws-1", "bot-1") }); });
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load this data");
    expect(screen.getByRole("textbox", { name: "Bot name" })).toBe(name);
    expect(name).toHaveValue("Unsaved helper");
    expect(secret).toHaveValue("unsaved-secret");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByRole("textbox", { name: "Bot name" })).toBe(name);
    expect(name).toHaveValue("Unsaved helper");
    expect(secret).toHaveValue("unsaved-secret");
  });

  it("clears selected bot and secret drafts when switching workspace", async () => {
    const { user, rerender } = mount();
    await openBot(user);
    await user.type(screen.getByLabelText("App Secret"), "draft-secret");
    workspace.id = "ws-2";
    rerender(<BotsPage />);
    expect(await screen.findByText("No bots yet")).toBeInTheDocument();
    expect(screen.queryByLabelText("App Secret")).not.toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Create bot" })[0]!);
    expect(await screen.findByLabelText("App Secret")).toHaveValue("");
    expect(screen.getByRole("switch", { name: "Use sender allowlist" })).not.toBeChecked();
  });

  it("keeps a load error distinct from the empty state and retries it", async () => {
    api.listBots.mockRejectedValueOnce(new Error("offline"));
    const { user } = mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load this data");
    expect(screen.queryByText("No bots yet")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: /Release helper/ })).toBeInTheDocument();
  });

  it("waits for deletion confirmation and returns to the list only after success", async () => {
    const { user } = mount();
    await openBot(user);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(api.deleteBot).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Existing agents, chats and tasks will be kept.");
    api.listBots.mockResolvedValue({ bots: [] });
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.deleteBot).toHaveBeenCalledWith("ws-1", "bot-1"));
    expect(await screen.findByText("No bots yet")).toBeInTheDocument();
  });
});
