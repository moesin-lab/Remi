import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "@multiremi/core/api";
import { projectActivitySchema } from "@multiremi/core/api/schemas";
import type { ActivityPage } from "@multiremi/core/projects";
import { NavigationProvider } from "../../navigation";
import { renderWithI18n } from "../../test/i18n";
import english from "../../locales/en/projects.json";
import chinese from "../../locales/zh-Hans/projects.json";
import japanese from "../../locales/ja/projects.json";
import korean from "../../locales/ko/projects.json";
import { traceTurn, turnPage } from "../../test/trace-fixtures";
import { ProjectActivityPage } from "./project-activity-page";

vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws" }));
vi.mock("@multiremi/core/paths", async (load) => {
  const actual = await load<typeof import("@multiremi/core/paths")>();
  return { ...actual, useWorkspacePaths: () => actual.paths.workspace("acme") };
});
vi.mock("@multiremi/core/api", () => ({ api: {
  listProjectActivity: vi.fn(), getProject: vi.fn(), listAgents: vi.fn(), listProjects: vi.fn(),
  listIssueChangeRequests: vi.fn(), getIssueWorkspace: vi.fn(), getTaskTrace: vi.fn(),
} }));
vi.mock("@multiremi/core/realtime", () => ({ useTraceStreamSubscription: vi.fn() }));
vi.mock("../../common/task-transcript/agent-transcript-dialog", () => ({ AgentTranscriptDialog: ({ task, onOpenChange }: { task: { id: string }; onOpenChange: (open: boolean) => void }) =>
  <div role="dialog">{task.id}<button onClick={() => onOpenChange(false)}>Close</button></div> }));

const row: ActivityPage["items"][number] = { attempt_id: "first", attempt_no: 1, turn_id: "turn-1", status: "failed",
  issue: { id: "i1", key: "QA-1", title: "Build" }, agent: { id: "a1", name: "Actual executor" }, issue_session: { id: "s1", title: "Alpha" },
  created_at: "2026-11-25T00:00:00Z", started_at: "2026-11-25T00:01:00Z", ended_at: "2026-11-25T00:03:00Z", updated_at: null,
  public_summary: { code: "context_overflow" } };
const page: ActivityPage = { items: [row], has_more: true, next_cursor: "next", as_of: "2026-11-25T00:04:00Z" };
const messages = { en: english, "zh-Hans": chinese, ja: japanese, ko: korean };
function mount(search = "view=history", locale: keyof typeof messages = "en") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const push = vi.fn();
  function App({ projectId }: { projectId: string }) {
    const [url, setUrl] = useState(`/acme/projects/${projectId}/activity?${search}`);
    const current = new URL(url, "https://example.invalid");
    return <QueryClientProvider client={client}><NavigationProvider value={{ push: (path) => { push(path); setUrl(path); }, replace: setUrl,
      back: vi.fn(), pathname: current.pathname, searchParams: current.searchParams, getShareableUrl: () => url }}>
      <ProjectActivityPage key={projectId} projectId={projectId} />
    </NavigationProvider></QueryClientProvider>;
  }
  const { rerender } = renderWithI18n(<App projectId="p" />, { locale });
  return { push, client, user: userEvent.setup(), switchProject: () => rerender(<App projectId="other" />) };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.getProject).mockResolvedValue({ id: "p", title: "Archived project", archived_at: row.created_at } as Awaited<ReturnType<typeof api.getProject>>);
  vi.mocked(api.listProjectActivity).mockResolvedValue(page);
  vi.mocked(api.listAgents).mockResolvedValue([]);
  vi.mocked(api.listIssueChangeRequests).mockResolvedValue({ changeRequests: [], total: 0 });
  vi.mocked(api.getIssueWorkspace).mockResolvedValue({ workspace: null });
  vi.mocked(api.getTaskTrace).mockResolvedValue(turnPage(traceTurn({ id: row.turn_id }), []));
});

