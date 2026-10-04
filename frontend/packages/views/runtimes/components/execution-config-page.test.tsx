import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import en from "../../locales/en/runtimes.json";
import { ExecutionConfigPage, RuntimeExecutionBindings } from "./execution-config-page";

const api = vi.hoisted(() => ({ listExecutionProfiles: vi.fn(), listExecutionGroups: vi.fn(), listRuntimes: vi.fn(), listMembers: vi.fn(), saveExecutionGroup: vi.fn(), saveExecutionProfile: vi.fn(), deleteExecutionGroup: vi.fn(), deleteExecutionProfile: vi.fn() }));
vi.mock("@multiremi/core/api", () => ({ api }));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws" }));
vi.mock("@multiremi/core/paths", () => ({ useWorkspacePaths: () => ({ runtimes: () => "/ws/runtimes", executionGroups: () => "/ws/execution-groups", agents: () => "/ws/agents" }) }));
vi.mock("@multiremi/core/auth", () => ({ useAuthStore: (selector: (s: unknown) => unknown) => selector({ user: { id: "owner" } }) }));
vi.mock("../../navigation", () => ({ AppLink: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("../../layout/breadcrumb-header", () => ({ BreadcrumbHeader: ({ leaf }: { leaf: React.ReactNode }) => <h1>{leaf}</h1> }));
const profile = { id: "p1", workspace_id: "ws", name: "Aiden", provider: "codex", revision: 1, profile: { name: "custom", base_url: "https://example.test", model: "test-model", env_key: "", auth_mode: "api_key", credential_id: "cred" }, created_at: "now", updated_at: "now" };
const group = { id: "g1", workspace_id: "ws", name: "Codex team", description: "Build and review", provider: "codex", profile_id: "p1", runtime_ids: ["r1"], online_runtime_count: 1, members: [{ runtime_id: "r1", status: "ready" }] };
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  api.listMembers.mockResolvedValue([{ user_id: "owner", role: "owner" }]);
  api.listExecutionProfiles.mockResolvedValue({ profiles: [profile, { ...profile, id: "p2", provider: "claude", name: "Claude only" }] });
  api.listExecutionGroups.mockResolvedValue({ groups: [group] });
  api.listRuntimes.mockResolvedValue([{ id: "r1", name: "Devbox Codex", provider: "codex" }, { id: "r2", name: "Local Codex", provider: "codex" }, { id: "r3", name: "Claude runtime", provider: "claude" }]);
  api.saveExecutionGroup.mockResolvedValue({ group });
  api.saveExecutionProfile.mockResolvedValue({ profile });
});
function show(component = <ExecutionConfigPage />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<I18nProvider locale="en" resources={{ en: { runtimes: en } }}><QueryClientProvider client={client}>{component}</QueryClientProvider></I18nProvider>);
}

it("creates another group with the same Runtime and restricts profiles and runtimes by provider", async () => {
  const user = userEvent.setup();
  show();
  await user.click(await screen.findByRole("button", { name: "Add group" }));
  await user.type(screen.getByLabelText("Name"), "Second group");
  expect(screen.queryByRole("option", { name: "Claude only" })).not.toBeInTheDocument();
  expect(screen.queryByRole("checkbox", { name: "Claude runtime" })).not.toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText("Provider connection"), "p1");
  await user.click(screen.getByRole("checkbox", { name: "Devbox Codex" }));
  await user.click(screen.getByRole("checkbox", { name: "Local Codex" }));
  await user.click(screen.getByRole("button", { name: "Save group" }));
  await waitFor(() => expect(api.saveExecutionGroup).toHaveBeenCalledWith("ws", undefined, { name: "Second group", description: "", provider: "codex", profile_id: "p1", runtime_ids: ["r1", "r2"] }));
});

it("retains an existing credential when editing a profile without a new key", async () => {
  const user = userEvent.setup();
  show();
  await screen.findByText("Claude only");
  await user.click(within(screen.getByRole("article", { name: "Aiden" })).getByRole("button", { name: "Edit" }));
  expect(screen.getByLabelText("API key")).toHaveValue("");
  await user.click(screen.getByRole("button", { name: "Save connection" }));
  await waitFor(() => expect(api.saveExecutionProfile).toHaveBeenCalledWith("ws", "p1", { name: "Aiden", provider: "codex", profile: profile.profile }));
});

