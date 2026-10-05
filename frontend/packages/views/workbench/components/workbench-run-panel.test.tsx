import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import en from "../../locales/en/workbench.json";
import { WorkbenchRunPanel } from "./workbench-run-panel";

const list = vi.hoisted(() => vi.fn());
const rerun = vi.hoisted(() => vi.fn());
vi.mock("@multiremi/core/api", async (original) => ({ ...await original<object>(), api: { listTasksByIssue: list, rerunIssue: rerun } }));
vi.mock("@multiremi/core/workspace/hooks", () => ({ useActorName: () => ({ getAgentName: () => "Original agent" }) }));
vi.mock("../../common/task-transcript/task-trace-dialog", () => ({ TaskTraceDialog: ({ task, agentName }: { task: { id: string }; agentName: string }) => <div>Inspect {task.id} by {agentName}</div> }));

const failed = { id: "failed-1", issue_id: "issue-1", agent_id: "agent-1", status: "failed", created_at: "2026-10-05T01:00:00Z", error: "Worker stopped", prompt: "Keep this context" };
function mount() {
  return render(<I18nProvider locale="en" resources={{ en: { workbench: en } }}><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}><WorkbenchRunPanel issueId="issue-1" wsId="ws-1" /></QueryClientProvider></I18nProvider>);
}
beforeEach(() => { vi.clearAllMocks(); list.mockResolvedValue([failed]); });

describe("Workbench execution and recovery", () => {
  it("retries the chosen run once, retains failure context while pending and shows queued after acceptance", async () => {
    let resolve!: (value: unknown) => void;
    rerun.mockReturnValue(new Promise((done) => { resolve = done; }));
    mount();
    const button = await screen.findByRole("button", { name: "Retry run" });
    fireEvent.click(button); fireEvent.click(button);
    expect(rerun).toHaveBeenCalledExactlyOnceWith("issue-1", "failed-1");
    expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled();
    expect(screen.getByText("Worker stopped")).toBeInTheDocument();
    const next = { ...failed, id: "next-1", status: "queued", error: null, created_at: "2026-10-05T02:00:00Z" };
    list.mockResolvedValue([next, failed]); resolve(next);
    expect(await screen.findByText("Queued — waiting to start")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry run" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View run" }));
    expect(screen.getByText("Inspect next-1 by Original agent")).toBeInTheDocument();
  });

  it("keeps the failed run and a recovery explanation after a rejected retry", async () => {
    rerun.mockRejectedValue(new Error("network failed")); mount();
    fireEvent.click(await screen.findByRole("button", { name: "Retry run" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Retry was not confirmed");
    expect(screen.getByText("Worker stopped")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry run" })).toBeEnabled());
  });

  it("does not offer a retry when another run is active", async () => {
    list.mockResolvedValue([failed, { ...failed, id: "active-1", status: "running", error: null }]); mount();
    expect(await screen.findByText("Agent is working")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry run" })).not.toBeInTheDocument();
  });

  it("surfaces a read failure rather than an empty or completed execution", async () => {
    list.mockRejectedValue(new Error("offline")); mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("Execution state could not be loaded");
    list.mockResolvedValue([failed]); fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Latest run failed")).toBeInTheDocument();
  });
});
