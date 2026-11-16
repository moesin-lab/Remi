import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { AgentRuntime } from "@multiremi/core/types";
import en from "../../locales/en/runtimes.json";
import { ExecutionConfigPage, RuntimeExecutionBindings } from "./execution-config-page";

const api = vi.hoisted(() => ({ listExecutionEndpoints: vi.fn(), getExecutionEndpointCatalog: vi.fn(), inspectExecutionEndpoint: vi.fn(), listExecutionGroups: vi.fn(), listRuntimes: vi.fn(), listFleetModels: vi.fn(), listMembers: vi.fn(), saveExecutionGroup: vi.fn(), saveExecutionEndpoint: vi.fn(), deleteExecutionGroup: vi.fn(), deleteExecutionEndpoint: vi.fn() }));
vi.mock("@multiremi/core/api", () => ({ api }));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws" }));
vi.mock("@multiremi/core/paths", () => ({ useWorkspacePaths: () => ({ runtimes: () => "/ws/runtimes", executionGroups: () => "/ws/execution-groups", agents: () => "/ws/agents" }) }));
vi.mock("@multiremi/core/auth", () => ({ useAuthStore: (selector: (s: unknown) => unknown) => selector({ user: { id: "owner" } }) }));
vi.mock("../../navigation", () => ({ AppLink: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("../../layout/breadcrumb-header", () => ({ BreadcrumbHeader: ({ leaf }: { leaf: React.ReactNode }) => <h1>{leaf}</h1> }));
const profile = { id: "p1", workspace_id: "ws", name: "Aiden", revision: 1, connection: { base_url: "https://example.test", protocols: ["openai-responses"], env_key: "", auth_mode: "api_key", auth_header: "bearer", credential_id: "cred" }, created_at: "now", updated_at: "now" };
const group = { id: "g1", workspace_id: "ws", name: "Codex team", description: "Build and review", provider: "codex", profile_id: "p1", endpoint_id: "p1", connection_mode: "endpoint", model_policy: {}, runtime_ids: ["r1"], online_runtime_count: 1, members: [{ runtime_id: "r1", status: "ready" }] };
function makeRuntime(id: string, name: string, provider = "codex", overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    id, name, provider, workspace_id: "ws", daemon_id: null, runtime_mode: "local",
    launch_header: "", status: "online", device_info: "", metadata: {}, owner_id: "owner",
    visibility: "private", last_seen_at: null, created_at: "now", updated_at: "now",
    ...overrides,
  };
}
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  api.getExecutionEndpointCatalog.mockResolvedValue({ catalogs: [] });
  api.listMembers.mockResolvedValue([{ user_id: "local", role: "owner" }]);
  api.listExecutionEndpoints.mockResolvedValue({ endpoints: [profile, { ...profile, id: "p2", connection: { ...profile.connection, protocols: ["anthropic-messages"] }, name: "Claude only" }] });
  api.listExecutionGroups.mockResolvedValue({ groups: [group] });
  api.listFleetModels.mockReset().mockResolvedValue({ providers: [{ provider: "codex", model_catalog_status: "ready", models: [{ id: "discovered-model", label: "Discovered model", execution_status: "available" }] }] });
  api.listRuntimes.mockResolvedValue([makeRuntime("r1", "Devbox Codex"), makeRuntime("r2", "Local Codex"), makeRuntime("r3", "Claude runtime", "claude")]);
  api.saveExecutionGroup.mockResolvedValue({ group });
  api.saveExecutionEndpoint.mockResolvedValue({ profile });
});
function show(component = <ExecutionConfigPage />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return { ...render(<I18nProvider locale="en" resources={{ en: { runtimes: en } }}><QueryClientProvider client={client}>{component}</QueryClientProvider></I18nProvider>), client };
}

