import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, createResponsibleTestAutopilot, resetMultiremiTestEnv } from "./helpers.js";

import { reconcileObservation } from "@multiremi/scm/reconcile.js";
import { scmIngestionStore } from "@multiremi/scm/store.js";
import { GitHubScmProviderAdapter } from "@multiremi/scm/github.js";

const originalEncryptionKey = process.env.MULTIREMI_SCM_ENCRYPTION_KEY;

afterEach(() => {
  if (originalEncryptionKey === undefined) delete process.env.MULTIREMI_SCM_ENCRYPTION_KEY;
  else process.env.MULTIREMI_SCM_ENCRYPTION_KEY = originalEncryptionKey;
  resetMultiremiTestEnv();
});

describe("Multiremi API — normalized SCM webhooks", () => {
  it("accepts a signed provider webhook and persists one deduplicated canonical event", async () => {
    process.env.MULTIREMI_SCM_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    const store = createStore();
    store.ensureLocalWorkspace();
    store.updateWorkspace("local", {
      repos: [{ id: "repo_widgets", name: "widgets", url: "https://github.com/acme/widgets.git", defaultBranch: "main" }],
    });
    store.createScmConnection({
      id: "scm_github",
      workspaceId: "local",
      name: "GitHub",
      provider: "github",
      mode: "hybrid",
      accessToken: "token",
      webhookSecret: "webhook-secret",
      repositoryIds: ["repo_widgets"],
    });
    const body = {
      action: "opened",
      repository: { id: 101, name: "widgets", owner: { login: "acme" }, default_branch: "main" },
      pull_request: {
        id: 9001,
        number: 42,
        title: "Ship it",
        state: "open",
        created_at: "2026-08-21T07:00:00.000Z",
        updated_at: "2026-08-21T07:00:00.000Z",
        head: { ref: "feature", sha: "abc" },
        base: { ref: "main", sha: "def" },
      },
    };
    const rawBody = JSON.stringify(body);
    const signature = createHmac("sha256", "webhook-secret").update(rawBody).digest("hex");
    const app = createMultiremiApp({ store, authToken: "dashboard-secret" });
    const send = () => app.request("/api/webhooks/scm/scm_github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "pull_request",
        "X-GitHub-Delivery": "delivery-1",
        "X-Hub-Signature-256": `sha256=${signature}`,
      },
      body: rawBody,
    });

    const accepted = await send();
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({
      accepted: true,
      provider: "github",
      provider_event: "pull_request",
      events: [{ type: "change.opened", created: true, evidence_created: true }],
    });
    const events = store.listScmCanonicalEvents({ workspaceId: "local" });
    expect(events).toHaveLength(1);
    expect(store.listScmEventEvidence(events[0]!.id)).toHaveLength(1);

    const duplicate = await send();
    expect(duplicate.status).toBe(202);
    expect((await duplicate.json()).events[0]).toMatchObject({ created: false, evidence_created: false });
    expect(store.listScmCanonicalEvents({ workspaceId: "local" })).toHaveLength(1);
  });

  it("keeps signed check evidence out of workflow automation through ingestion and reconciliation", async () => {
    process.env.MULTIREMI_SCM_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    const store = createStore();
    store.ensureLocalWorkspace();
    store.updateWorkspace("local", { repos: [{ id: "repo_widgets", name: "widgets", url: "https://github.com/acme/widgets.git", defaultBranch: "main" }] });
    const connection = store.createScmConnection({ id: "scm_github", workspaceId: "local", name: "GitHub", provider: "github", mode: "hybrid", accessToken: "token", webhookSecret: "webhook-secret", repositoryIds: ["repo_widgets"] });
    const agent = store.createAgent({ name: "Pipeline observer", provider: "codex" });
    const autopilot = createResponsibleTestAutopilot(store, { title: "Observe workflows", workspaceId: "local", assigneeId: agent.id, executionMode: "run_only" });
    store.createAutopilotTrigger(autopilot.id, { kind: "scm_event", eventConfig: { resource: "scm", events: ["pipeline.completed"], repositoryIds: ["repo_widgets"] } });
    const app = createMultiremiApp({ store });
    const repository = { id: 101, name: "widgets", owner: { login: "acme" } };
    const checkBody = { repository, check_run: { id: 7001, name: "lint", head_sha: "abc", status: "completed", conclusion: "success", completed_at: new Date().toISOString(), app: { id: 15368, slug: "github-actions" }, check_suite: { id: 31 } } };
    const send = (event: string, body: Record<string, unknown>) => {
      const rawBody = JSON.stringify(body);
      return app.request("/api/webhooks/scm/scm_github", { method: "POST", headers: {
        "Content-Type": "application/json", "X-GitHub-Event": event, "X-GitHub-Delivery": `delivery-${event}`,
        "X-Hub-Signature-256": `sha256=${createHmac("sha256", "webhook-secret").update(rawBody).digest("hex")}`,
      }, body: rawBody });
    };
    const unsigned = await app.request("/api/webhooks/scm/scm_github", { method: "POST", headers: { "Content-Type": "application/json", "X-GitHub-Event": "check_run" }, body: JSON.stringify(checkBody) });
    expect(unsigned.status).toBe(401);
    expect(store.getScmEntitySnapshot("scm_github", "repo_widgets", "check_run", "check_run:7001")).toBeNull();
    const accepted = await send("check_run", checkBody);
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({ events: [], ignored: expect.stringContaining("internal checks") });
    const evidence = store.getScmEntitySnapshot("scm_github", "repo_widgets", "check_run", "check_run:7001")!;
    expect(evidence.payload).toMatchObject({ name: "lint", app_id: 15368, app_slug: "github-actions", check_suite_id: "31", head_sha: "abc", raw_body: JSON.stringify(checkBody) });
    await send("check_run", checkBody);
    expect(store.getScmEntitySnapshot("scm_github", "repo_widgets", "check_run", "check_run:7001")?.contentHash).toBe(evidence.contentHash);
    expect(store.getScmEntitySnapshot("scm_github", "repo_widgets", "pipeline", "check_run:7001")).toBeNull();
    expect(store.dispatchPendingScmEvents()).toHaveLength(0);

    const binding = store.listScmRepositoryBindings({ connectionId: connection.id })[0]!;
    const observation = new GitHubScmProviderAdapter().parseWebhook({ connection, credential: { accessToken: "token", webhookSecret: "webhook-secret" }, headers: { "x-github-event": "check_run" }, body: checkBody, rawBody: JSON.stringify(checkBody), observedAt: new Date().toISOString() }).internalObservations![0]!.observation;
    // Exercise the shared poll/reconcile path, including a legacy pipelines observation.
    for (const stream of ["checks", "pipelines"] as const) {
      const reconciled = reconcileObservation({ store: scmIngestionStore(store), binding, observation: { ...observation, stream, entityType: stream === "pipelines" ? "pipeline" : "check_run", version: `poll-${stream}`, payload: { ...observation.payload, conclusion: "failure" } }, baseline: false, source: "poll" });
      expect(reconciled.events).toHaveLength(0);
    }
    expect(store.getScmEntitySnapshot("scm_github", "repo_widgets", "pipeline", "check_run:7001")).toBeNull();
    expect(store.dispatchPendingScmEvents()).toHaveLength(0);
    expect(store.listScmCanonicalEvents({ workspaceId: "local" })).toHaveLength(0);

    const workflow = await send("workflow_run", { repository, workflow_run: { id: 501, run_attempt: 1, name: "CI", head_sha: "abc", head_branch: "main", status: "completed", conclusion: "failure", updated_at: new Date().toISOString() } });
    expect(workflow.status).toBe(202);
    const events = store.listScmCanonicalEvents({ workspaceId: "local" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "pipeline.completed", subjectId: "workflow_run:501:1", payload: { conclusion: "failure", head_sha: "abc" } });
    const runs = store.dispatchPendingScmEvents(new Date(Date.now() + 1_000));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.eventId).toBe(events[0]!.id);
    expect(store.dispatchPendingScmEvents(new Date(Date.now() + 2_000))).toHaveLength(0);
  });

  it("rejects an unsigned webhook before parsing or persistence", async () => {
    process.env.MULTIREMI_SCM_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    const store = createStore();
    store.ensureLocalWorkspace();
    store.updateWorkspace("local", {
      repos: [{ id: "repo_widgets", name: "widgets", url: "https://github.com/acme/widgets.git", defaultBranch: "main" }],
    });
    store.createScmConnection({
      id: "scm_github",
      workspaceId: "local",
      name: "GitHub",
      provider: "github",
      mode: "webhook",
      webhookSecret: "webhook-secret",
      repositoryIds: ["repo_widgets"],
    });
    const response = await createMultiremiApp({ store }).request("/api/webhooks/scm/scm_github", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-GitHub-Event": "push" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "scm_webhook_signature_invalid" });
    expect(store.listScmCanonicalEvents({ workspaceId: "local" })).toHaveLength(0);
  });
});