it("opens active on a project with no repositories and loads only the active surface", async () => {
  mount("");
  expect(await screen.findByText("Archived project")).toBeVisible();
  expect(screen.getByRole("tab", { name: "Executions" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("button", { name: "In progress" })).toHaveAttribute("aria-pressed", "true");
  expect(api.listProjectActivity).toHaveBeenCalledWith("p", expect.objectContaining({ view: "active" }), expect.any(AbortSignal));
  for (const read of [api.listProjects, api.getTaskTrace, api.listIssueChangeRequests, api.getIssueWorkspace]) expect(read).not.toHaveBeenCalled();
});

it("restores a shared URL, combines filters in UTC and clears the cursor when the selection changes", async () => {
  const { user, push } = mount("view=history&agent_id=a1&cursor=shared");
  await screen.findByText("Context limit reached");
  expect(screen.getByText("First page")).toBeVisible();
  await user.selectOptions(screen.getByLabelText("Status"), "failed");
  await user.type(screen.getByLabelText("Issue key or title"), " QA-1 ");
  fireEvent.change(screen.getByLabelText(/Created from/), { target: { value: "2026-11-25T13:00" } });
  fireEvent.change(screen.getByLabelText(/Created before/), { target: { value: "2026-11-26T13:00" } });
  await user.click(screen.getByText("Apply filters"));
  const current = () => new URL(String(push.mock.lastCall?.[0]), "https://example.invalid").searchParams;
  expect(Object.fromEntries(current())).toEqual({ view: "history", status: "failed", agent_id: "a1", q: "QA-1", from: "2026-11-25T13:00:00.000Z", to: "2026-11-26T13:00:00.000Z" });
  await user.click(await screen.findByText("Next page"));
  expect(current().get("cursor")).toBe("next");
  await user.click(screen.getByText("Previous page"));
  expect(current().has("cursor")).toBe(false);
  await user.click(screen.getByRole("button", { name: "In progress" }));
  expect(current().has("status")).toBe(false);
  await user.click(screen.getByRole("button", { name: "Failed" }));
  expect([current().get("view"), current().get("status")]).toEqual(["history", "failed"]);
});

it("distinguishes retries, reads the selected turn/attempt and shares current Issue relations only when expanded", async () => {
  vi.mocked(api.listProjectActivity).mockResolvedValue({ ...page, items: [row, { ...row, attempt_id: "retry", attempt_no: 2, status: "completed", issue_session: { id: "s2", title: "Beta" }, public_summary: null }] });
  vi.mocked(api.listIssueChangeRequests).mockResolvedValue({ changeRequests: [
    { id: "pr1", workspaceId: "ws", repositoryName: "api", number: 1, state: "merged", url: "https://example.invalid/pr/1" },
    { id: "pr2", workspaceId: "ws", repositoryName: "web", number: 2, state: "open", url: "javascript:alert(1)" },
  ], total: 2 } as Awaited<ReturnType<typeof api.listIssueChangeRequests>>);
  vi.mocked(api.getIssueWorkspace).mockResolvedValue({ workspace: { issue_id: "i1", workspace_id: "ws", status: "ready", cleaned_at: null,
    repos: [{ repo_name: "api", repo_url: "api", branch_name: "main-fix", status: "ready" }, { repo_name: "web", repo_url: "web", branch_name: "style", status: "dirty" }] } } as Awaited<ReturnType<typeof api.getIssueWorkspace>>);
  const { client, user } = mount();
  const [first, retry] = await screen.findAllByRole("listitem");
  expect(within(first!).getByText("QA-1 · Build")).toHaveAttribute("href", "/acme/issues/i1");
  expect(within(retry!).getByText("Session · Beta")).toHaveAttribute("href", "/acme/issues/i1?session=s2");
  expect(within(retry!).getByText("Attempt 2 · retry")).toBeVisible();
  expect(within(first!).getByText("Actual executor")).toBeVisible();
  for (const section of [first!, retry!]) await user.click(within(section).getByRole("button", { name: /Current PRs/ }));
  expect(api.listIssueChangeRequests).toHaveBeenCalledTimes(1);
  expect(api.getIssueWorkspace).toHaveBeenCalledTimes(1);
  expect(within(first!).getByText("api · PR #1 · Merged")).toHaveAttribute("href", "https://example.invalid/pr/1");
  expect(within(retry!).getByText("web · PR #2 · Open").closest("a")).toBeNull();
  expect(within(retry!).getByText("web · style · Uncommitted or unpushed work")).toBeVisible();
  for (const [index, section] of [first!, retry!].entries()) {
    const attempt = index ? "retry" : "first";
    await user.click(within(section).getByRole("button", { name: "Open attempt log" }));
    await waitFor(() => expect(api.getTaskTrace).toHaveBeenCalledWith(attempt, { turnId: "turn-1", itemCursor: 0 }));
    const observers = () => client.getQueryCache().find({ queryKey: ["task-trace", attempt] })?.getObserversCount();
    expect(observers()).toBe(1);
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(observers()).toBe(0);
  }
});

it("keeps row, expansion, scroll and focus during a background read", async () => {
  const { client, user } = mount();
  const rowElement = await screen.findByRole("listitem");
  await user.click(screen.getByText("Current PRs and branches for this Issue"));
  expect(await screen.findByText("No current worktree branches.")).toBeVisible();
  const input = screen.getByLabelText("Issue key or title");
  await user.click(input);
  const scroller = rowElement.closest(".overflow-y-auto")!;
  scroller.scrollTop = 120;
  let finish!: (data: ActivityPage) => void;
  vi.mocked(api.listProjectActivity).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  act(() => { void client.invalidateQueries({ queryKey: ["project-activity"] }); });
  expect(screen.queryByText("Loading…")).toBeNull();
  await act(async () => finish({ ...page, as_of: "2026-11-26T04:00:00Z" }));
  expect(screen.getByRole("listitem")).toBe(rowElement);
  expect(scroller.scrollTop).toBe(120);
  expect(input).toHaveFocus();
  expect(screen.getByText("Current PRs and branches for this Issue")).toHaveAttribute("aria-expanded", "true");
});

it("separates read errors, no matches, unknown durations and collected worktrees", async () => {
  vi.mocked(api.listProjectActivity).mockRejectedValueOnce(Error("bad cursor")).mockResolvedValueOnce({ ...page, items: [] });
  const { client, user } = mount();
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not load these records");
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("No attempts match these filters.")).toBeVisible();
  vi.mocked(api.listProjectActivity).mockResolvedValue({ ...page, items: [{ ...row, started_at: null, ended_at: null, issue_session: null, status: "future", public_summary: null }] });
  await act(async () => { await client.invalidateQueries({ queryKey: ["project-activity"] }); });
  expect(await screen.findByText("Unknown")).toBeVisible();
  for (const label of ["Record updated", "Run time", "Queue time"]) expect(screen.getByText(`${label} · —`)).toBeVisible();
  expect(screen.queryByText(/Session ·/)).toBeNull();
  await user.click(screen.getByText("Current PRs and branches for this Issue"));
  expect(await screen.findByText("No linked PRs.")).toBeVisible();
});

it.each([
  ["queued", "Queue time", null, "2026-11-25T00:00:08Z", "2 sec"],
  ["running", "Run time", "2026-11-25T00:00:08Z", "2026-11-25T00:00:00Z", "2 sec"],
  ["queued", "Queue time", null, "2026-11-25T00:00:12Z", "—"],
  ["failed", "Run time", "2026-11-25T00:00:08Z", null, "—"],
] as const)("shows %s %s on first appearance between ticks (%s, %s)", async (status, label, started_at, created_at, elapsed) => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-25T00:00:00Z"));
  try {
    vi.mocked(api.listProjectActivity).mockResolvedValueOnce({ ...page, items: [] });
    const { client } = mount(status === "failed" ? "view=history" : "");
    await screen.findByText("No attempts match these filters.");
    clock.mockReturnValue(Date.parse("2026-11-25T00:00:10Z"));
    vi.mocked(api.listProjectActivity).mockResolvedValueOnce({ ...page, items: [{ ...row, status, started_at, created_at,
      ended_at: status === "failed" ? "2026-11-25T00:00:07Z" : null }] });
    await act(async () => { await client.invalidateQueries({ queryKey: ["project-activity"] }); });
    expect(await screen.findByRole("listitem")).toHaveTextContent(`${label} · ${elapsed}`);
  } finally {
    clock.mockRestore();
  }
});

