import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../client";
import { ApiContractError } from "../schema";

afterEach(() => {
  vi.unstubAllGlobals();
});

const message = {
  id: "steer-1",
  taskId: "task-1",
  authorType: "user",
  authorId: "user-1",
  kind: "steer" as const,
  content: "Use Chinese",
  createdAt: "2026-08-22T00:00:00Z",
  consumedAt: null,
};

describe("TasksEndpoints steer", () => {
  it("posts a steer directive using the task endpoint contract", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient("https://api.example.test");
    await expect(client.steerTask("task/1", { content: "Use Chinese" })).resolves.toEqual({
      message,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/api/tasks/task%2F1/steer",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ content: "Use Chinese" }),
      }),
    );
  });

  it("rejects a malformed successful mutation response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: { id: "missing-fields" } }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const client = new ApiClient("https://api.example.test");
    await expect(client.steerTask("task-1", { force_answer: true })).rejects.toBeInstanceOf(
      ApiContractError,
    );
  });

  it("falls back to an empty audit list when a list response is malformed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ messages: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const client = new ApiClient("https://api.example.test");
    await expect(client.listTaskSteers("task-1")).resolves.toEqual({ messages: [] });
  });
});

describe("issue run recovery contract", () => {
  const task = { id: "task-new", issue_id: "issue-1", agent_id: "agent-1", status: "queued", created_at: "2026-10-05T00:00:00Z" };
  it("posts the selected run and requires a new run acknowledgement", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(task, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(new ApiClient("https://api.example.test").rerunIssue("issue-1", "task-old")).resolves.toEqual(task);
    expect(fetchMock).toHaveBeenCalledWith("https://api.example.test/api/issues/issue-1/rerun", expect.objectContaining({ body: JSON.stringify({ task_id: "task-old" }) }));
  });
  it.each([
    {}, { ...task, id: "task-old" }, { ...task, issue_id: "other" },
    { ...task, status: "invented" }, { ...task, agent_id: null },
  ])("rejects unconfirmed retry acknowledgements: %j", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body, { status: 202 })));
    await expect(new ApiClient("https://api.example.test").rerunIssue("issue-1", "task-old")).rejects.toBeInstanceOf(ApiContractError);
  });
  it("keeps unknown read statuses but rejects a corrupt execution list", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json([{ ...task, status: "future_state" }]))
      .mockResolvedValueOnce(Response.json([{ ...task, created_at: 42 }])));
    const client = new ApiClient("https://api.example.test");
    expect((await client.listTasksByIssue("issue-1"))[0]?.status).toBe("future_state");
    await expect(client.listTasksByIssue("issue-1")).rejects.toBeInstanceOf(ApiContractError);
  });
});
