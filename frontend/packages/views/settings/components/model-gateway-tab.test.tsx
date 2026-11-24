import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enSettings from "../../locales/en/settings.json";
import { ModelGatewayTab } from "./model-gateway-tab";
const api = vi.hoisted(() => ({ listMembers: vi.fn(), listExecutionEndpoints: vi.fn(), getSystemModelEndpoints: vi.fn(), saveSystemModelEndpoints: vi.fn(), updateWorkspace: vi.fn(), getRelayConfig: vi.fn(), inspectExecutionEndpoint: vi.fn(), getExecutionEndpointCatalog: vi.fn() }));
const workspace = { id: "ws", settings: {} as Record<string, unknown> };
const chat = "openai-chat-completions";
const messages = "anthropic-messages";
const codex = { hasToken: true, fragment: '[model_providers.gateway]\nbase_url="https://example.test/v1"' };
const claude = { hasToken: true, fragment: '{"env":{"ANTHROPIC_BASE_URL":"https://example.test"}}' };
vi.mock("@multiremi/core/api", () => ({ api }));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => workspace.id }));
vi.mock("@multiremi/core/paths", () => ({ useCurrentWorkspace: () => workspace, useWorkspacePaths: () => ({ executionGroups: () => "/ws/execution-groups" }) }));
vi.mock("../../navigation", () => ({ AppLink: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  workspace.id = "ws";
  workspace.settings = {};
  api.getRelayConfig.mockResolvedValue({ codex, claude });
  api.getExecutionEndpointCatalog.mockResolvedValue({ catalogs: [] });
  api.listMembers.mockResolvedValue([{ user_id: "local", role: "owner" }]);
  api.listExecutionEndpoints.mockResolvedValue({ endpoints: [
    { id: "e1", name: "Shared", revision: 2, connection: { protocols: [chat, messages], auth_mode: "api_key", credential_id: "cred", base_url: "https://example.test" } },
    { id: "e2", name: "Machine secret", connection: { protocols: ["openai-chat-completions"], auth_mode: "env" } },
  ] });
  api.getSystemModelEndpoints.mockResolvedValue({ defaults: { "openai-chat-completions": null, "anthropic-messages": null } });
  api.saveSystemModelEndpoints.mockResolvedValue({ defaults: { "openai-chat-completions": "e1", "anthropic-messages": null } });
});
function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => <I18nProvider locale="en" resources={{ en: { settings: enSettings } }}><QueryClientProvider client={client}><ModelGatewayTab /></QueryClientProvider></I18nProvider>;
  const view = render(tree());
  return { client, reopen: () => view.rerender(tree()), ...view };
}
it("selects an existing endpoint for system AI without a second credentials form", async () => {
  const user = userEvent.setup(); show();
  const select = await screen.findByRole("combobox", { name: "openai-chat-completions" });
  expect(screen.queryByRole("option", { name: "Machine secret" })).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/API key/i)).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: enSettings.modelGateway.manage_endpoints })).toHaveAttribute("href", "/ws/execution-groups");
  await user.selectOptions(select, "e1");
  await waitFor(() => expect(api.saveSystemModelEndpoints).toHaveBeenCalledWith("ws", { "openai-chat-completions": "e1" }));
  expect(api.updateWorkspace).not.toHaveBeenCalled();
});
it("does not render a writable endpoint selection before settings load", async () => {
  api.getSystemModelEndpoints.mockReturnValue(new Promise(() => {})); show();
  expect(await screen.findByTestId("model-gateway-skeleton")).toBeInTheDocument();
  expect(screen.queryByRole("combobox", { name: "openai-chat-completions" })).not.toBeInTheDocument();
});
it("does not render an endpoint selection on query failure", async () => {
  api.getSystemModelEndpoints.mockRejectedValue(new Error("offline")); show();
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(screen.queryByRole("combobox", { name: "openai-chat-completions" })).not.toBeInTheDocument();
});
it("denies non-admin members without fetching endpoint configuration", async () => {
  api.listMembers.mockResolvedValue([{ user_id: "local", role: "member" }]); show();
  expect(await screen.findByText(enSettings.modelGateway.insufficient)).toBeInTheDocument();
  expect(api.listExecutionEndpoints).not.toHaveBeenCalled();
  expect(api.getRelayConfig).not.toHaveBeenCalled();
  expect(api.getExecutionEndpointCatalog).not.toHaveBeenCalled();
  expect(api.inspectExecutionEndpoint).not.toHaveBeenCalled();
});