it("skips duration rendering for all 30 unchanged active rows on a silent refresh", async () => {
  const items = Array.from({ length: 30 }, (_, index) => ({ ...row, attempt_id: `running-${index}`, status: "running", ended_at: null }));
  vi.mocked(api.listProjectActivity).mockResolvedValue({ ...page, items });
  const { client } = mount("");
  expect(await screen.findAllByRole("listitem")).toHaveLength(30);
  const format = vi.spyOn(Intl, "NumberFormat");
  try {
    vi.mocked(api.listProjectActivity).mockResolvedValue({ ...page, items: structuredClone(items), as_of: "2026-11-25T00:04:01Z" });
    await act(async () => { await client.invalidateQueries({ queryKey: ["project-activity"] }); });
    expect(format).not.toHaveBeenCalled();
  } finally {
    format.mockRestore();
  }
});

it("ignores a late read after switching projects", async () => {
  let finish!: (data: ActivityPage) => void;
  vi.mocked(api.listProjectActivity).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValueOnce({ ...page, items: [] });
  const { switchProject } = mount();
  switchProject();
  expect(await screen.findByText("No attempts match these filters.")).toBeVisible();
  await act(async () => finish(page));
  expect(screen.queryByText("QA-1 · Build")).toBeNull();
});

it.each(["en", "zh-Hans", "ja", "ko"] as const)("renders only localized public classifications in %s", async (locale) => {
  const summary = messages[locale].activity.summary;
  const codes = Object.keys(summary) as Array<keyof typeof summary>;
  const statuses = { queued: "queued", dispatched: "dispatched", completed: "completed", cancelled: "cancelled", needs_directory: "waiting_local_directory", needs_human: "awaiting_human", context_overflow: "failed", offer_too_large: "failed", step_progress: "running" };
  vi.mocked(api.listProjectActivity).mockResolvedValue(projectActivitySchema.parse({ ...page, items: [
    ...codes.map((code) => ({ ...row, attempt_id: code, status: statuses[code], public_summary: code === "step_progress" ? { code, step: 3, total: 5 } : { code } })),
    { ...row, attempt_id: "unknown", public_summary: { code: "PRIVATE_UNKNOWN" }, error_summary: "PRIVATE_REASON" },
  ] }));
  mount("view=history", locale);
  await screen.findAllByRole("listitem");
  for (const value of Object.values(summary)) expect(screen.getByText(value.replace("{{step}}", "3").replace("{{total}}", "5"))).toBeVisible();
  expect(screen.queryByText(/PRIVATE_/)).toBeNull();
});
