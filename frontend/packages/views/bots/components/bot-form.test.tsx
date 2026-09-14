import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Bot, BotPlatformBinding, BotRoute } from "@multiremi/core/bots";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enBots from "../../locales/en/bots.json";
import enCommon from "../../locales/en/common.json";
import enRuntimes from "../../locales/en/runtimes.json";
import { BotForm } from "./bot-form";

const mockApi = vi.hoisted(() => ({
  listAgents: vi.fn(),
  listRuntimes: vi.fn(),
  listRuntimeWorkspaces: vi.fn(),
  listProjects: vi.fn(),
}));
vi.mock("@multiremi/core/api", () => ({ api: mockApi }));

function binding(id = "binding-1", appId = "app_1"): BotPlatformBinding {
  return {
    id, platform: "feishu", app_id: appId, domain: "feishu", host_runtime_id: "runtime-1",
    enabled: true, app_secret_configured: true, app_secret_hint: "***saved",
    status: "online", last_error: null, last_seen_at: null,
  };
}

function route(id: string, agentId: string): BotRoute {
  return { id, name: id, match: {}, target: { kind: "agent", agent_id: agentId } };
}

function botFixture(overrides: Partial<Bot> = {}): Bot {
  return {
    id: "bot-1", workspace_id: "ws-1", name: "Assistant", enabled: false, revision: 1,
    platform_bindings: [binding()],
    default_target: { kind: "agent", agent_id: "agent-1", runtime_id: null, project_id: null, runtime_workspace_id: null },
    routes: [], allowlist_enabled: false, issue_notifications: null,
    created_at: "2026-09-14T00:00:00Z", updated_at: "2026-09-14T00:00:00Z",
    ...overrides,
  };
}

const resources = { en: { bots: enBots, common: enCommon, runtimes: enRuntimes } };

