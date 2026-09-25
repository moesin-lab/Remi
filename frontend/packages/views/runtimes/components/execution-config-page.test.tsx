import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import en from "../../locales/en/runtimes.json";
import { ExecutionConfigPage, RuntimeExecutionBindings } from "./execution-config-page";

const api = vi.hoisted(() => ({ listExecutionProfiles: vi.fn(), listExecutionGroups: vi.fn(), listRuntimes: vi.fn(), listMembers: vi.fn(), saveExecutionGroup: vi.fn(), saveExecutionProfile: vi.fn(), deleteExecutionGroup: vi.fn(), deleteExecutionProfile: vi.fn() }));
vi.mock("@multiremi/core/api", () => ({ api }));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws" }));
vi.mock("@multiremi/core/paths", () => ({ useWorkspacePaths: () => ({ runtimes: () => "/ws/runtimes" }) }));
vi.mock("@multiremi/core/auth", () => ({ useAuthStore: (selector: (s: unknown) => unknown) => selector({ user: { id: "owner" } }) }));
vi.mock("../../navigation", () => ({ AppLink: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("../../layout/breadcrumb-header", () => ({ BreadcrumbHeader: ({ leaf }: { leaf: React.ReactNode }) => <h1>{leaf}</h1> }));
const profile = { id: "p1", workspace_id: "ws", name: "Aiden", provider: "codex", revision: 1, profile: { name: "custom", base_url: "https://example.test", model: "test-model", env_key: "", auth_mode: "api_key", credential_id: "cred" }, created_at: "now", updated_at: "now" };
const group = { id: "g1", workspace_id: "ws", name: "Codex team", provider: "codex", profile_id: "p1", runtime_ids: ["r1"], online_runtime_count: 1, members: [{ runtime_id: "r1", status: "ready" }] };
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
  await user.selectOptions(screen.getByLabelText("Connection profiles"), "p1");
  await user.click(screen.getByRole("checkbox", { name: "Devbox Codex" }));
  await user.click(screen.getByRole("checkbox", { name: "Local Codex" }));
  await user.click(screen.getByRole("button", { name: "Save connection" }));
  await waitFor(() => expect(api.saveExecutionGroup).toHaveBeenCalledWith("ws", undefined, { name: "Second group", provider: "codex", profile_id: "p1", runtime_ids: ["r1", "r2"] }));
});

it("retains an existing credential when editing a profile without a new key", async () => {
  const user = userEvent.setup();
  show();
  await screen.findByText("Claude only");
  const edit = await screen.findAllByRole("button", { name: "Edit" });
  await user.click(edit[0]!);
  expect(screen.getByLabelText("API key")).toHaveValue("");
  await user.click(screen.getByRole("button", { name: "Save connection" }));
  await waitFor(() => expect(api.saveExecutionProfile).toHaveBeenCalledWith("ws", "p1", { name: "Aiden", provider: "codex", profile: profile.profile }));
});

it("shows every binding and an unconfirmed state without inventing successful application", async () => {
  api.listExecutionGroups.mockResolvedValue({ groups: [group, { ...group, id: "g2", name: "Second group", members: [] }] });
  show(<RuntimeExecutionBindings runtimeId="r1" />);
  expect(await screen.findByText("Codex team")).toBeInTheDocument();
  expect(screen.getByText("Second group")).toBeInTheDocument();
  expect(screen.getByText("Applied")).toBeInTheDocument();
  expect(screen.getByText("Unconfirmed")).toBeInTheDocument();
  expect(screen.getByRole("link")).toHaveAttribute("href", "/ws/runtimes/configuration");
});
