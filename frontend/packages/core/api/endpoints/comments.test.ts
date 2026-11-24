import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../client";
import { ApiContractError } from "../schema";
import { CommentsEndpoints } from "./comments";
import { HttpClient } from "../http";
import { messageFixture } from "../unified.fixture";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const api = () => new CommentsEndpoints(new HttpClient("https://api.example.test"));
afterEach(() => vi.unstubAllGlobals());
describe("Issue message actions", () => {
  it("retains the server's final conversation for a routed role message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ message: messageFixture({ session_id: "destination" }), wake_applied: "inbox_only", wake_reason: "source_side_session" })));
    expect(await api().createComment("issue_1", "request", undefined, undefined, undefined, "source")).toMatchObject({ id: "msg_1", issue_session_id: "destination" });
  });
  it("preserves reactions from two members using the same emoji", async () => {
    const reactions = ["member_1", "member_2"].map((actorId, index) => ({ id: `r${index}`, commentId: "msg_1", actorType: "member", actorId, emoji: "👍", createdAt: "now" }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ reactions })));
    expect((await api().addReaction("msg_1", "👍")).map(r => r.actor_id)).toEqual(["member_1", "member_2"]);
  });
  it("refuses attachment changes instead of reporting a body-only edit as successful", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ message: messageFixture() })));
    await expect(api().updateComment("msg_1", "edited", ["new_attachment"])).rejects.toThrow("attachments cannot be changed");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("https://api.example.test/api/messages/msg_1", expect.not.objectContaining({ method: "PATCH" }));
  });
  it("preserves original-sender authorization failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: "not sender" }, 403)));
    await expect(api().deleteComment("msg_1")).rejects.toMatchObject({ status: 403 });
  });
});


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


it("sends an unselected Issue comment to its Issue-owned Main instead of a private Chat projection", async () => {
  const common = { workspace_id: "ws-1", status: "active", is_default: true, created_at: "", updated_at: "" };
  const fetchMock = vi.fn().mockResolvedValueOnce(json([
    { ...common, id: "private-main", title: "Chat Main", owner_type: "chat", owner_id: "chat-1", chat_id: "chat-1", issue_id: "issue-1" },
    { ...common, id: "issue-main", title: "Issue Main", owner_type: "issue", owner_id: "issue-1", chat_id: null, issue_id: "issue-1" },
  ])).mockResolvedValueOnce(json({ message: messageFixture({ session_id: "issue-main" }), wake_applied: "now", wake_reason: "member_request" }));
  vi.stubGlobal("fetch", fetchMock);
  await api().createComment("issue-1", "Follow up");
  expect(fetchMock).toHaveBeenLastCalledWith("https://api.example.test/api/sessions/issue-main/messages", expect.objectContaining({ method: "POST" }));
});

it("rejects a Session turn list containing another destination", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ turns: [{ id: "turn-1", session_id: "other", seq: 1, agent_id: "agent-1", status: "running", current_attempt_id: "attempt-1", input_from_seq: 0, input_to_seq: 1, created_at: "", started_at: null, ended_at: null, ended_reason: null }], next_cursor: null })));
  await expect(api().listSessionTasks("issue-1", "session-1")).rejects.toBeInstanceOf(ApiContractError);
});
