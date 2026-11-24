import { useState } from "react";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { paths } from "@multiremi/core/paths";
import { api } from "@multiremi/core/api";
import { repositoryListOptions } from "@multiremi/core/repositories";
import { NavigationProvider } from "../navigation";
import { traceTurn, turnPage } from "../test/trace-fixtures";
import { renderWithI18n } from "../test/i18n";
import { RepositoryActivityPage } from "./repository-activity-page";

vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws" }));
vi.mock("@multiremi/core/paths", async (load) => {
  const actual = await load<typeof import("@multiremi/core/paths")>();
  return { ...actual, useWorkspacePaths: () => actual.paths.workspace("test") };
});
vi.mock("@multiremi/core/api", () => ({ api: {
  listRepositoryActivity: vi.fn(), listAgents: vi.fn(), listWorkspaceRepositories: vi.fn(), getTaskTrace: vi.fn(),
} }));
vi.mock("@multiremi/core/realtime", () => ({ useTraceStreamSubscription: vi.fn() }));
vi.mock("../common/task-transcript/agent-transcript-dialog", () => ({ AgentTranscriptDialog: ({ task, onOpenChange }: { task: { id: string }; onOpenChange: (open: boolean) => void }) => <div role="dialog">{task.id}<button onClick={() => onOpenChange(false)}>Close</button></div> }));

const row = {
  task_id: "task-1", turn_id: "turn-1", status: "failed", relation: "project_context", created_at: null, started_at: null, ended_at: null,
  issue: { id: "issue", key: "QA-1", title: "Build" }, issue_session: { id: "session", title: "Review" },
  failure_reason: "build failed", error_summary: null, progress_summary: null, wait_reason: null, attempt: 2,
  change_requests: [{ id: "pr1", number: 1, state: "open", url: "https://example.invalid/pull/1" }], change_request_count: 1,
};
const page = { items: [row], has_more: true, next_cursor: "next", as_of: "2026-11-24T12:00:00Z" };

function mount(search = "view=history", cachedName?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (cachedName) client.setQueryData(repositoryListOptions("ws").queryKey, {
    repositories: [{ id: "r", name: cachedName, url: "https://example.invalid/r.git", source: "github",
      description: null, default_branch: null, imported_at: null, updated_at: null }], total: 1,
  });
  const push = vi.fn();
  function App() {
    const [url, setUrl] = useState(`/test/repos/r/activity?${search}`);
    const current = new URL(url, "https://example.invalid");
    return <QueryClientProvider client={client}><NavigationProvider value={{
      push: (path) => { push(path); setUrl(path); }, replace: setUrl, back: vi.fn(), pathname: current.pathname,
      searchParams: current.searchParams, getShareableUrl: () => url,
    }}><RepositoryActivityPage repositoryId="r" /></NavigationProvider></QueryClientProvider>;
  }
  renderWithI18n(<App />);
  return { client, push, user: userEvent.setup() };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.listRepositoryActivity).mockResolvedValue(page);
  vi.mocked(api.listAgents).mockResolvedValue([]);
  vi.mocked(api.getTaskTrace).mockResolvedValue(turnPage(traceTurn({ id: "turn-1" }), []));
  vi.mocked(api.listWorkspaceRepositories).mockResolvedValue({ repositories: [], total: 0 });
});

it.each([undefined, "Cached repository"])("opens the activity URL without fetching repositories (cached name %s)", async (name) => {
  mount("view=history", name);
  await screen.findByText("build failed");
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(`${name ?? "r"} ·`);
  expect(api.listWorkspaceRepositories).not.toHaveBeenCalled();
});

it("keeps filters in navigation, resets the cursor on changes and paginates in both directions", async () => {
  const { push, user } = mount("view=history&agent_id=a");
  await screen.findByText("build failed");
  await user.selectOptions(screen.getByLabelText("Status"), "failed");
  await user.type(screen.getByLabelText("Issue key or title"), " QA-1 ");
  await user.click(screen.getByText("Apply filters"));
  const filtered = "/test/repos/r/activity?view=history&agent_id=a&status=failed&q=QA-1";
  expect(push).toHaveBeenLastCalledWith(filtered);
  await user.click(await screen.findByText("Next page"));
  expect(push).toHaveBeenLastCalledWith(`${filtered}&cursor=next`);
  await user.click(screen.getByText("Previous page"));
  expect(push).toHaveBeenLastCalledWith(filtered);
  await user.click(screen.getByText("In progress"));
  expect(push).toHaveBeenLastCalledWith("/test/repos/r/activity?view=active&agent_id=a&q=QA-1");
});

