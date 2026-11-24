import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../http";
import { MembersEndpoints } from "./members";

const member = {
  id: "mem_shared", workspace_id: "ws-1", user_id: "local", role: "owner",
  name: "Workspace operator", avatar_url: null, created_at: "2026-10-13T00:00:00Z",
};
const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200, headers: { "Content-Type": "application/json" },
});

afterEach(() => vi.unstubAllGlobals());

describe("workspace actor queries", () => {
  it("separates the current operator from readonly historical attribution", async () => {
    const oldMember = { ...member, id: "mem_old", user_id: "old-account", name: "Historical author" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([member]))
      .mockResolvedValueOnce(jsonResponse([member, oldMember]));
    vi.stubGlobal("fetch", fetchMock);
    const endpoints = new MembersEndpoints(new HttpClient("https://api.example.test"));
    await expect(endpoints.listMembers("ws-1")).resolves.toEqual([member]);
    await expect(endpoints.listMembers("ws-1", true)).resolves.toEqual([member, oldMember]);
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      "https://api.example.test/api/workspaces/ws-1/members",
      "https://api.example.test/api/workspaces/ws-1/members?include_history=true",
    ]);
  });

  it.each([null, {}, [{ ...member, user_id: null }], [{ ...member, role: "superuser" }], [{ name: "Incomplete" }]])(
    "rejects malformed actors %j", async (body) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
      const endpoints = new MembersEndpoints(new HttpClient("https://api.example.test"));
      await expect(endpoints.listMembers("ws-1")).rejects.toThrow();
    },
  );
});
