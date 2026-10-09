import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../client";
import { turnFixture } from "../unified.fixture";
import { TasksEndpoints } from "./tasks";
import { HttpClient } from "../http";
import { ApiContractError } from "../schema";
afterEach(() => vi.unstubAllGlobals());
describe("turn trace and issue projection", () => {
  it("keeps the chosen historical attempt when opening a turn trace", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ events: [], next_after_seq: 0, head: 0, eof: true, closed: true, source: "archive", state: "ok" })));
    await new ApiClient("https://api.example.test").getTaskTrace("attempt_1", 10, 50, "turn_1");
    expect(fetch).toHaveBeenCalledWith("https://api.example.test/api/turns/turn_1/trace?after_seq=10&limit=50&attempt_id=attempt_1", expect.anything());
  });
  it("loads all issue turn pages without fetching details for every row", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ turns: [turnFixture({ issue_id: "iss_1" })], next_cursor: "opaque+next" })).mockResolvedValueOnce(Response.json({ turns: [turnFixture({ id: "turn_2", current_attempt_id: "attempt_4" })], next_cursor: null })));
    const tasks = await new ApiClient("https://api.example.test").listTasksByIssue("MUL-509");
    expect(tasks.map(t => [t.id, t.turn_id])).toEqual([["attempt_2", "turn_1"], ["attempt_4", "turn_2"]]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenLastCalledWith("https://api.example.test/api/turns?issue=MUL-509&cursor=opaque%2Bnext&limit=100", expect.anything());
  });
});

const turn = turnFixture({ status: "completed" });
const attempt = { id: "attempt_1", turn_id: turn.id, attempt_no: 1, status: "failed", runtime_id: "runtime",
  provider: "codex", execution_model: "prior-model", execution_thinking_level: "high", fallback_switched: true,
  switch_reason: "fallback", usage: [{ totalTokens: 40 }], started_at: null, ended_at: null, error: "Prior attempt failed" };
function endpoint(response: unknown) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(response), { headers: { "Content-Type": "application/json" } })));
  return new TasksEndpoints(new HttpClient("https://example.test"));
}
it("maps a chosen historical attempt to the transcript view model", async () => {
  await expect(endpoint({ turn, attempts: [attempt] }).getTask(attempt.id, turn.id)).resolves.toMatchObject({
    id: attempt.id, turn_id: turn.id, agent_id: turn.agent_id, runtime_id: "runtime", issue_id: "", status: "failed", error: attempt.error,
    usage: attempt.usage, executionModel: "prior-model", executionThinkingLevel: "high", fallbackSwitched: true, switchReason: "fallback",
  });
  expect(fetch).toHaveBeenCalledWith("https://example.test/api/turns/turn_1?attempts=true", expect.anything());
});
it.each([{ turn: { ...turn, status: 4 } }, { turn: { ...turn, agent_id: undefined } }, { turn: null },
  { turn, attempts: [{ ...attempt, id: "other" }] }, { turn: { ...turn, id: "other" }, attempts: [attempt] }])("rejects malformed or mismatched turn detail", async response => {
  await expect(endpoint(response).getTask(attempt.id, turn.id)).rejects.toBeInstanceOf(ApiContractError);
});