it("saves an optional model allowlist while always including the default", async () => {
  const user = userEvent.setup();
  show();
  await screen.findByText("Claude only");
  await user.click(within(screen.getByRole("article", { name: "Aiden" })).getByRole("button", { name: "Edit" }));
  await user.type(screen.getByLabelText(/Allowed model IDs/), "alternate\ntest-model\nalternate");
  await user.click(screen.getByRole("button", { name: "Save connection" }));
  await waitFor(() => expect(api.saveExecutionProfile).toHaveBeenCalledWith("ws", "p1", {
    name: "Aiden", provider: "codex", profile: { ...profile.profile, models: ["test-model", "alternate"] },
  }));
});

it("preserves an explicit default-only allowlist when editing other profile fields", async () => {
  const restricted = { ...profile, profile: { ...profile.profile, models: [profile.profile.model] } };
  api.listExecutionProfiles.mockResolvedValue({ profiles: [restricted] });
  const user = userEvent.setup();
  show();
  await waitFor(() => expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(2));
  await user.click(within(screen.getByRole("article", { name: "Aiden" })).getByRole("button", { name: "Edit" }));
  expect(await screen.findByLabelText(/Allowed model IDs/)).toHaveValue("test-model");
  await user.click(screen.getByRole("button", { name: "Save connection" }));
  await waitFor(() => expect(api.saveExecutionProfile).toHaveBeenCalledWith("ws", "p1", {
    name: "Aiden", provider: "codex", profile: restricted.profile,
  }));
});

it("shows every binding and an unconfirmed state without inventing successful application", async () => {
  api.listExecutionGroups.mockResolvedValue({ groups: [group, { ...group, id: "g2", name: "Second group", members: [] }] });
  show(<RuntimeExecutionBindings runtimeId="r1" />);
  expect(await screen.findByText("Codex team")).toBeInTheDocument();
  expect(screen.getByText("Second group")).toBeInTheDocument();
  expect(screen.getByText("Applied")).toBeInTheDocument();
  expect(screen.getByText("Unconfirmed")).toBeInTheDocument();
  expect(screen.getByRole("link")).toHaveAttribute("href", "/ws/execution-groups");
});

it("configures provider credentials and models inside a new group with a single save", async () => {
  const user = userEvent.setup();
  show();
  await user.click(await screen.findByRole("button", { name: "Add group" }));
  await user.type(screen.getByLabelText("Name"), "Review pool");
  await user.type(screen.getByLabelText("Purpose and organization"), "Review services");
  await user.selectOptions(screen.getByLabelText("Provider connection"), "new");
  await user.type(screen.getByLabelText("Connection name"), "Review gateway");
  await user.type(screen.getByLabelText("API base URL"), "https://example.test/v1");
  await user.type(screen.getByLabelText("Model ID"), "default-model");
  await user.type(screen.getByLabelText(/Allowed model IDs/), "fast-model");
  await user.type(screen.getByLabelText("API key"), "synthetic-key");
  await user.click(screen.getByRole("checkbox", { name: "Local Codex" }));
  await user.click(screen.getByRole("button", { name: "Save group" }));
  await waitFor(() => expect(api.saveExecutionGroup).toHaveBeenCalledWith("ws", undefined, {
    name: "Review pool", description: "Review services", provider: "codex", profile_id: null, runtime_ids: ["r2"],
    connection: { name: "Review gateway", profile: { name: "custom", base_url: "https://example.test/v1", model: "default-model", models: ["default-model", "fast-model"], auth_mode: "api_key", env_key: "" }, api_key: "synthetic-key" },
  }));
  expect(api.saveExecutionProfile).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("API key")).not.toBeInTheDocument();
});

it("explains shared updates and keeps the key hidden while editing a group's connection", async () => {
  api.listExecutionGroups.mockResolvedValue({ groups: [group, { ...group, id: "g2", name: "Review pool" }] });
  const user = userEvent.setup();
  show();
  await user.click(within(await screen.findByRole("article", { name: "Codex team" })).getByRole("button", { name: "Edit" }));
  await user.click(screen.getByRole("button", { name: "Edit provider and models" }));
  expect(screen.getByText(/shared by 2 groups/)).toBeInTheDocument();
  expect(screen.getByLabelText("API key")).toHaveValue("");
  await user.clear(screen.getByLabelText("Model ID"));
  await user.type(screen.getByLabelText("Model ID"), "new-default");
  await user.click(screen.getByRole("button", { name: "Save group" }));
  await waitFor(() => expect(api.saveExecutionGroup).toHaveBeenCalledWith("ws", "g1", expect.objectContaining({
    profile_id: "p1", connection: { name: "Aiden", profile: { ...profile.profile, model: "new-default" } },
  })));
});

