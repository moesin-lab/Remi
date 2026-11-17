import type { ReactNode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enSettings from "../../locales/en/settings.json";

const updateWorkspace = vi.hoisted(() => vi.fn());
const setQueryData = vi.hoisted(() => vi.fn());
const getQueryData = vi.hoisted(() => vi.fn());
const access = vi.hoisted(() => ({ role: "owner" }));
const navigate = vi.hoisted(() => vi.fn());
const workspaceRef = vi.hoisted(() => ({
  current: {
    id: "workspace-1",
    name: "Acme",
    settings: { retained_setting: "yes" } as Record<string, unknown>,
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: [{ user_id: "local", role: access.role }] }),
  useQueryClient: () => ({ setQueryData, getQueryData }),
  queryOptions: <T,>(options: T) => options,
}));

vi.mock("@multiremi/core/auth", () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) =>
    selector({ user: { id: "user-1" } }),
}));

vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "workspace-1" }));

vi.mock("@multiremi/core/paths", () => ({
  useCurrentWorkspace: () => workspaceRef.current,
  useWorkspacePaths: () => ({ repositories: () => "/acme/repositories" }),
}));

vi.mock("@multiremi/core/workspace/queries", () => ({
  memberListOptions: () => ({ queryKey: ["members"] }),
  workspaceKeys: { list: () => ["workspaces"] },
}));

vi.mock("@multiremi/core/api", () => ({ api: { updateWorkspace } }));

vi.mock("../../navigation", () => ({
  useNavigation: () => ({ push: navigate }),
}));

