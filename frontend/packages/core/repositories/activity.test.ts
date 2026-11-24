import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { RepositoryActivityResponse } from "@multiremi/contracts";
import type { ActivityPage } from "../api/schemas/repository-activity";
import { RepositoriesEndpoints } from "../api/endpoints/repositories";
import type { HttpClient } from "../api/http";
import { ApiContractError } from "../api/schema";
import { activityFilters } from "./activity-filters";
import { repositoryActivityOptions } from "./queries";

describe("repository activity", () => {
  it("accepts every display value in the server contract", () => {
    expectTypeOf<RepositoryActivityResponse>().toExtend<ActivityPage>();
  });
  it("normalizes equivalent URLs and partitions workspace, repo, cursor and filters", () => {
    const key = (url: string, ws = "ws", repo = "repo") => repositoryActivityOptions(ws, repo, activityFilters(new URLSearchParams(url))).queryKey;
    expect(key("status=failed&q=%20bug%20")).toEqual(key("view=active&q=bug"));
    for (const change of [key("", "other"), key("", "ws", "other"), key("cursor=2"), key("agent_id=a"), key("status=running"), key("view=history"), key("q=bug")]) expect(change).not.toEqual(key(""));
  });
  it("preserves unknown enums, handles missing display values and rejects malformed pages", async () => {
    const fetch = vi.fn();
    const endpoint = new RepositoriesEndpoints({ fetch } as unknown as HttpClient);
    const read = () => endpoint.listRepositoryActivity("ws 1", "a/b", activityFilters(new URLSearchParams("view=history&q=%25_x")));
    const page = { has_more: false, next_cursor: null, as_of: null, items: [{ task_id: "id", status: "future", relation: "direct" }] };
    fetch.mockResolvedValue(page);
    expect((await read()).items[0]).toMatchObject({ task_id: "id", status: "future", started_at: null, change_requests: [] });
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/workspaces/ws%201/repos/a%2Fb/activity?view=history&q=%25_x");
    for (const invalid of [{}, { ...page, has_more: true }, { ...page, items: [{ task_id: 2 }] }]) {
      fetch.mockResolvedValue(invalid);
      await expect(read()).rejects.toBeInstanceOf(ApiContractError);
    }
  });
});