function bind(chatId: string | null, messagesId: string | null) {
  api.getSystemModelEndpoints.mockResolvedValue({ defaults: { [chat]: chatId, [messages]: messagesId } });
}
function snapshot(protocol: string, id: string, revision = 2, checked = new Date().toISOString()) {
  return { protocol, revision, models_revision: revision, last_checked_at: checked, last_success_at: checked,
    state: "ok", models: [{ id, name: `Display ${id}` }] };
}
function options(field: string) {
  return Array.from(document.querySelectorAll<HTMLOptionElement>(`#${field}-models option`)).map(option => option.value);
}
const titleField = "issue-auto-title-model";
const chatField = "progress-summary-openai-model";
const messagesField = "progress-summary-claude-model";

it("shares automatic and manual refreshes, keeps protocol catalogs separate, and only saves explicitly", async () => {
  bind("e1", "e1");
  const rows = [snapshot(messages, "claude-id")];
  api.getExecutionEndpointCatalog.mockImplementation(async () => ({ catalogs: [...rows] }));
  api.inspectExecutionEndpoint.mockImplementation(async (_ws, { protocol }) => {
    const row = snapshot(protocol, "chat-id");
    rows.splice(1, 1, row);
    return { persisted: true, inspection: { checked_at: row.last_checked_at, results: [{ protocol, operation: "models", state: "ok" }] } };
  });
  show();
  await waitFor(() => expect(options(titleField)).toEqual(["chat-id"]));
  expect(options(chatField)).toEqual(["chat-id"]);
  expect(options(messagesField)).toEqual(["claude-id"]);
  expect(document.querySelector(`#${titleField}-models option`)).toHaveAttribute("label", "Display chat-id");
  expect(api.inspectExecutionEndpoint.mock.calls).toEqual([["ws", { endpoint_id: "e1", operation: "models", protocol: chat }]]);
  await userEvent.click(screen.getAllByRole("button", { name: enSettings.modelGateway.catalog_refresh })[0]!);
  await waitFor(() => expect(api.inspectExecutionEndpoint).toHaveBeenCalledTimes(2));
  expect(api.saveSystemModelEndpoints).not.toHaveBeenCalled();
  expect(api.updateWorkspace).not.toHaveBeenCalled();
  const choice = document.querySelector<HTMLOptionElement>(`#${titleField}-models option`)!;
  fireEvent.input(screen.getByLabelText(enSettings.modelGateway.auto_title_model_label), { target: { value: choice.value } });
  expect(api.updateWorkspace).not.toHaveBeenCalled();
  api.updateWorkspace.mockImplementation(async (_id, { settings }) => ({ ...workspace, settings }));
  await userEvent.click(screen.getByRole("button", { name: enSettings.modelGateway.auto_title_save }));
  expect(api.updateWorkspace).toHaveBeenCalledWith("ws", { settings: { issue_auto_title: { enabled: true, model: "chat-id" } } });
});

it("shows an expired snapshot immediately and ignores an unpersisted response from another revision", async () => {
  bind("e1", null);
  const old = new Date(Date.now() - 6 * 60 * 1000).toISOString();
  api.getExecutionEndpointCatalog.mockResolvedValue({ catalogs: [snapshot(chat, "old-id", 2, old)] });
  let finish!: (result: unknown) => void;
  api.inspectExecutionEndpoint.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  show();
  await waitFor(() => expect(options(titleField)).toEqual(["old-id"]));
  expect(api.inspectExecutionEndpoint).toHaveBeenCalledTimes(1);
  expect(screen.getAllByText(/Loading models/).length).toBeGreaterThan(0);
  api.getExecutionEndpointCatalog.mockResolvedValue({ catalogs: [snapshot(chat, "new-revision-id", 3)] });
  await act(async () => { finish({ persisted: false, inspection: { results: [{ protocol: chat, operation: "models", state: "ok", models: [{ id: "unconfirmed-id" }] }] } }); });
  await waitFor(() => expect(screen.getAllByText(/Model discovery failed/)).toHaveLength(2));
  expect(options(titleField)).toEqual(["old-id"]);
  expect(api.inspectExecutionEndpoint).toHaveBeenCalledTimes(1);
});

it("keeps old models after an embedded failure, accepts manual IDs and reopens legacy settings", async () => {
  bind("e1", null);
  workspace.settings = { progressSummary: { openAiModel: "retired-id", model: "other-id" }, extra: true };
  const row = snapshot(chat, "cached-id", 1);
  api.getExecutionEndpointCatalog.mockResolvedValue({ catalogs: [row] });
  api.inspectExecutionEndpoint.mockResolvedValue({ persisted: true, inspection: { results: [{ protocol: chat, operation: "models", state: "error", error_code: "upstream_timeout" }] } });
  api.updateWorkspace.mockImplementation(async (_id, { settings }) => ({ ...workspace, settings }));
  const view = show();
  await waitFor(() => expect(screen.getAllByText(/upstream_timeout/)).toHaveLength(2));
  expect(screen.getAllByText(/Last successful check/)).toHaveLength(2);
  expect(options(chatField)).toEqual(["cached-id"]);
  const input = screen.getByDisplayValue("retired-id");
  await userEvent.clear(input);
  await userEvent.type(input, "custom-id");
  expect(api.updateWorkspace).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: enSettings.modelGateway.progress_save }));
  workspace.settings = api.updateWorkspace.mock.calls[0]![1].settings;
  expect(workspace.settings).toMatchObject({ extra: true, progress_summary: { model: "other-id", openai_model: "custom-id" } });
  view.unmount(); show();
  expect(await screen.findByDisplayValue("custom-id")).toBeInTheDocument();
  expect(api.saveSystemModelEndpoints).not.toHaveBeenCalled();
});