it("preserves row and focus while refreshing, shows current associations and fetches the exact log on click", async () => {
  const { client, user } = mount();
  await screen.findByText("build failed");
  expect(screen.getByText("QA-1 · Build")).toHaveAttribute("href", paths.workspace("test").issueDetail("issue"));
  expect(screen.getByText("Session · Review")).toHaveAttribute("href", paths.workspace("test").issueSession("issue", "session"));
  expect(screen.getByText("Project context")).toBeVisible();
  expect(screen.getByText(/task may have worked elsewhere/)).toBeVisible();
  expect(screen.getByText("Duration —")).toBeVisible();
  const summary = screen.getByText(/task-1 · PR/);
  await user.click(summary);
  expect(screen.getByText("PR #1 · open")).toHaveAttribute("href", "https://example.invalid/pull/1");
  expect(screen.getByText("No current worktree")).toBeVisible();
  let finish!: (value: typeof page) => void;
  const search = screen.getByLabelText("Issue key or title");
  await user.click(search);
  vi.mocked(api.listRepositoryActivity).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  act(() => { void client.invalidateQueries({ queryKey: ["repository-activity"] }); });
  expect(summary.parentElement).toHaveAttribute("open");
  expect(search).toHaveFocus();
  expect(screen.queryByText("Loading tasks…")).toBeNull();
  await act(async () => finish(page));
  expect(api.getTaskTrace).not.toHaveBeenCalled();
  const observers = () => client.getQueryCache().find({ queryKey: ["task-trace", "task-1"] })?.getObserversCount() ?? 0;
  expect(observers()).toBe(0);
  await user.click(screen.getByLabelText("Open task log"));
  await waitFor(() => expect(api.getTaskTrace).toHaveBeenCalledWith("task-1", {itemCursor: 0, turnId: "turn-1"}));
  expect(screen.getByRole("dialog")).toHaveTextContent("task-1");
  expect(observers()).toBe(1);
  await user.click(screen.getByText("Close"));
  expect(observers()).toBe(0);
});

it("distinguishes request failure, empty page and missing relations", async () => {
  vi.mocked(api.listRepositoryActivity).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ ...page, items: [] });
  const { client, user } = mount();
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not load repository tasks");
  await user.click(screen.getByText("Retry"));
  expect(await screen.findByText("No tasks match these filters.")).toBeVisible();
  vi.mocked(api.listRepositoryActivity).mockResolvedValueOnce({ ...page, items: [{ ...row, relation: "direct", issue: null, issue_session: null, change_requests: [], change_request_count: 0 }] });
  await act(async () => { await client.invalidateQueries({ queryKey: ["repository-activity"] }); });
  expect(await screen.findByText("No linked Issue")).toBeVisible();
  expect(screen.getByText("Direct target")).toBeVisible();
});

it("uses the page timestamp for running tasks and omits impossible or missing terminal durations", async () => {
  vi.mocked(api.listRepositoryActivity).mockResolvedValueOnce({ ...page, items: [
    { ...row, status: "running", started_at: "2026-11-24T11:58:00Z", relation: "issue_pr" },
    { ...row, task_id: "task-2", status: "completed", started_at: "2026-11-24T11:00:00Z", ended_at: null },
    { ...row, task_id: "task-3", status: "future", started_at: "2026-11-24T11:00:00Z", ended_at: "2026-11-23T11:00:00Z" },
  ] });
  mount("view=active");
  expect(await screen.findByText(/Duration 2 min/)).toBeVisible();
  expect(screen.getAllByText("Duration —")).toHaveLength(2);
  expect(screen.getByText("Issue PR")).toBeVisible();
  expect(screen.getByText("future")).toBeVisible();
});