describe("issue turn recovery contract", () => {
  it("retries the selected turn and retains its identity with a new attempt", async () => {
    const prior = turnFixture({ issue_id: "issue-1", status: "failed" });
    const retried = turnFixture({ ...prior, status: "pending", current_attempt_id: "new-attempt" });
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ turns: [prior], next_cursor: null }))
      .mockResolvedValueOnce(Response.json({ turn: retried }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(new ApiClient("https://api.example.test").rerunIssue("issue-1", prior.current_attempt_id!))
      .resolves.toMatchObject({ id: "new-attempt", turn_id: prior.id, issue_id: "issue-1", status: "queued" });
    expect(fetchMock).toHaveBeenLastCalledWith(`https://api.example.test/api/turns/${prior.id}/retry`, expect.objectContaining({ body: JSON.stringify({ cold: false }) }));
  });

  it.each([{}, { turn: { ...turn, id: "other" } }, { turn: { ...turn, agent_id: null } },
    { turn: { ...turn, status: "pending" } },
    { turn: { ...turn, status: "future_state", current_attempt_id: "new" } },
    { turn: { ...turn, status: "pending", current_attempt_id: "new", session_id: "other" } }])("rejects an unconfirmed turn retry: %j", async result => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ turns: [turnFixture({ issue_id: "issue-1" })], next_cursor: null }))
      .mockResolvedValueOnce(Response.json(result)));
    await expect(new ApiClient("https://api.example.test").rerunIssue("issue-1", "attempt_2")).rejects.toBeInstanceOf(ApiContractError);
  });

  it("rejects a corrupt execution list instead of reporting no runs", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ turns: [{ ...turn, created_at: 42 }], next_cursor: null })));
    await expect(new ApiClient("https://api.example.test").listTasksByIssue("issue-1")).rejects.toBeInstanceOf(ApiContractError);
  });
});


it("preserves an unknown turn read status for the display fallback", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ turns: [turnFixture({ status: "future_state" })], next_cursor: null })));
  expect((await new ApiClient("https://api.example.test").listTasksByIssue("issue-1"))[0]?.status).toBe("future_state");
});

it("preserves an unknown historical attempt status for the transcript fallback", async () => {
  await expect(endpoint({ turn, attempts: [{ ...attempt, status: "future_state" }] }).getTask(attempt.id, turn.id))
    .resolves.toMatchObject({ status: "future_state", usage: [{ totalTokens: 40 }] });
});


it("reads the current attempt failure and progress from the turn page without fetching each detail", async () => {
  const current = { id: "attempt_2", status: "failed", runtime_id: "runtime-1", provider: "codex", error: "Provider rejected the request", failure_reason: "agent_error", progress_summary: "Checking build", progress_step: 2, progress_total: 4 };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ turns: [turnFixture({ status: "failed", current_attempt: current })], next_cursor: null })));
  const tasks = await new ApiClient("https://api.example.test").listTasksByIssue("issue-1");
  expect(tasks).toMatchObject([{ id: "attempt_2", runtime_id: "runtime-1", status: "failed", error: current.error, failure_reason: current.failure_reason, progress_summary: current.progress_summary, progress_step: 2, progress_total: 4 }]);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([
  { id: "other", error: "Private attempt error" },
  { id: "attempt_2", error: 42 },
])("rejects a corrupt or mismatched current attempt projection", async fields => {
  const baseline = { id: "attempt_2", status: "failed", runtime_id: null, provider: null, error: null, failure_reason: null, progress_summary: null, progress_step: null, progress_total: null };
  const current = { ...baseline, ...fields };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ turns: [{ ...turn, current_attempt: current }], next_cursor: null })));
  await expect(new ApiClient("https://api.example.test").listTasksByIssue("issue-1")).rejects.toBeInstanceOf(ApiContractError);
});


it("keeps absent current-attempt diagnostics empty and honors explicit Issue ownership", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ turns: [turnFixture({ current_attempt: null, chat_session_id: null })], next_cursor: null })));
  expect((await new ApiClient("https://api.example.test").listTasksByIssue("issue-1"))[0])
    .toMatchObject({ error: null, runtime_id: null, chat_session_id: undefined });
});

it("uses the selected historical attempt diagnostics even when the turn includes the current attempt", async () => {
  const current = { id: "attempt_2", status: "completed", runtime_id: "current-runtime", provider: "codex", error: null, failure_reason: null, progress_summary: null, progress_step: null, progress_total: null };
  await expect(endpoint({ turn: { ...turn, current_attempt: current }, attempts: [attempt] }).getTask(attempt.id, turn.id))
    .resolves.toMatchObject({ id: attempt.id, runtime_id: "runtime", status: "failed", error: attempt.error });
});
