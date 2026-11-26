import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { ProjectActivityResponse } from "@multiremi/contracts";
import { ProjectsEndpoints } from "../api/endpoints/projects";
import type { HttpClient } from "../api/http";
import { projectActivitySchema, type ActivityPage } from "../api/schemas/project-activity";
import { activityFilters, projectActivityOptions } from "./activity";

const base = { attempt_id: "a1", turn_id: "t1", attempt_no: 1, issue: { id: "i1", key: "QA-7", title: "QA" },
  agent: { id: "executor", name: "Executor" }, issue_session: null, updated_at: "1", started_at: null };
const page = { has_more: false, next_cursor: null, as_of: null };
function parse(status: string, public_summary: unknown) {
  return projectActivitySchema.parse({ ...page, items: [{ ...base, status, public_summary, error: "PRIVATE", wait_reason: "PRIVATE" }] }).items[0]!;
}

describe("project activity boundary", () => {
  it("accepts the shared response and drops raw fields and malformed timestamps", () => {
    expectTypeOf<ProjectActivityResponse>().toExtend<ActivityPage>();
    const row = parse("failed", { code: "context_overflow", error: "PRIVATE" });
    expect(row.public_summary).toEqual({ code: "context_overflow" });
    expect(row.updated_at).toBeNull();
    expect(JSON.stringify(row)).not.toContain("PRIVATE");
  });
  it.each([null, {}, { code: "unknown", raw: "PRIVATE" }, { code: "needs_human" },
    ...[[1, 0], [-1, 1], [3, 2], [1, 1_000_001], [0.1, 1], ["1", 2], [0, Infinity]].map(([step, total]) => ({ code: "step_progress", step, total })),
  ])("unknown or invalid running summary becomes null (%j)", (summary) => {
    expect(parse("running", summary).public_summary).toBeNull();
  });
  it("keeps only bounded progress and suppresses stale progress on failure", () => {
    for (const step of [0, 1_000_000]) {
      const summary = { code: "step_progress", step, total: 1_000_000 };
      expect(parse("running", { ...summary, secret: "PRIVATE" }).public_summary).toEqual(summary);
      expect(parse("failed", summary).public_summary).toBeNull();
    }
    for (const attempt_no of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(projectActivitySchema.safeParse({ ...page, items: [{ ...base, status: "queued", attempt_no }] }).success).toBe(false);
    }
  });
  it("normalizes equivalent filters, isolates workspace/project/cursor/filters and passes cancellation", async () => {
    const key = (raw: string, ws = "w", project = "p") => projectActivityOptions(ws, project, activityFilters(new URLSearchParams(raw))).queryKey;
    expect(key("q=%20Bug%20&from=2026-11-25T00:00:00Z")).toEqual(key("view=active&limit=30&q=bug&from=2026-11-25T00:00:00.000Z"));
    expect(key("q=Ä")).not.toEqual(key("q=ä"));
    for (const other of [key("", "b"), key("", "w", "b"), ...["view=history", "status=running", "q=QA", "agent_id=x", "cursor=c", "limit=1", "from=x", "to=x"].map((raw) => key(raw))]) expect(other).not.toEqual(key(""));
    const fetch = vi.fn().mockResolvedValue({ ...page, items: [] });
    const endpoint = new ProjectsEndpoints({ fetch } as unknown as HttpClient);
    const { signal } = new AbortController();
    await endpoint.listProjectActivity("some/project", { view: "history", q: "%_" }, signal);
    expect(fetch).toHaveBeenCalledWith("/api/projects/some%2Fproject/activity?view=history&q=%25_", { signal });
    fetch.mockResolvedValue({ ...page, items: [], has_more: true });
    await expect(endpoint.listProjectActivity("p", {})).rejects.toThrow();
  });
});
