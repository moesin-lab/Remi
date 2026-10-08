import { afterEach, expect, it, vi } from "vitest";
import { ApiClient } from "../client";
import { ApiContractError } from "../schema";

afterEach(() => vi.unstubAllGlobals());

it("distinguishes an empty linked Session list from a malformed response", async () => {
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(Response.json([]))
    .mockResolvedValueOnce(Response.json({ unexpected: true })));
  const client = new ApiClient("https://api.example.test");
  await expect(client.listIssueSessions("issue-1")).resolves.toEqual([]);
  await expect(client.listIssueSessions("issue-1")).rejects.toBeInstanceOf(ApiContractError);
});

it("creates an Issue-owned Session and rejects a malformed or wrong owner acknowledgement", async () => {
  const session = {
    id: "session-1", owner_type: "issue", owner_id: "issue-1", chat_id: null, issue_id: "issue-1",
    workspace_id: "ws-1", title: "Review", status: "active", inherit_mode: "none",
    created_at: "2026-10-08T00:00:00Z", updated_at: "2026-10-08T00:00:00Z",
  };
  const response = vi.fn().mockResolvedValue(Response.json(session));
  vi.stubGlobal("fetch", response);
  const client = new ApiClient("https://api.example.test");
  await expect(client.createIssueSession("issue-1", { title: "Review" })).resolves.toMatchObject(session);
  expect(response).toHaveBeenCalledWith("https://api.example.test/api/issues/issue-1/sessions", expect.objectContaining({
    method: "POST", body: JSON.stringify({ title: "Review" }),
  }));
  for (const invalid of [
    { ...session, owner_type: "chat", owner_id: "chat-1", chat_id: "chat-1" },
    { ...session, owner_type: undefined, owner_id: undefined },
    { unexpected: true },
  ]) {
    response.mockResolvedValue(Response.json(invalid));
    await expect(client.createIssueSession("issue-1", { title: "Review" })).rejects.toBeInstanceOf(ApiContractError);
  }
});