vi.mock("./scm-connections-section", () => ({
  ScmConnectionsSection: () => <div data-testid="scm-connections" />,
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { SourceControlTab } from "./source-control-tab";

const TEST_RESOURCES = { en: { common: enCommon, settings: enSettings } };

function I18nWrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      {children}
    </I18nProvider>
  );
}

describe("SourceControlTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    access.role = "owner";
    workspaceRef.current.settings = { retained_setting: "yes" };
    getQueryData.mockReturnValue(undefined);
    setQueryData.mockImplementation((_key, updater) => {
      const updated = updater(getQueryData() ?? [workspaceRef.current]);
      getQueryData.mockReturnValue(updated);
      workspaceRef.current = updated[0];
    });
    updateWorkspace.mockImplementation(async (_id: string, input: { settings: Record<string, unknown> }) => ({
      ...workspaceRef.current,
      settings: Object.fromEntries(Object.entries(input.settings).filter(([, value]) => value !== null)),
    }));
  });

  it("shows provider-independent collaboration settings and commit identity", () => {
    render(<SourceControlTab />, { wrapper: I18nWrapper });

    expect(screen.getByTestId("scm-connections")).toBeInTheDocument();
    expect(screen.getByText("Co-authored-by: Remi <remi@openremi.fun>")).toBeInTheDocument();
    expect(screen.queryByText(/GitHub App/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Enable GitHub features/i)).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Code changes sidebar" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Auto-link issues and code changes" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Record merges on the issue" })).not.toBeChecked();
    // A merge never closes the issue; closing is a status change by a member or the parent owner.
    expect(screen.getByText(/record the merge on the issue\. Its status does not change\./)).toBeInTheDocument();
  });

  it("persists the generic merge behavior without dropping unrelated settings", async () => {
    const user = userEvent.setup();
    render(<SourceControlTab />, { wrapper: I18nWrapper });

    await user.click(screen.getByRole("switch", { name: "Record merges on the issue" }));

    await waitFor(() => expect(updateWorkspace).toHaveBeenCalledWith("workspace-1", {
      settings: {
        retained_setting: "yes",
        scm_complete_issue_on_merge_enabled: true,
      },
    }));
  });

  it("updates preview live, validates drafts, and saves normalized identity with existing settings", async () => {
    const user = userEvent.setup();
    render(<SourceControlTab />, { wrapper: I18nWrapper });
    const save = screen.getByRole("button", { name: enSettings.source_control.co_author_save });
    expect(save).toBeDisabled();
    const name = screen.getByLabelText(enSettings.source_control.co_author_name);
    const email = screen.getByLabelText(enSettings.source_control.co_author_email);
    await user.clear(name);
    await user.type(name, " Custom ");
    await user.clear(email);
    await user.type(email, "invalid");
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(save).toBeDisabled();
    await user.clear(email);
    await user.type(email, " custom@example.test ");
    expect(screen.getByText("Co-authored-by: Custom <custom@example.test>")).toBeInTheDocument();
    await user.click(save);
    await waitFor(() => expect(updateWorkspace).toHaveBeenCalledWith("workspace-1", {
      settings: { retained_setting: "yes", co_authored_by_name: "Custom", co_authored_by_email: "custom@example.test" },
    }));
  });

  it("resets both keys to null and previews defaults", async () => {
    workspaceRef.current.settings = { retained_setting: "yes", co_authored_by_name: "Custom", co_authored_by_email: "custom@example.test" };
    const user = userEvent.setup();
    render(<SourceControlTab />, { wrapper: I18nWrapper });
    await user.click(screen.getByRole("button", { name: enSettings.source_control.co_author_reset }));
    await waitFor(() => expect(updateWorkspace).toHaveBeenCalledWith("workspace-1", {
      settings: { retained_setting: "yes", co_authored_by_name: null, co_authored_by_email: null },
    }));
    expect(screen.getByText("Co-authored-by: Remi <remi@openremi.fun>")).toBeInTheDocument();
  });

  it("serializes identity and switch saves and merges the latest cached settings", async () => {
    const user = userEvent.setup();
    let resolveSave!: (value: unknown) => void;
    updateWorkspace.mockImplementationOnce(() => new Promise((resolve) => { resolveSave = resolve; }));
    // Keep the rendered workspace stale to prove the next save reads the cache.
    setQueryData.mockImplementation((_key, updater) => {
      getQueryData.mockReturnValue(updater(getQueryData() ?? [workspaceRef.current]));
    });
    render(<SourceControlTab />, { wrapper: I18nWrapper });
    const name = screen.getByLabelText(enSettings.source_control.co_author_name);
    await user.clear(name);
    await user.type(name, "New Author");
    await user.click(screen.getByRole("button", { name: enSettings.source_control.co_author_save }));
    for (const toggle of screen.getAllByRole("switch")) expect(toggle).toHaveAttribute("aria-disabled", "true");
    expect(name).toBeDisabled();
    expect(screen.getByRole("button", { name: enSettings.source_control.co_author_reset })).toBeDisabled();
    const toggle = screen.getByRole("switch", { name: enSettings.source_control.feature_co_author_label });
    await user.click(toggle);
    expect(updateWorkspace).toHaveBeenCalledTimes(1);
    await act(async () => resolveSave({ ...workspaceRef.current, settings: {
      retained_setting: "latest", co_authored_by_name: "New Author", co_authored_by_email: "new@example.test",
    } }));
    await waitFor(() => expect(toggle).not.toHaveAttribute("aria-disabled", "true"));
    await user.click(toggle);
    expect(updateWorkspace).toHaveBeenNthCalledWith(2, "workspace-1", { settings: {
      retained_setting: "latest", co_authored_by_name: "New Author", co_authored_by_email: "new@example.test", co_authored_by_enabled: false,
    } });
  });

  it("disables the identity form and other switches while a switch save is pending", async () => {
    const user = userEvent.setup();
    let resolveSave!: (value: unknown) => void;
    updateWorkspace.mockImplementationOnce(() => new Promise((resolve) => { resolveSave = resolve; }));
    render(<SourceControlTab />, { wrapper: I18nWrapper });
    await user.click(screen.getByRole("switch", { name: "Record merges on the issue" }));
    for (const toggle of screen.getAllByRole("switch")) expect(toggle).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: enSettings.source_control.co_author_reset })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: enSettings.source_control.co_author_reset }));
    expect(updateWorkspace).toHaveBeenCalledTimes(1);
    await act(async () => resolveSave(workspaceRef.current));
    await waitFor(() => expect(screen.getByRole("button", { name: enSettings.source_control.co_author_reset })).toBeEnabled());
  });

  it("shows later server identity updates after restoring defaults", async () => {
    workspaceRef.current.settings = { co_authored_by_name: "Custom", co_authored_by_email: "custom@example.test" };
    const user = userEvent.setup();
    const { rerender } = render(<SourceControlTab />, { wrapper: I18nWrapper });
    await user.click(screen.getByRole("button", { name: enSettings.source_control.co_author_reset }));
    await waitFor(() => expect(screen.getByLabelText(enSettings.source_control.co_author_name)).toHaveValue("Remi"));
    workspaceRef.current = { ...workspaceRef.current, settings: {
      co_authored_by_name: "Server Author", co_authored_by_email: "server@example.test",
    } };
    rerender(<SourceControlTab />);
    expect(screen.getByLabelText(enSettings.source_control.co_author_name)).toHaveValue("Server Author");
    expect(screen.getByLabelText(enSettings.source_control.co_author_email)).toHaveValue("server@example.test");
  });

  it("keeps identity editable when attribution is disabled and marks preview inactive", async () => {
    workspaceRef.current.settings.co_authored_by_enabled = false;
    const user = userEvent.setup();
    render(<SourceControlTab />, { wrapper: I18nWrapper });
    expect(screen.getByText(enSettings.source_control.co_author_disabled)).toBeInTheDocument();
    const name = screen.getByLabelText(enSettings.source_control.co_author_name);
    await user.clear(name);
    await user.type(name, "Disabled Author");
    expect(name).toHaveValue("Disabled Author");
  });

  it("makes the identity group read-only without management permission", async () => {
    access.role = "member";
    const user = userEvent.setup();
    render(<SourceControlTab />, { wrapper: I18nWrapper });
    const name = screen.getByLabelText(enSettings.source_control.co_author_name);
    const email = screen.getByLabelText(enSettings.source_control.co_author_email);
    expect(name).toHaveAttribute("readonly");
    expect(email).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: enSettings.source_control.co_author_save })).toBeDisabled();
    const reset = screen.getByRole("button", { name: enSettings.source_control.co_author_reset });
    expect(reset).toBeDisabled();
    await user.click(reset);
    expect(updateWorkspace).not.toHaveBeenCalled();
  });

  it("opens the shared repository management surface", async () => {
    const user = userEvent.setup();
    render(<SourceControlTab />, { wrapper: I18nWrapper });

    await user.click(screen.getByRole("button", { name: /Manage repositories/ }));
    expect(navigate).toHaveBeenCalledWith("/acme/repositories");
  });
});
