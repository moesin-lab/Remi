import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { PlatformOperation, PlatformStatus } from "@multiremi/core/platform-lifecycle";
import enCommon from "../../locales/en/common.json";
import enSettings from "../../locales/en/settings.json";
import zhCommon from "../../locales/zh-Hans/common.json";
import zhSettings from "../../locales/zh-Hans/settings.json";

const statusRef = vi.hoisted(() => ({
  current: null as PlatformStatus | null,
  pending: false,
  refetchError: false,
}));
const createMutationRef = vi.hoisted(() => ({
  isPending: false,
  mutateAsync: vi.fn(),
  mutate: vi.fn(),
}));
const cancelMutationRef = vi.hoisted(() => ({
  isPending: false,
  mutateAsync: vi.fn(),
}));
const settingsMutationRef = vi.hoisted(() => ({
  isPending: false,
  mutate: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: statusRef.current,
    isPending: statusRef.pending,
    isRefetchError: statusRef.refetchError,
  }),
}));
vi.mock("@multiremi/core/platform-lifecycle", () => ({
  platformStatusOptions: () => ({ queryKey: ["platform-lifecycle", "status"] }),
  useCreatePlatformOperation: () => createMutationRef,
  useCancelPlatformOperation: () => cancelMutationRef,
  useUpdatePlatformSettings: () => settingsMutationRef,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../../common/use-viewing-timezone", () => ({ useViewingTimezone: () => "Asia/Shanghai" }));

import { PlatformTab } from "./platform-tab";

const TEST_RESOURCES = { en: { common: enCommon, settings: enSettings } };

function Wrapper({ children }: { children: ReactNode }) {
  return <I18nProvider locale="en" resources={TEST_RESOURCES}>{children}</I18nProvider>;
}

function platformOperation(overrides: Partial<PlatformOperation> = {}): PlatformOperation {
  return {
    id: "pop-1",
    kind: "update",
    status: "queued",
    driver: "docker_compose",
    targetVersion: "v0.2.47",
    targetRef: "v0.2.47",
    targetManifest: {},
    progress: { message: "", drain: null },
    cancelRequested: false,
    requestedBy: "user-1",
    output: null,
    error: null,
    previousRelease: null,
    resultRelease: null,
    createdAt: "2026-08-23T01:00:00.000Z",
    updatedAt: "2026-08-23T01:00:00.000Z",
    startedAt: "2026-08-23T01:00:00.000Z",
    finishedAt: null,
    ...overrides,
  };
}

function platformStatus(overrides: Partial<PlatformStatus> = {}): PlatformStatus {
  return {
    canManage: true,
    driver: "docker_compose",
    currentRelease: {
      version: "v0.2.46",
      ref: "v0.2.46",
      publishedAt: null,
      releaseUrl: null,
      manifestUrl: null,
      apiImage: null,
      webImage: null,
    },
    latestRelease: null,
    updateAvailable: false,
    autoUpdateStable: false,
    autoUpdateSchedule: {
      enabled: false,
      time: "05:00",
      timezone: "Asia/Shanghai",
      nextCheckAt: null,
      lastCheckedAt: null,
      lastResult: null,
    },
    updaterStatus: "ready",
    updaterHeartbeatAt: null,
    services: [],
    activeOperation: null,
    lastOperation: null,
    maintenance: {
      mode: "normal",
      generation: 0,
      operationId: null,
      startedAt: null,
      expiresAt: null,
      reason: null,
    },
    recentReleases: [],
    ...overrides,
  };
}

describe("PlatformTab upgrade lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    statusRef.pending = false;
    statusRef.refetchError = false;
    createMutationRef.isPending = false;
    cancelMutationRef.isPending = false;
    settingsMutationRef.isPending = false;
    cancelMutationRef.mutateAsync.mockResolvedValue(platformOperation({ status: "cancelled" }));
    statusRef.current = platformStatus();
  });

  it("saves a custom update URL and resets to the host default", async () => {
    const user = userEvent.setup();
    statusRef.current = platformStatus({ releaseFeedUrl: "https://old.example/feed", defaultReleaseFeedUrl: "https://default.example/feed" });
    render(<PlatformTab />, { wrapper: Wrapper });
    const input = screen.getByLabelText("Release feed URL");
    await user.clear(input);
    await user.type(input, "https://mirror.example/releases.json");
    await user.click(screen.getByRole("button", { name: "Save update source" }));
    expect(settingsMutationRef.mutate).toHaveBeenCalledWith({ releaseFeedUrl: "https://mirror.example/releases.json" }, expect.any(Object));
    await user.click(screen.getByRole("button", { name: "Restore default source" }));
    expect(settingsMutationRef.mutate).toHaveBeenCalledWith({ releaseFeedUrl: null }, expect.any(Object));
  });

  it('shows the reported execution mode and previews migration without changing it or the source', async () => {
    const user = userEvent.setup();
    statusRef.current = platformStatus({ updateMode: 'images' });
    render(<PlatformTab />, { wrapper: Wrapper });
    expect(screen.getByTestId('platform-current-mode')).toHaveTextContent(enSettings.platform.update_modes.images.label);
    await user.click(screen.getByRole('button', { name: enSettings.platform.mode_guide }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(enSettings.platform.update_modes.internal_application.migration)).toBeInTheDocument();
    expect(within(dialog).getByText(enSettings.platform.mode_source_shared)).toBeInTheDocument();
    within(dialog).getByRole('combobox').focus();
    await user.keyboard('[ArrowDown]');
    await user.click(await screen.findByRole('option', { name: enSettings.platform.update_modes.host_application.label }));
    expect(within(dialog).getByText(enSettings.platform.update_modes.host_application.migration)).toBeInTheDocument();
    expect(createMutationRef.mutateAsync).not.toHaveBeenCalled();
    expect(settingsMutationRef.mutate).not.toHaveBeenCalled();
    expect(screen.getByTestId('platform-current-mode')).toHaveTextContent(enSettings.platform.update_modes.images.label);
  });

  it('does not infer a mode from docker_compose, including offline or future updater reports', () => {
    statusRef.current = platformStatus({ updateMode: 'future_mode', updaterStatus: 'offline' });
    render(<PlatformTab />, { wrapper: Wrapper });
    expect(screen.getByTestId('platform-current-mode')).toHaveTextContent(enSettings.platform.mode_unknown);
    expect(screen.getByText(enSettings.platform.mode_offline)).toBeInTheDocument();
  });

  it('shows migration blockers without offering an unsafe switch action', async () => {
    const user = userEvent.setup();
    statusRef.current = platformStatus({ updateMode: 'images', activeOperation: platformOperation({ status: 'switching' }) });
    render(<PlatformTab />, { wrapper: Wrapper });
    await user.click(screen.getByRole('button', { name: enSettings.platform.mode_guide }));
    expect(within(screen.getByRole('dialog')).getByRole('alert')).toHaveTextContent(enSettings.platform.mode_busy);
    expect(settingsMutationRef.mutate).not.toHaveBeenCalled();
  });

  it('distinguishes available images from missing application bundles and checks the saved source', async () => {
    const user = userEvent.setup();
    statusRef.current = platformStatus({ updateMode: 'internal_application', releaseFeedUrl: 'https://images.example/feed', preflight: {
      ready: false, checkedAt: new Date().toISOString(), platform: 'linux', arch: 'x64', checks: [],
      source: { url: 'https://images.example/feed', manifestUrl: null, error: null, modes: [
        { mode: 'images', available: true, missing: [] }, { mode: 'internal_application', available: false, missing: ['application_bundle'] },
      ] },
    } });
    createMutationRef.mutateAsync.mockResolvedValue(platformOperation({ kind: 'check_updates' }));
    render(<PlatformTab />, { wrapper: Wrapper });
    const source = screen.getByTestId('platform-source-capabilities');
    expect(within(source).getByText(enSettings.platform.source_available)).toBeInTheDocument();
    expect(within(source).getByText(enSettings.platform.missing_artifacts.application_bundle)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: enSettings.platform.source_check }));
    expect(createMutationRef.mutateAsync).toHaveBeenCalledWith({ kind: 'check_updates', targetVersion: null, targetRef: null });
    await user.type(screen.getByLabelText('Release feed URL'), '/edited');
    expect(screen.getByText(enSettings.platform.source_unsaved)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: enSettings.platform.source_check })).toBeDisabled();
  });

  it.each(['expired', 'different_source', 'offline'])('does not show stale capabilities as current when %s', reason => {
    statusRef.current = platformStatus({ releaseFeedUrl: 'https://new.example/feed', updaterStatus: reason === 'offline' ? 'offline' : 'ready', preflight: {
      ready: true, checkedAt: new Date(Date.now() - (reason === 'expired' ? 361_000 : 0)).toISOString(), platform: 'linux', arch: 'x64', checks: [],
      source: { url: reason === 'different_source' ? 'https://old.example/feed' : 'https://new.example/feed', manifestUrl: null, error: null, modes: [{ mode: 'images', available: true, missing: [] }] },
    } });
    render(<PlatformTab />, { wrapper: Wrapper });
    expect(screen.getByText(enSettings.platform.source_unchecked)).toBeInTheDocument();
    expect(screen.queryByText(enSettings.platform.source_available)).not.toBeInTheDocument();
  });

  it("queues the advertised update from the settings confirmation without host commands", async () => {
    const user = userEvent.setup();
    statusRef.current = platformStatus({
      updateAvailable: true,
      latestRelease: { version: "1.2.3", ref: "release-commit", publishedAt: null, releaseUrl: null, manifestUrl: "https://mirror.example/releases.json", apiImage: null, webImage: null },
      preflight: { ready: true, checkedAt: new Date().toISOString(), platform: "win32", arch: "x64", checks: [{ code: "host", ok: true, message: "ready" }] },
    });
    createMutationRef.mutateAsync.mockResolvedValue(platformOperation());
    render(<PlatformTab />, { wrapper: Wrapper });
    await user.click(screen.getByRole("button", { name: enSettings.platform.check_updates }));
    expect(createMutationRef.mutateAsync).toHaveBeenCalledWith({ kind: "check_updates", targetVersion: null, targetRef: null });
    createMutationRef.mutateAsync.mockClear();
    await user.click(screen.getByRole("button", { name: enSettings.platform.update_now }));
    expect(createMutationRef.mutateAsync).not.toHaveBeenCalled();
    const dialog = within(screen.getByRole("alertdialog"));
    expect(dialog.getByRole("heading")).toHaveTextContent(enSettings.platform.confirm_update_title.replace("{{version}}", "1.2.3"));
    expect(dialog.getByText(enSettings.platform.confirm_update_desc)).toBeVisible();
    expect(dialog.getByText(enSettings.platform.update_target_ref.replace("{{ref}}", "release-commit"))).toBeVisible();
    await user.click(screen.getByRole("button", { name: enSettings.platform.confirm }));
    await waitFor(() => expect(createMutationRef.mutateAsync).toHaveBeenCalledWith({
      kind: "update", targetVersion: "1.2.3", targetRef: "https://mirror.example/releases.json",
    }));
  });

  it("keeps the Web and API update entry visible before any release is discovered", () => {
    render(<PlatformTab />, { wrapper: Wrapper });
    expect(screen.getByRole("button", { name: enSettings.platform.update_now })).toBeVisible();
    expect(screen.getByRole("button", { name: enSettings.platform.update_now })).toBeDisabled();
    expect(screen.getByText(enSettings.platform.update_scope)).toBeVisible();
    expect(screen.getByText(enSettings.platform.update_check_required)).toBeVisible();
    expect(screen.getByRole("button", { name: enSettings.platform.check_updates })).toBeEnabled();
  });

  it("keeps the update button visible and explains when this source is already installed", async () => {
    const user = userEvent.setup();
    statusRef.current = platformStatus({
      latestRelease: platformStatus().currentRelease,
      preflight: { ready: true, checkedAt: new Date().toISOString(), platform: "linux", arch: "x64", checks: [{ code: "backup", ok: true, message: "ready" }] },
    });
    render(<PlatformTab />, { wrapper: Wrapper });
    const button = screen.getByRole("button", { name: enSettings.platform.update_now });
    expect(button).toBeVisible(); expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(enSettings.platform.update_no_new_release);
    await user.click(button);
    expect(createMutationRef.mutateAsync).not.toHaveBeenCalled();
  });

  it.each(["offline", "expired", "permission", "maintenance"])("explains a blocked update for %s without hiding the entry", reason => {
    statusRef.current = platformStatus({
      updateAvailable: true,
      latestRelease: { ...platformStatus().currentRelease!, ref: "new" },
      updaterStatus: reason === "offline" ? "offline" : "ready",
      canManage: reason !== "permission",
      maintenance: { ...platformStatus().maintenance, mode: reason === "maintenance" ? "draining" : "normal" },
      preflight: { ready: true, checkedAt: new Date(Date.now() - (reason === "expired" ? 7 * 60_000 : 0)).toISOString(), platform: "linux", arch: "x64", checks: [{ code: "backup", ok: true, message: "ready" }] },
    });
    render(<PlatformTab />, { wrapper: Wrapper });
    const button = screen.getByRole("button", { name: enSettings.platform.update_now });
    expect(button).toBeVisible(); expect(button).toBeDisabled();
    const hint = reason === "offline" ? enSettings.platform.update_updater_unavailable
      : reason === "permission" ? enSettings.platform.update_permission_required
      : reason === "maintenance" ? enSettings.platform.mode_busy : enSettings.platform.update_check_required;
    expect(button).toHaveAccessibleDescription(hint);
  });

  it("does not claim an older advertised target is installed", () => {
    statusRef.current = platformStatus({
      latestRelease: { ...platformStatus().currentRelease!, version: "v0.2.45", ref: "older" },
      preflight: { ready: true, checkedAt: new Date().toISOString(), platform: "linux", arch: "x64", checks: [{ code: "backup", ok: true, message: "ready" }] },
    });
    render(<PlatformTab />, { wrapper: Wrapper });
    expect(screen.getByRole("button", { name: enSettings.platform.update_now })).toHaveAccessibleDescription(enSettings.platform.update_no_newer_release);
    expect(screen.queryByText(enSettings.platform.update_no_new_release)).not.toBeInTheDocument();
  });

  it("blocks an open confirmation if the advertised target changes", async () => {
    const user = userEvent.setup();
    statusRef.current = platformStatus({
      updateAvailable: true,
      latestRelease: { ...platformStatus().currentRelease!, ref: "first-target" },
      preflight: { ready: true, checkedAt: new Date().toISOString(), platform: "linux", arch: "x64", checks: [{ code: "backup", ok: true, message: "ready" }] },
    });
    const view = render(<PlatformTab />, { wrapper: Wrapper });
    await user.click(screen.getByRole("button", { name: enSettings.platform.update_now }));
    statusRef.current = { ...statusRef.current, latestRelease: { ...statusRef.current.latestRelease!, ref: "new-target" } };
    view.rerender(<PlatformTab />);
    const confirm = within(screen.getByRole("alertdialog")).getByRole("button", { name: enSettings.platform.confirm });
    expect(confirm).toBeDisabled(); await user.click(confirm);
    expect(createMutationRef.mutateAsync).not.toHaveBeenCalled();
  });

  it("blocks update and restart when preflight fails and retains the original reason in diagnostics", async () => {
    const user = userEvent.setup();
    statusRef.current = platformStatus({
      updateAvailable: true,
      latestRelease: { version: "1.2.3", ref: "new", publishedAt: null, releaseUrl: null, manifestUrl: "https://example.com/manifest", apiImage: null, webImage: null },
      preflight: { ready: false, checkedAt: new Date().toISOString(), platform: "win32", arch: "x64", checks: [{ code: "backup", ok: false, message: "Database backup is not configured" }] },
    });
    render(<PlatformTab />, { wrapper: Wrapper });
    expect(screen.getByText(enSettings.platform.preflight_checks.backup.failure)).toBeVisible();
    expect(screen.queryByText("Database backup is not configured")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: enSettings.platform.update_now })).toBeDisabled();
    expect(screen.getByRole("button", { name: enSettings.platform.restart })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: enSettings.platform.preflight_diagnostics }));
    expect(screen.getByText("Database backup is not configured")).toBeVisible();
  });

  it("renders the internal updater checks and missing application bundle in Chinese without weakening the update gate", async () => {
    const user = userEvent.setup();
    const sourceUrl = "https://example.test/releases.json";
    const readyCodes = ["container_supervisors", "isolated_rehearsal", "backup", "postgresql", "program_storage", "release_feed"] as const;
    const bundleError = "This release has no supported application bundle; image-only releases cannot be applied in application mode";
    statusRef.current = platformStatus({
      updateMode: "internal_application", releaseFeedUrl: sourceUrl, updateAvailable: true,
      latestRelease: { version: "1.2.3", ref: "new", publishedAt: null, releaseUrl: null, manifestUrl: sourceUrl, apiImage: null, webImage: null },
      preflight: { ready: false, checkedAt: new Date().toISOString(), platform: "linux", arch: "x64",
        checks: [
          ...readyCodes.map(code => ({ code, ok: true, message: code === "release_feed" ? "Release feed is reachable" : `${code} ready` })),
          { code: "release_artifacts", ok: false, message: "Release is missing or has invalid artifacts for internal_application: application_bundle" },
          { code: "release_feed_or_schema", ok: false, message: bundleError },
        ],
        source: { url: sourceUrl, manifestUrl: null, error: null, modes: [{ mode: "internal_application", available: false, missing: ["application_bundle"] }] },
      },
    });
    render(<I18nProvider locale="zh-Hans" resources={{ "zh-Hans": { common: zhCommon, settings: zhSettings } }}><PlatformTab /></I18nProvider>);
    const preflight = within(screen.getByTestId("platform-preflight"));
    expect(preflight.getByText(/Linux \/ x64/).textContent).not.toMatch(/\b(?:AM|PM)\b/);
    for (const code of readyCodes) expect(preflight.getByText(zhSettings.platform.preflight_checks[code].label)).toBeVisible();
    expect(preflight.getAllByText("通过", { exact: true })).toHaveLength(6);
    expect(preflight.getAllByText("未通过", { exact: true })).toHaveLength(2);
    expect(preflight.getByText(zhSettings.platform.preflight_bundle_unsupported)).toBeVisible();
    expect(preflight.getByText(zhSettings.platform.missing_artifacts.application_bundle)).toBeVisible();
    expect(preflight.queryByText(bundleError)).not.toBeInTheDocument();
    expect(preflight.queryByText("Release feed is reachable")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: zhSettings.platform.update_now })).toBeDisabled();
    expect(screen.getByRole("button", { name: zhSettings.platform.restart })).toBeDisabled();
    await user.click(preflight.getByRole("button", { name: zhSettings.platform.preflight_diagnostics }));
    expect(preflight.getByText(bundleError)).toBeVisible();
    expect(preflight.getByText("container_supervisors")).toBeVisible();
  });

  it("shows a translated fallback for a future check and preserves its code and error", async () => {
    const user = userEvent.setup();
    statusRef.current = platformStatus({ preflight: {
      ready: false, checkedAt: new Date().toISOString(), platform: "linux", arch: "x64",
      checks: [{ code: "future_driver_check", ok: false, message: "Unexpected mount layout: /very/long/path" }],
    } });
    render(<PlatformTab />, { wrapper: Wrapper });
    expect(screen.getByText(enSettings.platform.preflight_unknown_check)).toBeVisible();
    expect(screen.getByText(enSettings.platform.preflight_unknown_failure)).toBeVisible();
    expect(screen.queryByText("Unexpected mount layout: /very/long/path")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: enSettings.platform.preflight_diagnostics }));
    expect(screen.getByText("future_driver_check")).toBeVisible();
    expect(screen.getByText("Unexpected mount layout: /very/long/path")).toBeVisible();
  });

  it("does not claim up-to-date status before a successful check and disables source changes while busy", () => {
    statusRef.current = platformStatus({ activeOperation: platformOperation({ status: "backing_up" }) });
    render(<PlatformTab />, { wrapper: Wrapper });
    expect(screen.queryByText(enSettings.platform.up_to_date)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Release feed URL")).toBeDisabled();
    expect(screen.getByText(enSettings.platform.status_backing_up)).toBeInTheDocument();
  });

  it("renders daemon acknowledgements and active task drain progress", () => {
    statusRef.current = platformStatus({
      activeOperation: platformOperation({
        status: "draining",
        progress: {
          message: "Waiting for 2 running tasks",
          drain: {
            generation: 3,
            online_daemons: 5,
            acked_daemons: 3,
            active_tasks: 2,
            waited_ms: 120_000,
            timeout_ms: 900_000,
            state: "waiting",
          },
        },
      }),
    });

    render(<PlatformTab />, { wrapper: Wrapper });

    expect(screen.getByText("Pausing new tasks (3/5 daemons acknowledged)")).toBeInTheDocument();
    expect(screen.getByText("Waiting for 2 running tasks to finish (2 min elapsed)")).toBeInTheDocument();
  });

  it.each([
    ["queued", "Preparing update"],
    ["preparing", "Preparing update"],
    ["pulling", "Downloading update"],
    ["switching", "Switching services"],
    ["verifying", "Verifying"],
  ])("renders the %s upgrade stage", (operationStatus, expectedLabel) => {
    statusRef.current = platformStatus({
      activeOperation: platformOperation({ status: operationStatus }),
    });

    render(<PlatformTab />, { wrapper: Wrapper });

    expect(screen.getByText(expectedLabel)).toBeInTheDocument();
  });

  it("requests cancellation from a cancellable stage", async () => {
    const user = userEvent.setup();
    statusRef.current = platformStatus({
      activeOperation: platformOperation({ status: "draining" }),
    });
    render(<PlatformTab />, { wrapper: Wrapper });

    await user.click(screen.getByRole("button", { name: "Cancel upgrade" }));

    await waitFor(() => expect(cancelMutationRef.mutateAsync).toHaveBeenCalledWith("pop-1"));
  });

  it("hides cancellation once service switching begins", () => {
    statusRef.current = platformStatus({
      activeOperation: platformOperation({ status: "switching" }),
    });

    render(<PlatformTab />, { wrapper: Wrapper });

    expect(screen.getByText("Switching services")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel upgrade" })).not.toBeInTheDocument();
  });

  it("shows the recent drain timeout result after scheduling is restored", () => {
    statusRef.current = platformStatus({
      lastOperation: platformOperation({
        status: "failed",
        error: null,
        finishedAt: new Date().toISOString(),
        progress: {
          message: "Drain timeout",
          drain: {
            generation: 3,
            online_daemons: 5,
            acked_daemons: 5,
            active_tasks: 1,
            waited_ms: 900_000,
            timeout_ms: 900_000,
            state: "timeout",
          },
        },
      }),
    });

    render(<PlatformTab />, { wrapper: Wrapper });

    expect(screen.getByText(
      "Drain timed out. Upgrade not performed; tasks kept running and scheduling resumed.",
    )).toBeInTheDocument();
    expect(screen.getByTestId("platform-operation-status")).toHaveAttribute("data-state", "timeout");
  });

  it("recognizes a drain timeout reported in the operation error", () => {
    statusRef.current = platformStatus({
      lastOperation: platformOperation({
        status: "failed",
        error: "platform drain timed out after 900000ms",
        finishedAt: new Date().toISOString(),
      }),
    });

    render(<PlatformTab />, { wrapper: Wrapper });

    expect(screen.getByText(
      "Drain timed out. Upgrade not performed; tasks kept running and scheduling resumed.",
    )).toBeInTheDocument();
  });

  it.each([
    ["succeeded", "Task scheduling restored"],
    ["cancelled", "Upgrade cancelled. Task scheduling resumed."],
  ])("renders the recent %s operation result", (operationStatus, expectedLabel) => {
    statusRef.current = platformStatus({
      lastOperation: platformOperation({
        status: operationStatus,
        finishedAt: new Date().toISOString(),
      }),
    });

    render(<PlatformTab />, { wrapper: Wrapper });

    expect(screen.getByText(expectedLabel)).toBeInTheDocument();
  });

  it("does not render a terminal operation result after 30 minutes", () => {
    statusRef.current = platformStatus({
      lastOperation: platformOperation({
        status: "succeeded",
        finishedAt: new Date(Date.now() - 31 * 60_000).toISOString(),
      }),
    });

    render(<PlatformTab />, { wrapper: Wrapper });

    expect(screen.queryByText("Task scheduling restored")).not.toBeInTheDocument();
  });

  it("keeps a long drain wait active instead of rendering it as a failure", () => {
    statusRef.current = platformStatus({
      activeOperation: platformOperation({
        status: "draining",
        progress: {
          message: "Waiting for 1 running task",
          drain: {
            generation: 3,
            online_daemons: 5,
            acked_daemons: 5,
            active_tasks: 1,
            waited_ms: 840_000,
            timeout_ms: 900_000,
            state: "waiting",
          },
        },
      }),
      lastOperation: platformOperation({
        status: "failed",
        error: "drain timeout",
        finishedAt: new Date().toISOString(),
      }),
    });

    render(<PlatformTab />, { wrapper: Wrapper });

    expect(screen.getByText("Waiting for 1 running task to finish (14 min elapsed)")).toBeInTheDocument();
    expect(screen.queryByText(/Drain timed out/)).not.toBeInTheDocument();
    expect(screen.getByTestId("platform-operation-status")).toHaveAttribute("data-state", "active");
    expect(screen.getByTestId("platform-operation-status")).not.toHaveClass("text-destructive");
  });

  it("omits the active task line once draining reaches zero tasks", () => {
    statusRef.current = platformStatus({
      activeOperation: platformOperation({
        status: "draining",
        progress: {
          message: "Ready to switch",
          drain: {
            generation: 3,
            online_daemons: 5,
            acked_daemons: 5,
            active_tasks: 0,
            waited_ms: 180_000,
            timeout_ms: 900_000,
            state: "ready",
          },
        },
      }),
    });

    render(<PlatformTab />, { wrapper: Wrapper });

    expect(screen.getByText("Pausing new tasks (5/5 daemons acknowledged)")).toBeInTheDocument();
    expect(screen.queryByText(/running task/)).not.toBeInTheDocument();
  });

  it("saves the platform-owned daily update schedule", async () => {
    const user = userEvent.setup();
    render(<PlatformTab />, { wrapper: Wrapper });

    await user.click(screen.getByRole("switch", { name: "Automatically install stable releases" }));
    await user.click(screen.getByRole("button", { name: "Save schedule" }));

    expect(settingsMutationRef.mutate).toHaveBeenCalledWith({
      enabled: true,
      time: "05:00",
      timezone: "Asia/Shanghai",
    }, expect.objectContaining({
      onSuccess: expect.any(Function),
      onError: expect.any(Function),
    }));
  });
});
