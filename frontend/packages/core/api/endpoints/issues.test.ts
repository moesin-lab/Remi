import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../http";
import { ApiContractError } from "../schema";
import { IssuesEndpoints } from "./issues";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("issue creation acknowledgement", () => {
  it("preserves dispatch outcomes and legacy absence without inferring execution", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ...issue, task_id: "task-new", dispatch_status: "dispatched", dispatch_skipped_reason: null }))
      .mockResolvedValueOnce(jsonResponse({ ...issue, task_id: null, dispatch_status: "skipped", dispatch_skipped_reason: "no_runnable_agent" }))
      .mockResolvedValueOnce(jsonResponse(issue));
    vi.stubGlobal("fetch", fetchMock);
    const endpoint = new IssuesEndpoints(new HttpClient("https://api.example.test"));
    expect(await endpoint.createIssue({ title: "Create" })).toMatchObject({ task_id: "task-new", dispatch_status: "dispatched" });
    expect(await endpoint.createIssue({ title: "Create" })).toMatchObject({ task_id: null, dispatch_status: "skipped", dispatch_skipped_reason: "no_runnable_agent" });
    expect((await endpoint.createIssue({ title: "Create" })).dispatch_status).toBeUndefined();
  });

  it.each([
    { task_id: null, dispatch_status: "dispatched" },
    { task_id: "task-new", dispatch_status: "skipped" },
    { task_id: 42, dispatch_status: "dispatched" },
  ])("rejects contradictory or malformed dispatch responses: %j", async (fields) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ ...issue, ...fields })));
    await expect(new IssuesEndpoints(new HttpClient("https://api.example.test")).createIssue({ title: "Create" })).rejects.toThrow();
  });
});

const workspace = {
  issue_id: "issue-1",
  workspace_id: "ws-1",
  issue_key: "MUL-1",
  runtime_id: "runtime-1",
  runtime_name: "claude (legacy-host)",
  runtime_status: "online",
  root_path: "/tmp/MUL-1",
  branch_name: "agent/MUL-1",
  status: "ready",
  repos: [],
  last_task_id: null,
  cleaned_at: null,
  created_at: "2026-08-28T00:00:00.000Z",
  updated_at: "2026-08-28T00:00:00.000Z",
};

const issue = {
  id: "issue-1",
  workspace_id: "ws-1",
  number: 1,
  identifier: "MUL-1",
  title: "Parent issue",
  description: "Detail",
  status: "in_progress",
  priority: "medium",
  assignee_type: "agent",
  assignee_id: "agent-1",
  creator_type: "member",
  creator_id: "member-1",
  parent_issue_id: null,
  pending_decision_count: 1,
  project_id: null,
  position: 0,
  start_date: null,
  due_date: null,
  metadata: {},
  created_at: "2026-09-28T07:00:00.000Z",
  updated_at: "2026-09-28T08:00:00.000Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("IssuesEndpoints issue workspace response schema", () => {
  it("defaults machine metadata from an older server to null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ workspace })));
    const endpoints = new IssuesEndpoints(new HttpClient("https://api.example.test"));

    await expect(endpoints.getIssueWorkspace("issue-1")).resolves.toEqual({
      workspace: {
        ...workspace,
        runtime_provider: null,
        runtime_mode: null,
        runtime_device_info: null,
        runtime_daemon_id: null,
        runtime_machine_name: null,
      },
    });
  });

  it("falls back without throwing when machine metadata is malformed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      workspace: { ...workspace, runtime_machine_name: 42 },
    })));
    const endpoints = new IssuesEndpoints(new HttpClient("https://api.example.test"));

    await expect(endpoints.getIssueWorkspace("issue-1")).resolves.toEqual({ workspace: null });
  });
});

describe("IssuesEndpoints batch updates", () => {
  it("accepts both the legacy success body and per-row dependency skips", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ updated: 2 }))
      .mockResolvedValueOnce(jsonResponse({ updated: 1, skipped: [{ issueId: "issue-2", error: "waiting", code: "dependencies_unmet" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const endpoints = new IssuesEndpoints(new HttpClient("https://api.example.test"));

    await expect(endpoints.batchUpdateIssues(["issue-1", "issue-2"], { status: "todo" }))
      .resolves.toEqual({ updated: 2, skipped: [] });
    await expect(endpoints.batchUpdateIssues(["issue-1", "issue-2"], { status: "todo" }))
      .resolves.toEqual({ updated: 1, skipped: [{ issueId: "issue-2", error: "waiting", code: "dependencies_unmet" }] });
  });
});

describe("IssuesEndpoints decision detail contract", () => {
  it("parses the detail-only count of this issue's human-stage questions", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(issue)));
    const endpoints = new IssuesEndpoints(new HttpClient("https://api.example.test"));

    const detail = await endpoints.getIssue("issue-1");
    expect(detail.pending_decision_count).toBe(1);
    expect(detail).not.toHaveProperty("parent_done_grant");
    expect(detail).not.toHaveProperty("responsible_member_id");
  });

  it("still reads an older server that sends the retired grant and human fields", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      ...issue,
      responsible_member_id: "member-1",
      parent_done_grant_at: "2026-09-28T08:00:00.000Z",
      parent_done_grant: { granted_at: "2026-09-28T08:00:00.000Z", granted_by: "member-1", agent_id: "agent-1", effective: true, ineffective_reason: null },
    })));
    const endpoints = new IssuesEndpoints(new HttpClient("https://api.example.test"));

    await expect(endpoints.getIssue("issue-1")).resolves.toMatchObject({ id: "issue-1", pending_decision_count: 1 });
  });

  it("rejects a detail without the decision count", async () => {
    const listRow: Record<string, unknown> = { ...issue };
    delete listRow.pending_decision_count;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(listRow)));
    const endpoints = new IssuesEndpoints(new HttpClient("https://api.example.test"));

    await expect(endpoints.getIssue("issue-1")).rejects.toBeInstanceOf(ApiContractError);
  });

  it("no longer offers the parent-done grant routes", () => {
    const endpoints = new IssuesEndpoints(new HttpClient("https://api.example.test")) as unknown as Record<string, unknown>;
    expect(endpoints.grantParentDone).toBeUndefined();
    expect(endpoints.revokeParentDone).toBeUndefined();
  });
});
