import { claimWithCurrentRuntime } from "../../helpers/claim-with-current-runtime.js";
import { afterEach, expect, it, spyOn } from "bun:test";
import { reconcileRuntimeReady } from "../../fixtures/task-offer.js";
import { createLocalStore, createResponsibleTestIssue, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

it("runtime.ready fixture recovers every orphan without claiming either retry", async () => {
  const store = createLocalStore();
  const runtime = store.registerRuntime({ name: "recovery-only", provider: "claude", maxConcurrency: 3 });
  const parents = ["running", "waiting"].map(name => {
    const agent = store.createAgent({ name, provider: "claude" });
    const issue = createResponsibleTestIssue(store, { title: name, assigneeType: "agent", assigneeId: agent.id });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: name });
    expect(claimWithCurrentRuntime(store, runtime.id)?.id).toBe(task.id);
    return task;
  });
  store.startTask(parents[0]!.id);
  store.markTaskWaitingLocalDirectory(parents[1]!.id, "/tmp/recovery-only");
  const claim = spyOn(store, "claimTask");
  try {
    const frames = await reconcileRuntimeReady(store, runtime.id);
    expect(frames.some(frame => frame.t === "welcome")).toBe(true);
    expect(frames.filter(frame => frame.t === "task.offer")).toHaveLength(0);
    // A null prepare callback is too late: the pump has already claimed work.
    // Check all retries so whichever parent is selected, the old fixture fails.
    for (const parent of parents) {
      expect(store.getTask(parent.id)).toMatchObject({ status: "failed", failureReason: "runtime_recovery" });
      const retries = store.listTasks().filter(task => task.parentTaskId === parent.id);
      expect(retries).toHaveLength(1);
      expect(retries[0]).toMatchObject({ status: "queued", attempt: 2, acceptedAt: null, dispatchedAt: null });
    }
    expect(claim).not.toHaveBeenCalled();
  } finally { claim.mockRestore(); }
});
