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
import { RuntimeDirectoryDialog } from "./runtime-directory-dialog";

const api = vi.hoisted(() => ({ listRuntimeWorkspaces: vi.fn(), createRuntimeWorkspace: vi.fn(), archiveRuntimeWorkspace: vi.fn(), initiateDirectoryScan: vi.fn(), getDirectoryScanResult: vi.fn() }));
vi.mock("@multiremi/core/api", () => ({ api }));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("../../projects/components/project-picker", () => ({ ProjectPicker: () => <span>Optional project</span> }));
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  api.listRuntimeWorkspaces.mockResolvedValue([]);
  api.initiateDirectoryScan.mockImplementation((_id, params) => {
    const path = params.root === "~" ? "/Users/mac" : params.root;
    const child = path === "/Users/mac" ? "workbench" : path === "/Users/mac/workbench" ? "app" : null;
    return Promise.resolve(directoryResult(path, child ? [child] : []));
  });
});
function directoryResult(root: string, children: string[] = []) {
  return { id: "scan-1", status: "completed", supported: true, params: { resolved_root: root },
    candidates: children.map(name => ({ name, path: `${root}/${name}`, remote_url: null, current_branch: null, is_dirty: null })) };
}
const runtime = { id: "runtime-1", daemon_id: "laptop", status: "online", name: "Codex", device_info: "Mac" } as AgentRuntime;
function show(children: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(children, { wrapper: ({ children }) => <I18nProvider locale="en" resources={{ en: { runtimes: enRuntimes } }}>
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  </I18nProvider> });
}

it("registers local paths, retains failed input, and surfaces the server error", async () => {
  const user = userEvent.setup();
  api.createRuntimeWorkspace.mockRejectedValue(new Error("Directory already registered"));
  show(<RuntimeWorkspacesTab runtime={runtime} canManage />);
  await user.click(screen.getByRole("button", { name: "Choose root directory" }));
  await user.click(await screen.findByRole("button", { name: "workbench" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Use this directory" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Use this directory" }));
  expect(screen.getByLabelText("Name")).toHaveValue("workbench");
  await user.clear(screen.getByLabelText("Name"));
  await user.type(screen.getByLabelText("Name"), "Private workbench");
  await user.click(screen.getByRole("button", { name: "Choose subdirectory" }));
  expect(screen.getByRole("button", { name: "Parent directory" })).toBeDisabled();
  await user.click(await screen.findByRole("button", { name: "app" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Use this directory" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Use this directory" }));
  await user.click(screen.getByRole("button", { name: "Register workspace" }));
  await waitFor(() => expect(api.createRuntimeWorkspace).toHaveBeenCalledWith("runtime-1", {
    name: "Private workbench", root_path: "/Users/mac/workbench", cwd: "app", context_paths: [], env_file: null, project_id: null,
  }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Directory already registered");
  expect(screen.getByRole("button", { name: "Choose root directory" })).toHaveTextContent("/Users/mac/workbench");
  expect(screen.getByRole("status")).toHaveTextContent("/Users/mac/workbench/app");
});

it("selects an empty home directory using the path resolved by the remote machine", async () => {
  const user = userEvent.setup();
  const select = vi.fn();
  api.initiateDirectoryScan.mockResolvedValue(directoryResult("C:\\Users\\Alice"));
  show(<RuntimeDirectoryDialog runtimeId="runtime-1" machineName="Windows" initialPath="~" online onSelect={select} onClose={vi.fn()} />);
  expect(await screen.findByText("No subdirectories. You can select this directory.")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Use this directory" }));
  expect(select).toHaveBeenCalledWith("C:\\Users\\Alice");
  expect(api.initiateDirectoryScan).toHaveBeenCalledWith("runtime-1", { root: "~", mode: "browse" });
});

it("does not select stale results after editing a path or a failed directory read", async () => {
  const user = userEvent.setup();
  const select = vi.fn();
  show(<RuntimeDirectoryDialog runtimeId="runtime-1" machineName="Mac" initialPath="~" online onSelect={select} onClose={vi.fn()} />);
  await screen.findByRole("button", { name: "workbench" });
  await user.clear(screen.getByLabelText("Directory path"));
  await user.type(screen.getByLabelText("Directory path"), "/no-access");
  expect(screen.getByRole("button", { name: "Use this directory" })).toBeDisabled();
  api.initiateDirectoryScan.mockRejectedValueOnce(new Error("Permission denied"));
  await user.click(screen.getByRole("button", { name: "Go to directory" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Permission denied");
  expect(screen.getByRole("button", { name: "Use this directory" })).toBeDisabled();
  expect(select).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Home directory" }));
  await screen.findByRole("button", { name: "workbench" });
  expect(screen.getByRole("button", { name: "Use this directory" })).toBeEnabled();
});

it("prevents a working-directory jump outside its shared root", async () => {
  const user = userEvent.setup();
  show(<RuntimeDirectoryDialog runtimeId="runtime-1" machineName="Mac" initialPath="/Users/mac/workbench" boundary="/Users/mac/workbench" online onSelect={vi.fn()} onClose={vi.fn()} />);
  await screen.findByRole("button", { name: "app" });
  await user.clear(screen.getByLabelText("Directory path"));
  await user.type(screen.getByLabelText("Directory path"), "/Users/mac/workbench-other");
  await user.click(screen.getByRole("button", { name: "Go to directory" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Choose a directory inside the shared root.");
  expect(api.initiateDirectoryScan).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Use this directory" })).toBeDisabled();
});

it("does not browse an offline machine and clears selections when the Runtime changes", async () => {
  const user = userEvent.setup();
  const view = show(<RuntimeWorkspacesTab runtime={runtime} canManage />);
  await user.click(screen.getByRole("button", { name: "Choose root directory" }));
  await screen.findByRole("button", { name: "workbench" });
  await user.click(screen.getByRole("button", { name: "Use this directory" }));
  expect(screen.getByLabelText("Name")).toHaveValue("mac");
  // Rerender inside the same provider tree so the component must clear the form.
  view.rerender(<RuntimeWorkspacesTab runtime={{ ...runtime, id: "runtime-2", status: "offline" }} canManage />);
  expect(screen.getByLabelText("Name")).toHaveValue("");
  expect(screen.getByRole("button", { name: "Choose root directory" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Register workspace" })).toBeDisabled();
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
