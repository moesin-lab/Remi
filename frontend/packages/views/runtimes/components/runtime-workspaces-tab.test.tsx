// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { AgentRuntime } from "@multiremi/core/types";
import enRuntimes from "../../locales/en/runtimes.json";
import { RuntimeWorkspacesTab } from "./runtime-workspaces-tab";
import { RuntimeWorkspacePicker } from "./runtime-workspace-picker";

const api = vi.hoisted(() => ({ listRuntimeWorkspaces: vi.fn(), createRuntimeWorkspace: vi.fn(), archiveRuntimeWorkspace: vi.fn() }));
vi.mock("@multiremi/core/api", () => ({ api }));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("../../projects/components/project-picker", () => ({ ProjectPicker: () => <span>Optional project</span> }));
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  api.listRuntimeWorkspaces.mockResolvedValue([]);
});
function show(children: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<I18nProvider locale="en" resources={{ en: { runtimes: enRuntimes } }}>
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  </I18nProvider>);
}

it("registers local paths, retains failed input, and surfaces the server error", async () => {
  const user = userEvent.setup();
  api.createRuntimeWorkspace.mockRejectedValue(new Error("Directory already registered"));
  show(<RuntimeWorkspacesTab runtime={{ id: "runtime-1", daemon_id: "laptop" } as AgentRuntime} canManage />);
  await user.type(screen.getByLabelText("Name"), "Private workbench");
  await user.type(screen.getByLabelText("Root directory"), "C:\\workbench");
  await user.clear(screen.getByLabelText("Working directory (relative)"));
  await user.type(screen.getByLabelText("Working directory (relative)"), "app");
  await user.click(screen.getByRole("button", { name: "Register workspace" }));
  await waitFor(() => expect(api.createRuntimeWorkspace).toHaveBeenCalledWith("runtime-1", {
    name: "Private workbench", root_path: "C:\\workbench", cwd: "app", context_paths: [], env_file: null, project_id: null,
  }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Directory already registered");
  expect(screen.getByLabelText("Root directory")).toHaveValue("C:\\workbench");
});

it("keeps an unavailable workspace selectable and retains a saved missing selection", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  api.listRuntimeWorkspaces.mockResolvedValue([{ id: "rws-1", name: "Laptop", daemon_id: "laptop", root_path: "/local", cwd: ".", status: "unavailable" }]);
  const view = show(<RuntimeWorkspacePicker wsId="ws-1" value="rws-missing" onChange={onChange} />);
  await screen.findByRole("option", { name: /Laptop/ });
  expect(screen.getByRole("combobox")).toHaveValue("rws-missing");
  await user.selectOptions(screen.getByRole("combobox"), "rws-1");
  expect(onChange).toHaveBeenCalledWith("rws-1");
  view.unmount();
  show(<RuntimeWorkspacePicker wsId="ws-1" value="rws-1" onChange={onChange} disabled />);
  expect(screen.getByRole("combobox")).toBeDisabled();
});