it.each([[codex, []], [{ ...codex, hasToken: false }, ["anthropic-id"]], [{ ...codex, fragment: "" }, ["anthropic-id"]]] as const)("matches the title catalog to the effective legacy Chat route (%j)", async (legacy, expected) => {
  bind(null, "e1");
  api.getRelayConfig.mockResolvedValue({ codex: legacy, claude });
  api.getExecutionEndpointCatalog.mockResolvedValue({ catalogs: [snapshot(messages, "anthropic-id")] });
  show();
  await waitFor(() => expect(options(messagesField)).toEqual(["anthropic-id"]));
  await waitFor(() => expect(options(titleField)).toEqual(expected));
  expect(api.inspectExecutionEndpoint).not.toHaveBeenCalled();
});

it("only shows manual models when discovery is disabled", async () => {
  bind("e1", null);
  api.listExecutionEndpoints.mockResolvedValue({ endpoints: [{ id: "e1", revision: 3, connection: { auth_mode: "api_key", protocols: [chat], options: { fetch_models: false, manual_models: [{ id: "manual-id" }] } } }] });
  show();
  expect(await screen.findByText(enSettings.modelGateway.catalog_disabled)).toBeInTheDocument();
  expect(options(chatField)).toEqual(["manual-id"]);
  expect(api.getExecutionEndpointCatalog).not.toHaveBeenCalled();
  expect(api.inspectExecutionEndpoint).not.toHaveBeenCalled();
});

it("retries a first network failure immediately and reports an empty catalog without changing the draft", async () => {
  bind("e1", null);
  api.inspectExecutionEndpoint.mockRejectedValueOnce(new Error("offline"));
  show();
  await waitFor(() => expect(screen.getAllByText(enSettings.modelGateway.catalog_error)).toHaveLength(2));
  const input = screen.getByLabelText(enSettings.modelGateway.progress_openai_model_label);
  await userEvent.type(input, "manual-id");
  const row = { ...snapshot(chat, "unused"), models: [] };
  api.getExecutionEndpointCatalog.mockResolvedValue({ catalogs: [row] });
  api.inspectExecutionEndpoint.mockResolvedValue({ persisted: true, inspection: { checked_at: row.last_checked_at, results: [{ operation: "models", protocol: chat, state: "ok" }] } });
  await userEvent.click(screen.getAllByRole("button", { name: enSettings.modelGateway.catalog_refresh })[0]!);
  await waitFor(() => expect(screen.getAllByText(enSettings.modelGateway.catalog_empty)).toHaveLength(2));
  expect(api.inspectExecutionEndpoint).toHaveBeenCalledTimes(2);
  expect(input).toHaveValue("manual-id");
  expect(api.updateWorkspace).not.toHaveBeenCalled();
});

it.each(["workspace", "endpoint"])("ignores a late refresh after changing %s", async change => {
  bind("e1", null);
  let finish!: (result: unknown) => void;
  api.inspectExecutionEndpoint.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const view = show();
  await waitFor(() => expect(api.inspectExecutionEndpoint).toHaveBeenCalledTimes(1));
  bind(null, null);
  if (change === "workspace") { workspace.id = "next"; view.reopen(); }
  else await act(() => view.client.invalidateQueries({ queryKey: ["system-model-endpoints", "ws"] }));
  await waitFor(() => expect(screen.queryByRole("button", { name: enSettings.modelGateway.catalog_refresh })).not.toBeInTheDocument());
  api.getExecutionEndpointCatalog.mockResolvedValue({ catalogs: [snapshot(chat, "late-id")] });
  await act(async () => { finish({ persisted: true, inspection: { results: [{ protocol: chat, operation: "models", state: "ok" }] } }); });
  expect(options(chatField)).toEqual([]);
  expect(options(titleField)).toEqual([]);
  expect(api.saveSystemModelEndpoints).not.toHaveBeenCalled();
  expect(api.updateWorkspace).not.toHaveBeenCalled();
});