it("clears connection, secret, model and membership drafts when changing engines", async () => {
  const user = userEvent.setup();
  show();
  await user.click(await screen.findByRole("button", { name: "Add group" }));
  await user.type(screen.getByLabelText("Name"), "Claude team");
  await user.selectOptions(screen.getByLabelText("Provider connection"), "new");
  await user.type(screen.getByLabelText("API key"), "codex-only-key");
  await user.type(screen.getByLabelText("Model ID"), "codex-only-model");
  await user.click(screen.getByRole("checkbox", { name: "Local Codex" }));
  await user.selectOptions(screen.getByLabelText("Execution engine"), "claude");
  expect(screen.queryByLabelText("API key")).not.toBeInTheDocument();
  expect(screen.queryByRole("checkbox", { name: "Local Codex" })).not.toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText("Provider connection"), "new");
  expect(screen.getByLabelText("API key")).toHaveValue("");
  expect(screen.getByLabelText("Model ID")).toHaveValue("");
  await user.selectOptions(screen.getByLabelText("Provider connection"), "native");
  await user.click(screen.getByRole("button", { name: "Save group" }));
  await waitFor(() => expect(api.saveExecutionGroup).toHaveBeenCalledWith("ws", undefined, { name: "Claude team", description: "", provider: "claude", profile_id: null, runtime_ids: [] }));
});

it("keeps the editor and error visible on failure without issuing a separate profile write", async () => {
  api.saveExecutionGroup.mockRejectedValueOnce(new Error("Runtime is no longer available"));
  const user = userEvent.setup();
  show();
  await user.click(await screen.findByRole("button", { name: "Add group" }));
  await user.type(screen.getByLabelText("Name"), "Keep my draft");
  await user.click(screen.getByRole("button", { name: "Save group" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Runtime is no longer available");
  expect(screen.getByLabelText("Name")).toHaveValue("Keep my draft");
  expect(api.saveExecutionProfile).not.toHaveBeenCalled();
});

it("organizes groups by purpose and engine while members have a read-only view", async () => {
  api.listMembers.mockResolvedValue([{ user_id: "owner", role: "member" }]);
  api.listExecutionGroups.mockResolvedValue({ groups: [group, { ...group, id: "g2", name: "Writing", description: "Documentation", provider: "claude", profile_id: "p2" }] });
  const user = userEvent.setup();
  show();
  await screen.findByRole("article", { name: "Codex team" });
  expect(screen.queryByRole("button", { name: "Add group" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  await user.type(screen.getByRole("textbox", { name: "Search groups" }), "review");
  expect(screen.getByRole("article", { name: "Codex team" })).toBeInTheDocument();
  expect(screen.queryByRole("article", { name: "Writing" })).not.toBeInTheDocument();
  await user.clear(screen.getByRole("textbox", { name: "Search groups" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "Filter by engine" }), "claude");
  expect(screen.queryByRole("article", { name: "Codex team" })).not.toBeInTheDocument();
  expect(screen.getByRole("article", { name: "Writing" })).toBeInTheDocument();
});

it("keeps the selected engine visible after deleting its last group", async () => {
  const otherGroup = { ...group, id: "g2", name: "Writing", provider: "claude", profile_id: "p2" };
  api.listExecutionGroups.mockResolvedValue({ groups: [group, otherGroup] });
  api.deleteExecutionGroup.mockResolvedValue(undefined);
  const user = userEvent.setup();
  show();
  await screen.findByRole("article", { name: "Codex team" });
  const filter = screen.getByRole("combobox", { name: "Filter by engine" });
  await user.selectOptions(filter, "codex");
  api.listExecutionGroups.mockResolvedValue({ groups: [otherGroup] });
  await user.click(within(screen.getByRole("article", { name: "Codex team" })).getByRole("button", { name: "Delete" }));
  expect(await screen.findByText("No matching groups.")).toBeInTheDocument();
  expect(filter).toHaveValue("codex");
  await user.selectOptions(filter, "all");
  expect(screen.getByRole("article", { name: "Writing" })).toBeInTheDocument();
});