describe("BotForm", () => {
  let queryClient: QueryClient;
  const save = vi.fn();
  const dirty = vi.fn();

  function Wrapper({ children }: { children: ReactNode }) {
    return <I18nProvider locale="en" resources={resources}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </I18nProvider>;
  }

  function renderForm(bot: Bot | null = botFixture()) {
    return render(<BotForm wsId="ws-1" bot={bot} busy={false} onSave={save} onDirtyChange={dirty} />, { wrapper: Wrapper });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockApi.listAgents.mockResolvedValue([
      { id: "agent-1", name: "General agent", archived_at: null },
      { id: "agent-2", name: "Coding agent", archived_at: null },
      { id: "agent-3", name: "Retired agent", archived_at: "2026-09-01" },
    ]);
    mockApi.listRuntimes.mockResolvedValue([
      { id: "runtime-1", name: "Mac host", provider: "codex", status: "online", daemon_id: "daemon-1", device_info: "Mac" },
      { id: "runtime-2", name: "Windows host", provider: "codex", status: "online", daemon_id: "daemon-2", device_info: "Windows" },
    ]);
    mockApi.listRuntimeWorkspaces.mockResolvedValue([
      { id: "directory-1", name: "Windows app", daemon_id: "daemon-2", root_path: "C:\\app", cwd: null, status: "available" },
    ]);
    mockApi.listProjects.mockResolvedValue({ projects: [] });
    save.mockResolvedValue(botFixture());
  });

  afterEach(() => { queryClient.clear(); vi.unstubAllGlobals(); });

  it("keeps each saved account identity and credential when editing an existing Bot", async () => {
    const user = userEvent.setup();
    const original = botFixture({
      platform_bindings: [binding(), binding("binding-2", "app_2")],
      issue_notifications: { platform_binding_id: "binding-2", chat_id: "oc_updates", target: { kind: "agent", agent_id: "agent-2" } },
    });
    renderForm(original);
    await waitFor(() => expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled());
    expect(screen.getAllByLabelText("App ID")).toHaveLength(2);
    for (const input of screen.getAllByLabelText("App ID")) expect(input).toBeDisabled();
    for (const input of screen.getAllByLabelText("App Secret")) expect(input).toHaveValue("");
    await user.type(screen.getByLabelText("Bot name"), " updated");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toMatchObject({
      name: "Assistant updated",
      platform_bindings: [
        { id: "binding-1", app_id: "app_1", app_secret_op: "keep", app_secret: undefined },
        { id: "binding-2", app_id: "app_2", app_secret_op: "keep", app_secret: undefined },
      ],
      issue_notifications: original.issue_notifications,
    });
    expect(JSON.stringify(save.mock.calls[0]![0])).not.toContain("***saved");
  });

  it("gives a new account a stable id that its route can reference before the first save", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(screen.getByRole("button", { name: "Add account" }));
    const account = within(screen.getByRole("group", { name: "Account 2" }));
    await user.type(account.getByLabelText("App ID"), "app_new");
    await user.type(account.getByLabelText("App Secret"), "new-token");
    await user.click(account.getByRole("combobox", { name: "Connection host Runtime" }));
    await user.click(await screen.findByRole("option", { name: "Windows host · codex" }));
    await user.click(screen.getByRole("button", { name: "Add rule" }));
    const rule = within(screen.getByRole("group", { name: "Rule 1" }));
    await user.click(rule.getByRole("checkbox", { name: "app_new" }));
    await user.click(rule.getByRole("combobox", { name: "Agent" }));
    expect(screen.queryByRole("option", { name: "Retired agent" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("option", { name: "Coding agent" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const input = save.mock.calls[0]![0];
    const added = input.platform_bindings[1];
    expect(added).toMatchObject({ app_id: "app_new", app_secret_op: "set", app_secret: "new-token", host_runtime_id: "runtime-2" });
    expect(added.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(input.routes[0]).toMatchObject({ match: { platform_binding_ids: [added.id] }, target: { agent_id: "agent-2" } });
  });

  it("reorders rules without changing their ids, agents or match conditions", async () => {
    const user = userEvent.setup();
    const first = { ...route("General", "agent-1"), match: { chat_types: ["p2p"] as ["p2p"] } };
    const second = { ...route("Coding", "agent-2"), match: { commands: ["build"] } };
    renderForm(botFixture({ routes: [first, second] }));
    await user.click(within(screen.getByRole("group", { name: "Rule 1" })).getByRole("button", { name: "Move down" }));
    expect(within(screen.getByRole("group", { name: "Rule 1" })).getByLabelText("Rule name")).toHaveValue("Coding");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0].routes).toEqual([second, first]);
  });

  it("distinguishes inherited runtime and directory from explicit automatic execution and a local directory", async () => {
    const user = userEvent.setup();
    const first = route("Inherited", "agent-1");
    renderForm(botFixture({
      default_target: { kind: "agent", agent_id: "agent-1", runtime_id: "runtime-1", project_id: "project-1", runtime_workspace_id: null },
      routes: [first, route("Override", "agent-2")],
    }));
    const override = within(screen.getByRole("group", { name: "Rule 2" }));
    expect(override.getByRole("combobox", { name: "Execution Runtime" })).toHaveTextContent("Use bot default");
    await user.click(override.getByRole("combobox", { name: "Execution Runtime" }));
    await user.click(await screen.findByRole("option", { name: "Automatic" }));
    await user.click(override.getByRole("checkbox", { name: "Use bot default" }));
    await user.click(override.getByRole("button", { name: /Work location:/ }));
    await user.click(await screen.findByRole("menuitem", { name: /Windows app/ }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0].routes[0]).toEqual(first);
    expect(save.mock.calls[0]![0].routes[1].target).toEqual({ kind: "agent", agent_id: "agent-2", runtime_id: null, project_id: null, runtime_workspace_id: "directory-1" });
  });

  it("keeps separators while typing and submits complete deduplicated match lists on Enter", async () => {
    const user = userEvent.setup();
    renderForm(botFixture({ routes: [route("Commands", "agent-1")] }));
    const commands = screen.getByLabelText("Commands");
    await user.type(commands, "build,");
    expect(commands).toHaveValue("build,");
    await user.type(commands, " deploy，build");
    expect(commands).toHaveValue("build, deploy，build");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0].routes[0].match.commands).toEqual(["build", "deploy"]);
  });

  it("creates a Bot with the allowlist disabled by default", async () => {
    const user = userEvent.setup();
    renderForm(null);
    expect(screen.getByRole("switch", { name: "Use sender allowlist" })).not.toBeChecked();
    await user.type(screen.getByLabelText("Bot name"), "New bot");
    await user.type(screen.getByLabelText("App ID"), "app_new");
    await user.type(screen.getByLabelText("App Secret"), "new-token");
    await user.click(screen.getByRole("combobox", { name: "Connection host Runtime" }));
    await user.click(await screen.findByRole("option", { name: "Mac host · codex" }));
    await user.click(screen.getByRole("combobox", { name: "Agent" }));
    await user.click(await screen.findByRole("option", { name: "General agent" }));
    await user.click(screen.getByRole("button", { name: "Create bot" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toMatchObject({ workspace_id: "ws-1", name: "New bot", allowlist_enabled: false, enabled: false, routes: [] });
  });

  it("keeps the connection host independent and reports an incompatible execution Runtime after changing agent", async () => {
    const user = userEvent.setup();
    mockApi.listAgents.mockResolvedValue([
      { id: "agent-1", name: "General agent", provider: "codex", archived_at: null },
      { id: "agent-2", name: "Other engine", provider: "claude", archived_at: null },
    ]);
    renderForm(botFixture({ default_target: { kind: "agent", agent_id: "agent-1", runtime_id: "runtime-1" } }));
    await user.click(screen.getByRole("combobox", { name: "Agent" }));
    await user.click(await screen.findByRole("option", { name: "Other engine" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The selected Runtime cannot run this agent");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Execution Runtime" })).toHaveTextContent("Mac host");
    await user.click(screen.getByRole("combobox", { name: "Connection host Runtime" }));
    await user.click(await screen.findByRole("option", { name: "Windows host · codex" }));
    await user.click(screen.getByRole("combobox", { name: "Execution Runtime" }));
    await user.click(await screen.findByRole("option", { name: "Automatic" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toMatchObject({
      default_target: { agent_id: "agent-2", runtime_id: null },
      platform_bindings: [{ host_runtime_id: "runtime-2" }],
    });
  });

  it.each([
    { defaultLocation: { project_id: "project-1", runtime_workspace_id: null }, partialLocation: { runtime_workspace_id: null }, label: "Project One" },
    { defaultLocation: { project_id: null, runtime_workspace_id: "directory-1" }, partialLocation: { project_id: null }, label: "Windows app" },
  ])("shows the effective partial location inheritance without changing the saved overrides: $label", async ({ defaultLocation, partialLocation, label }) => {
    const user = userEvent.setup();
    mockApi.listProjects.mockResolvedValue({ projects: [{ id: "project-1", title: "Project One", archived_at: null }] });
    const target = { kind: "agent" as const, agent_id: "agent-1", ...partialLocation };
    const routed = { id: "partial", name: "Partial", match: {}, target };
    renderForm(botFixture({
      default_target: { kind: "agent", agent_id: "agent-1", ...defaultLocation },
      routes: [routed],
      issue_notifications: { platform_binding_id: "binding-1", chat_id: "oc_updates", target },
    }));
    const rule = within(screen.getByRole("group", { name: "Rule 1" }));
    expect(await rule.findByRole("button", { name: `Work location: ${label}` })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: `Work location: ${label}` })).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0].routes[0].target).toEqual(target);
    expect(save.mock.calls[0]![0].issue_notifications.target).toEqual(target);
  });

  it("creates accounts and routes on LAN HTTP when crypto.randomUUID is unavailable", async () => {
    const user = userEvent.setup();
    const getRandomValues = vi.fn(globalThis.crypto.getRandomValues.bind(globalThis.crypto));
    vi.stubGlobal("crypto", { getRandomValues });
    renderForm(null);
    await user.click(screen.getByRole("button", { name: "Add account" }));
    await user.click(screen.getByRole("button", { name: "Add rule" }));
    expect(screen.getByRole("group", { name: "Account 1" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Account 2" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Rule 1" })).toBeInTheDocument();
    expect(getRandomValues).toHaveBeenCalledTimes(3);
  });

  it("retains the draft and replacement secret when saving fails", async () => {
    const user = userEvent.setup();
    save.mockRejectedValue(new Error("save failed"));
    renderForm();
    await user.type(screen.getByLabelText("Bot name"), " unsaved");
    await user.type(screen.getByLabelText("App Secret"), "replacement-token");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText("Bot name")).toHaveValue("Assistant unsaved");
    expect(screen.getByLabelText("App Secret")).toHaveValue("replacement-token");
    expect(dirty).not.toHaveBeenCalledWith(false);
  });
});
