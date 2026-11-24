import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enSettings from "../../locales/en/settings.json";
import { ModelGatewayTab } from "./model-gateway-tab";
const api = vi.hoisted(() => ({ listMembers: vi.fn(), listExecutionEndpoints: vi.fn(), getSystemModelEndpoints: vi.fn(), saveSystemModelEndpoints: vi.fn(), updateWorkspace: vi.fn() }));
vi.mock("@multiremi/core/api", () => ({ api }));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws" }));
vi.mock("@multiremi/core/paths", () => ({ useCurrentWorkspace: () => ({ id: "ws", settings: {} }), useWorkspacePaths: () => ({ executionGroups: () => "/ws/execution-groups" }) }));
vi.mock("../../navigation", () => ({ AppLink: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  api.listMembers.mockResolvedValue([{ user_id: "local", role: "owner" }]);
  api.listExecutionEndpoints.mockResolvedValue({ endpoints: [
    { id: "e1", name: "Shared", connection: { protocols: ["openai-chat-completions", "anthropic-messages"], auth_mode: "api_key" } },
    { id: "e2", name: "Machine secret", connection: { protocols: ["openai-chat-completions"], auth_mode: "env" } },
  ] });
  api.getSystemModelEndpoints.mockResolvedValue({ defaults: { "openai-chat-completions": null, "anthropic-messages": null } });
  api.saveSystemModelEndpoints.mockResolvedValue({ defaults: { "openai-chat-completions": "e1", "anthropic-messages": null } });
});
function show() {
  return render(<I18nProvider locale="en" resources={{ en: { settings: enSettings } }}><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ModelGatewayTab /></QueryClientProvider></I18nProvider>);
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
});