it("shares an endpoint across engines while selecting compatible runtimes", async () => {
  api.listExecutionEndpoints.mockResolvedValue({ endpoints: [{ ...profile, connection: { ...profile.connection, protocols: ["openai-responses", "anthropic-messages"] } }] });
  const user = userEvent.setup(); show();
  await user.click(await screen.findByRole("button", { name: "Add group" }));
  await user.type(screen.getByLabelText("Name"), "Claude team");
  await user.selectOptions(screen.getByLabelText("Execution engine"), "claude");
  await user.selectOptions(screen.getByLabelText("Connection endpoint"), "p1");
  expect(screen.queryByRole("checkbox", { name: /Devbox Codex/ })).not.toBeInTheDocument();
  await user.click(screen.getByRole("checkbox", { name: /Claude runtime/ }));
  await user.click(screen.getByRole("button", { name: "Save group" }));
  await waitFor(() => expect(api.saveExecutionGroup).toHaveBeenCalledWith("ws", undefined, {
    name: "Claude team", description: "", provider: "claude", endpoint_id: "p1", runtime_ids: ["r3"], model_policy: {},
  }));
});
it("creates an endpoint without engine or model fields", async () => {
  const user = userEvent.setup(); show();
  await user.click(await screen.findByRole("button", { name: "Add endpoint" }));
  await user.type(screen.getByLabelText("Name"), "Shared gateway");
  await user.type(screen.getByLabelText("API base URL"), "https://gateway.test");
  await user.type(screen.getByLabelText("API key"), "test-key");
  await user.click(screen.getByRole("checkbox", { name: "anthropic-messages" }));
  expect(screen.queryByLabelText("Model ID")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Execution engine")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Save endpoint" }));
  await waitFor(() => expect(api.saveExecutionEndpoint).toHaveBeenCalledWith("ws", undefined, {
    name: "Shared gateway", connection: { base_url: "https://gateway.test", protocols: ["openai-responses", "anthropic-messages"],
      auth_mode: "api_key", env_key: "", auth_header: "bearer" }, api_key: "test-key",
  }));
});
it("keeps credentials when editing an endpoint without a replacement", async () => {
  const user = userEvent.setup(); show();
  await user.click(within(await screen.findByRole("article", { name: "Aiden" })).getByRole("button", { name: "Edit" }));
  expect(screen.getByLabelText("API key")).toHaveValue("");
  await user.click(screen.getByRole("button", { name: "Save endpoint" }));
  await waitFor(() => expect(api.saveExecutionEndpoint).toHaveBeenCalledWith("ws", "p1", { name: "Aiden", connection: profile.connection }));
});
it("stores model policy on the group without mutating its shared endpoint", async () => {
  const user = userEvent.setup(); show();
  await user.click(within(await screen.findByRole("article", { name: "Codex team" })).getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Model ID"), { target: { value: "fast" } });
  fireEvent.change(screen.getByLabelText(/Allowed models/), { target: { value: "fast\nlarge" } });
  await user.click(screen.getByRole("button", { name: "Save group" }));
  await waitFor(() => expect(api.saveExecutionGroup).toHaveBeenCalledWith("ws", "g1", expect.objectContaining({
    endpoint_id: "p1", model_policy: { model: "fast", models: ["fast", "large"] },
  })));
  expect(api.saveExecutionEndpoint).not.toHaveBeenCalled();
});
it("uses explicit local sign-in and explains that workspace gateways are not inherited", async () => {
  const user = userEvent.setup(); show();
  await user.click(await screen.findByRole("button", { name: "Add group" }));
  await user.type(screen.getByLabelText("Name"), "Local");
  expect(screen.getByLabelText("Connection endpoint")).toHaveValue("native");
  expect(screen.getByText(en.configuration.native_models)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Save group" }));
  await waitFor(() => expect(api.saveExecutionGroup).toHaveBeenCalledWith("ws", undefined, expect.objectContaining({ endpoint_id: null })));
});
it("preserves missing runtime IDs and disables deletion of referenced endpoints", async () => {
  api.listExecutionGroups.mockResolvedValue({ groups: [{ ...group, runtime_ids: ["missing-runtime"] }] });
  const user = userEvent.setup(); show();
  const row = within(await screen.findByRole("article", { name: "Aiden" }));
  expect(row.getByRole("button", { name: "Delete" })).toBeDisabled();
  await user.click(within(screen.getByRole("article", { name: "Codex team" })).getByRole("button", { name: "Edit" }));
  expect(screen.getByRole("checkbox", { name: /missing-runtime/ })).toBeChecked();
});
it("does not expose writes when configuration or membership loading fails", async () => {
  api.listExecutionEndpoints.mockRejectedValue(new Error("offline")); show();
  expect(await screen.findByRole("alert")).toHaveTextContent(en.configuration.load_error);
  expect(screen.getByRole("button", { name: "Add group" })).toBeDisabled();
});
it("filters groups and preserves binding statuses", async () => {
  api.listExecutionGroups.mockResolvedValue({ groups: [group, { ...group, id: "g2", name: "Second group", members: [] }] });
  show(<RuntimeExecutionBindings runtimeId="r1" />);
  expect(await screen.findByText("Codex team")).toBeInTheDocument();
  expect(screen.getByText("Second group")).toBeInTheDocument();
  expect(screen.getByText("Applied")).toBeInTheDocument();
  expect(screen.getByText("Unconfirmed")).toBeInTheDocument();
});
it("shows discovered models and errors without requiring manually configured model names", async () => {
  show();
  const row = within(await screen.findByRole("article", { name: "Codex team" }));
  expect(await row.findByText(/Discovered model/)).toBeInTheDocument();
});
it("limits endpoint choices by protocol, including Antigravity", async () => {
  const user = userEvent.setup(); show();
  await user.click(await screen.findByRole("button", { name: "Add group" }));
  expect(screen.queryByRole("option", { name: "Claude only" })).not.toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText("Execution engine"), "antigravity");
  expect(screen.queryByRole("option", { name: "Aiden" })).not.toBeInTheDocument();
  await user.type(screen.getByLabelText("Name"), "Local Antigravity");
  await user.click(screen.getByRole("button", { name: "Save group" }));
  await waitFor(() => expect(api.saveExecutionGroup).toHaveBeenCalledWith("ws", undefined, expect.objectContaining({ provider: "antigravity", endpoint_id: null })));
});

it("cross-filters capability groups by endpoint linkage and local sign-in", async () => {
  api.listExecutionGroups.mockResolvedValue({
    groups: [
      group,
      { ...group, id: "g-native", name: "Native Claude", provider: "claude", profile_id: null, endpoint_id: null, connection_mode: "native" },
    ],
  });
  const user = userEvent.setup(); show();
  expect(await screen.findByRole("article", { name: "Codex team" })).toBeInTheDocument();
  expect(screen.getByRole("article", { name: "Native Claude" })).toBeInTheDocument();

  const endpointCard = within(screen.getByRole("article", { name: "Aiden" }));
  await user.click(endpointCard.getByRole("button", { name: /Used by 1 group/ }));
  expect(screen.getByRole("article", { name: "Codex team" })).toBeInTheDocument();
  expect(screen.queryByRole("article", { name: "Native Claude" })).not.toBeInTheDocument();

  await user.click(screen.getAllByRole("button", { name: "Clear filters" })[0]!);
  expect(screen.getByRole("article", { name: "Native Claude" })).toBeInTheDocument();

  const groupsRegion = within(screen.getByRole("region", { name: "Capability groups" }));
  await user.click(groupsRegion.getAllByRole("button", { name: "Local sign-in" })[0]!);
  expect(screen.queryByRole("article", { name: "Codex team" })).not.toBeInTheDocument();
  expect(screen.getByRole("article", { name: "Native Claude" })).toBeInTheDocument();
});

it("collapses large discovered model catalogs and expands on demand", async () => {
  api.listFleetModels.mockResolvedValue({
    providers: [{
      provider: "codex",
      model_catalog_status: "ready",
      models: ["m1", "m2", "m3", "m4", "m5", "m6"].map((id) => ({ id, label: id, execution_status: "available" })),
    }],
  });
  const user = userEvent.setup(); show();
  const card = within(await screen.findByRole("article", { name: "Codex team" }));
  expect(await card.findByText("m1")).toBeInTheDocument();
  expect(card.queryByText("m6")).not.toBeInTheDocument();
  await user.click(card.getByRole("button", { name: "Show all (6)" }));
  expect(card.getByText("m6")).toBeInTheDocument();
  await user.click(card.getByRole("button", { name: "Show less" }));
  expect(card.queryByText("m6")).not.toBeInTheDocument();
});

it("opens and focuses manual model entry from the model list", async () => {
  const user = userEvent.setup(); show();
  const endpoint = await screen.findByRole("article", { name: "Aiden" });
  await user.click(within(endpoint).getByRole("button", { name: "Edit" }));
  await user.click(screen.getByRole("button", { name: "Add model" }));
  const input = screen.getByLabelText("Manual models", { exact: true });
  expect(input).toHaveFocus();
  expect(input.closest("details")).toHaveAttribute("open");
  await user.type(input, "my-deployment");
  await user.click(screen.getByRole("button", { name: "Save endpoint" }));
  await waitFor(() => expect(api.saveExecutionEndpoint).toHaveBeenCalledWith("ws", "p1", expect.objectContaining({
    connection: expect.objectContaining({ options: { manual_models: [{ id: "my-deployment", source: "manual" }] } }),
  })));
});
