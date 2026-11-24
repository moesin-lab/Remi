import { ScmRepo } from "@multiremi/store/repos/scm-repo.js";
import { runStartupMigrations } from "@multiremi/store/migrations.js";
import { assertScmOwnershipReady, classifyScmLinkBatch, classifyScmLinks } from "@multiremi/store/scm-ownership.js";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { parseChangeRequestReference, parseChangeRequestUrl, readChangeRequest } from "@multiremi/scm/change-request-binding.js";
import { GitHubScmProviderAdapter, githubPullObservation } from "@multiremi/scm/github.js";
import { ScmPollingScheduler } from "@multiremi/scm/poller.js";
import { observationSnapshotInput, reconcileObservation } from "@multiremi/scm/reconcile.js";
import { scmIngestionStore } from "@multiremi/scm/store.js";
import { migratedStoreBackend, type MigratedStore } from "../../helpers/migrated-store-backends.js";
import { createResponsibleTestIssue, resetMultiremiTestEnv } from "./helpers.js";
import { scmBinding, scmConnection } from "./scm-test-helpers.js";

const originalFetch = globalThis.fetch;
const originalKey = process.env.MULTIREMI_SCM_ENCRYPTION_KEY;
const originalHosts = process.env.MULTIREMI_SCM_ALLOWED_API_HOSTS;
const opened: MigratedStore[] = [];
const pull = {
  id: 9001, number: 42, title: "Clean title", body: "No ticket identifiers", state: "open",
  html_url: "https://github.com/acme/widgets/pull/42",
  head: { ref: "feature", sha: "a".repeat(40) },
  base: { ref: "main", sha: "b".repeat(40), repo: { full_name: "acme/widgets" } },
  updated_at: "2026-11-16T00:00:00Z",
};
const headers = { Authorization: "Bearer dashboard-secret", "Content-Type": "application/json" };
function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = Object.assign((url: Parameters<typeof fetch>[0], init?: RequestInit) => Promise.resolve(handler(String(url), init)), { preconnect: originalFetch.preconnect });
}
afterEach(async () => {
  globalThis.fetch = originalFetch;
  for (const fixture of opened.splice(0)) await fixture.close();
  resetMultiremiTestEnv();
  if (originalKey === undefined) delete process.env.MULTIREMI_SCM_ENCRYPTION_KEY;
  else process.env.MULTIREMI_SCM_ENCRYPTION_KEY = originalKey;
  if (originalHosts === undefined) delete process.env.MULTIREMI_SCM_ALLOWED_API_HOSTS;
  else process.env.MULTIREMI_SCM_ALLOWED_API_HOSTS = originalHosts;
});

for (const backend of ["sqlite", "postgres"] as const) {
  describe.skipIf(backend === "postgres" && !process.env.MULTIREMI_TEST_POSTGRES_URL)(`SCM reference binding (${backend})`, () => {
    const factory = migratedStoreBackend(backend, { prefix: "remi_scm_bind_", fixture: "scm-reference-binding" });
    factory.install();
    async function setup() {
      process.env.MULTIREMI_SCM_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
      const fixture = await factory.open();
      opened.push(fixture);
      const { store, db } = fixture;
      classifyScmLinks(db);
      store.updateWorkspace("local", { repos: [{ id: "repo_widgets", name: "widgets", url: "https://github.com/acme/widgets.git" }], settings: { scm_auto_link_enabled: false } });
      const connection = store.createScmConnection({ id: "scm_github", workspaceId: "local", name: "GitHub", provider: "github", accessToken: "connection-secret", repositoryIds: ["repo_widgets"] });
      const issue = createResponsibleTestIssue(store, { title: "Explicit binding", workspaceId: "local" });
      const app = createMultiremiApp({ store, authToken: "dashboard-secret" });
      const bind = (body: unknown, authHeaders = headers, issueId = issue.id) => app.request(`/api/issues/${issueId}/change-requests/by-reference`, { method: "PUT", headers: authHeaders, body: JSON.stringify(body) });
      const snapshot = (value = pull) => observationSnapshotInput(store.getScmRepositoryBinding(connection.id, "repo_widgets")!, githubPullObservation(value, new Date()));
      const count = (table: string) => Number((db.query(`SELECT COUNT(*) AS count FROM multiremi_scm_${table}`).get() as { count: number }).count);
      return { store, db, connection, issue, app, bind, snapshot, count };
    }

    it("freezes only existing ownership, resumes by link ID and gates incomplete cutover", async () => {
      const { store, db, connection, issue, snapshot, count, bind } = await setup();
      const weak = createResponsibleTestIssue(store, { title: "Weak mention", workspaceId: "local" });
      const inactive = createResponsibleTestIssue(store, { title: "Removed link", workspaceId: "local" });
      const manual = createResponsibleTestIssue(store, { title: "Manual owner", workspaceId: "local" });
      store.updateWorkspace("local", { settings: { scm_complete_issue_on_merge_enabled: true } });
      db.run("UPDATE multiremi_issues SET issue_key = NULL WHERE id = ?", [issue.id]);
      const legacyTitle = `${issue.key} ${inactive.key}`;
      const observed = { ...pull, title: legacyTitle, body: `Fixes: ${issue.key}\nAlso mentions ${weak.key}`,
        head: { ...pull.head, ref: `branch/${issue.key.toLowerCase()}` } };
      store.advanceScmEntitySnapshot(snapshot(observed));
      const projection = store.prepareScmChangeRequestBinding(issue.workspaceId, issue.id, connection.id, "repo_widgets", 42).changeRequest!;
      for (const [id, issueId, source, active] of [
        ["a", issue.id, "legacy", 1], ["b", inactive.id, "auto", 0], ["c", weak.id, "auto", 1], ["d", manual.id, "manual", 1],
      ]) {
        db.run(`INSERT INTO multiremi_scm_issue_links
          (id, workspace_id, change_request_id, issue_id, source, active, linked_at, created_at, updated_at)
          VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?)`, [id, projection.id, issueId, source, active, pull.updated_at, pull.updated_at, pull.updated_at]);
      }
      const links = () => db.query("SELECT * FROM multiremi_scm_issue_links ORDER BY id").all();
      const before = links();
      db.exec("DROP TABLE multiremi_scm_link_ownership");
      db.exec("DROP TABLE multiremi_scm_ownership_cutover");
      db.run("DELETE FROM multiremi_schema_steps WHERE level >= 4");
      db.run("UPDATE multiremi_schema_meta SET expand_level = 3");
      runStartupMigrations(db);
      runStartupMigrations(db);
      expect(count("ownership_cutover")).toBe(0);
      expect(() => assertScmOwnershipReady(db)).toThrow("cutover incomplete");
      expect(classifyScmLinkBatch(db, 1)).toBe(false);
      expect(() => store.unlinkScmChangeRequestFromIssue(issue.id, projection.id)).toThrow("cutover incomplete");
      expect(() => store.advanceScmEntitySnapshot(snapshot())).toThrow("cutover incomplete");
      expect(store.dispatchPendingScmEvents()).toEqual([]);
      expect(db.query("SELECT cursor_id, complete FROM multiremi_scm_ownership_cutover").get()).toEqual({cursor_id: "a", complete: 0});
      db.run("INSERT INTO multiremi_scm_link_ownership(link_id, attribution) VALUES ('b', '[]')");
      expect(() => classifyScmLinkBatch(db, 1)).toThrow();
      expect(db.query("SELECT cursor_id FROM multiremi_scm_ownership_cutover").get()?.cursor_id).toBe("a");
      db.run("DELETE FROM multiremi_scm_link_ownership WHERE link_id = 'b'");
      classifyScmLinks(db);
      classifyScmLinks(db);
      expect(links()).toEqual(before);
      expect(count("link_ownership")).toBe(3);
      expect(store.listScmChangeRequestsForIssue(inactive.id)).toEqual([]);
      const merged = { ...pull, title: weak.key, merged: true, state: "closed", merged_at: "2026-11-18T00:00:00Z", updated_at: "2026-11-18T00:00:00Z" };
      const observation = githubPullObservation(merged, new Date());
      const input = { store: scmIngestionStore(store), binding: store.getScmRepositoryBinding(connection.id, "repo_widgets")!, observation, baseline: false };
      reconcileObservation(input);
      reconcileObservation(input);
      for (const [owner, evidence] of [[issue, ["branch", "title", "body"]], [manual, ["manual"]], [weak, []], [inactive, []]] as const) {
        const events = store.listIssueActivity(owner.id).filter(event => event.type === "scm_merge_completed");
        expect(events).toHaveLength(evidence.length ? 1 : 0);
        if (evidence.length) expect(events[0]?.data).toMatchObject({ attribution: evidence });
        expect(store.getIssue(owner.id)?.status).toBe("todo");
      }
      expect(store.listScmChangeRequestsForIssue(weak.id)).toHaveLength(1);
      expect((await bind({ url: pull.html_url }, headers, inactive.id)).status).toBe(200);
      expect(store.listScmChangeRequestsForIssue(inactive.id)).toHaveLength(1);
      expect(count("issue_links")).toBe(4);
    });

    it("imports before polling, persists an active manual link, and retries without timestamps or broadcasts", async () => {
      const { store, issue, bind, count } = await setup();
      let calls = 0;
      const events: unknown[] = [];
      store.onWorkspaceEvent(event => {
        if (event.type !== "change_request:updated") return;
        expect(store.listScmChangeRequestsForIssue(issue.id)).toHaveLength(1);
        events.push(event);
      });
      mockFetch((url, init) => {
        calls++;
        expect(url).toBe("https://api.github.com/repos/acme/widgets/pulls/42");
        expect(init?.method).toBe("GET");
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer connection-secret");
        expect(init?.redirect).toBe("error");
        return Response.json(pull);
      });
      const first = await bind({ url: pull.html_url });
      expect(first.status).toBe(200);
      const result = await first.json();
      expect(result).toMatchObject({ changeRequest: { externalId: "9001", title: "Clean title", sourceBranch: "feature" }, link: { source: "manual", active: true, issueId: issue.id } });
      const retry = await bind({ repository: "acme/widgets", number: 42 });
      expect(await retry.json()).toEqual(result);
      expect(calls).toBe(1);
      expect(events).toHaveLength(1);
      expect(count("change_requests")).toBe(1);
      expect(count("issue_links")).toBe(1);
      expect(count("events")).toBe(0);
      const listed = await appList(store, issue.id);
      expect(listed.total).toBe(1);
      expect(listed.changeRequests[0].repositoryOwner).toBe("acme");
    });

    it("baseline import of an already merged object does not replay history on the next poll", async () => {
      const { store, connection, issue, bind, count } = await setup();
      store.updateWorkspace("local", { settings: { scm_complete_issue_on_merge_enabled: true } });
      const merged = { ...pull, state: "closed", merged: true, merged_at: "2026-11-15T00:00:00Z" };
      mockFetch(() => Response.json(merged));
      expect((await bind({ url: pull.html_url })).status).toBe(200);
      const result = reconcileObservation({ store: scmIngestionStore(store), binding: store.getScmRepositoryBinding(connection.id, "repo_widgets")!, observation: githubPullObservation(merged, new Date()), baseline: false });
      expect(result.events).toHaveLength(0);
      expect(count("events")).toBe(0);
      expect(count("effects")).toBe(0);
      expect(store.listIssueActivity(issue.id).filter(event => event.type === "scm_merge_completed")).toHaveLength(0);
    });

    it("keeps manual ownership for a later real merge with no Issue Key and never closes the Issue", async () => {
      const { store, connection, issue, bind } = await setup();
      store.updateWorkspace("local", { settings: { scm_auto_link_enabled: false, scm_complete_issue_on_merge_enabled: true } });
      mockFetch(() => Response.json(pull));
      expect((await bind({ url: pull.html_url })).status).toBe(200);
      const merged = { ...pull, state: "closed", merged: true, merged_at: "2026-11-17T00:00:00Z", updated_at: "2026-11-17T00:00:00Z" };
      const adapter = new GitHubScmProviderAdapter();
      adapter.poll = async context => ({
        observations: context.stream === "change_requests" ? [githubPullObservation(merged, new Date())] : [],
        cursor: null, watermark: null, done: true,
      });
      expect(store.getScmSyncCursor(connection.id, "repo_widgets", "change_requests")).toBeNull();
      const result = await new ScmPollingScheduler({ store: scmIngestionStore(store), adapters: [adapter] }).runOnce();
      expect(result.failed).toBe(0);
      expect(result.eventsCreated).toBe(1);
      expect(store.listIssueActivity(issue.id).filter(event => event.type === "scm_merge_completed")).toHaveLength(1);
      expect(store.getIssue(issue.id)?.status).toBe("todo");
    });

    it.each([true, false, undefined])("poll baseline and later updates preserve zero links with old setting %s", async setting => {
      const { store, issue, count } = await setup();
      store.updateWorkspace("local", { settings: { scm_auto_link_enabled: setting } });
      const adapter = new GitHubScmProviderAdapter();
      let observation = githubPullObservation({ ...pull, title: issue.key, body: `Fixes ${issue.key}`, head: { ...pull.head, ref: issue.key } }, new Date());
      adapter.poll = async context => ({ observations: context.stream === "change_requests" ? [observation] : [], cursor: null, watermark: null, done: true });
      const scheduler = new ScmPollingScheduler({ store: scmIngestionStore(store), adapters: [adapter] });
      expect((await scheduler.runOnce()).failed).toBe(0);
      expect(count("change_requests")).toBe(1);
      observation = githubPullObservation({ ...pull, title: `Updated ${issue.key}`, updated_at: "2026-11-18T00:00:00Z" }, new Date());
      expect((await scheduler.runOnce(new Date(Date.now() + 86400000))).failed).toBe(0);
      expect(count("issue_links")).toBe(0);
    });

    it("matches mixed-case GitHub repository coordinates", async () => {
      const { store, connection, bind } = await setup();
      const binding = store.getScmRepositoryBinding(connection.id, "repo_widgets")!;
      store.upsertScmRepositoryBinding({ ...binding, owner: "Acme", name: "Widgets" });
      mockFetch(() => Response.json({ ...pull, base: { ...pull.base, repo: { full_name: "Acme/Widgets" } } }));
      expect((await bind({ url: "https://github.com/Acme/Widgets/pull/42" })).status).toBe(200);
    });

    it("binds an existing projection without decrypting credentials", async () => {
      const { store, bind, snapshot } = await setup();
      store.advanceScmEntitySnapshot(snapshot());
      delete process.env.MULTIREMI_SCM_ENCRYPTION_KEY;
      mockFetch(() => { throw new Error("Must not fetch"); });
      expect((await bind({ url: pull.html_url })).status).toBe(200);
    });

    it("ignores operational verification updates during lookup", async () => {
      const { store, connection, bind } = await setup();
      mockFetch(() => {
        store.markScmConnectionVerificationStarted(connection.id);
        return Response.json(pull);
      });
      expect((await bind({ url: pull.html_url })).status).toBe(200);
    });

    it.each([
      { setting: false, field: "title" }, { setting: false, field: "branch" }, { setting: false, field: "body" },
      { setting: true, field: "title" }, { setting: true, field: "branch" }, { setting: true, field: "body" },
      { setting: undefined, field: "title" }, { setting: undefined, field: "branch" }, { setting: undefined, field: "body" },
    ])("explicitly binds only the requested Issue with autoLink=$setting and Key in $field", async ({ setting, field }) => {
      const { store, issue, bind, count } = await setup();
      const other = createResponsibleTestIssue(store, { title: "Referenced", workspaceId: "local" });
      store.updateWorkspace("local", { settings: { scm_auto_link_enabled: setting } });
      expect(store.getWorkspace("local")!.settings.scm_auto_link_enabled).toBe(setting);
      mockFetch(() => Response.json({
        ...pull,
        ...(field === "title" ? { title: `${other.key} referenced` } : {}),
        ...(field === "branch" ? { head: { ...pull.head, ref: `${other.key}/feature` } } : {}),
        ...(field === "body" ? { body: `Closes ${other.key}` } : {}),
      }));
      expect((await bind({ url: pull.html_url })).status).toBe(200);
      expect(store.listScmChangeRequestsForIssue(other.id)).toHaveLength(0);
      expect(store.listScmChangeRequestsForIssue(issue.id)).toHaveLength(1);
      expect(count("issue_links")).toBe(1);
    });

    it("preserves a merge observed during an in-flight bind after another Issue initializes the entity", async () => {
      const { store, connection, bind, snapshot, count } = await setup();
      const other = createResponsibleTestIssue(store, { title: "Prior owner", workspaceId: "local" });
      store.updateWorkspace("local", { settings: { scm_complete_issue_on_merge_enabled: true } });
      mockFetch(() => {
        store.advanceScmEntitySnapshot(snapshot());
        const projection = store.prepareScmChangeRequestBinding(other.workspaceId, other.id, connection.id, "repo_widgets", 42).changeRequest!;
        store.linkScmChangeRequestToIssue(other.id, projection.id);
        return Response.json({ ...pull, state: "closed", merged: true, merged_at: "2026-11-17T00:00:00Z", updated_at: "2026-11-17T00:00:00Z" });
      });
      expect((await bind({ url: pull.html_url })).status).toBe(200);
      expect(count("events")).toBe(1);
      expect(store.listIssueActivity(other.id).filter(event => event.type === "scm_merge_completed")).toHaveLength(1);
      expect((await bind({ url: pull.html_url })).status).toBe(200);
      expect(count("events")).toBe(1);
    });

    it("keeps equal numbers in separate repositories isolated", async () => {
      const { store, connection, issue, bind, count } = await setup();
      store.updateWorkspace("local", { repos: [
        { id: "repo_widgets", name: "widgets", url: "https://github.com/acme/widgets.git" },
        { id: "repo_other", name: "other", url: "https://github.com/acme/other.git" },
      ] });
      store.upsertScmRepositoryBinding({ workspaceId: "local", connectionId: connection.id, repositoryId: "repo_other", name: "other", owner: "acme", repositoryUrl: "https://github.com/acme/other.git" });
      mockFetch(url => Response.json(url.includes("/other/") ? { ...pull, id: 9002, html_url: "https://github.com/acme/other/pull/42", base: { ...pull.base, repo: { full_name: "acme/other" } } } : pull));
      expect((await bind({ repository: "repo_widgets", number: 42 })).status).toBe(200);
      expect((await bind({ repository: "repo_other", number: 42 })).status).toBe(200);
      expect(count("change_requests")).toBe(2);
      expect(new Set(store.listScmChangeRequestsForIssue(issue.id)?.map(item => item.repositoryId))).toEqual(new Set(["repo_widgets", "repo_other"]));
    });

    it("reuses a legacy projection ID and tombstone, then polling hydrates it in place", async () => {
      const { store, db, connection, issue, bind, snapshot, count } = await setup();
      store.advanceScmEntitySnapshot({ ...snapshot(), externalId: "legacy-number:42" });
      const row = db.query("SELECT id FROM multiremi_scm_change_requests").get() as { id: string };
      store.linkScmChangeRequestToIssue(issue.id, row.id);
      store.unlinkScmChangeRequestFromIssue(issue.id, row.id);
      mockFetch(() => { throw new Error("Existing projection must not fetch"); });
      const response = await bind({ repository: "repo_widgets", number: 42 });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ changeRequest: { id: row.id }, link: { source: "manual", active: true } });
      store.advanceScmEntitySnapshot(snapshot());
      expect(store.getScmChangeRequest(row.id)?.externalId).toBe("9001");
      expect(count("change_requests")).toBe(1);
      expect(store.listScmChangeRequestsForIssue(issue.id)?.[0]?.id).toBe(row.id);
      expect(store.getScmEntitySnapshot(connection.id, "repo_widgets", "change_request", "9001")).not.toBeNull();
    });

    it("serializes concurrent binds and preserves a newer poll snapshot", async () => {
      const { store, issue, bind, snapshot, count } = await setup();
      let release!: () => void;
      let started!: () => void;
      const began = new Promise<void>(resolve => { started = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      mockFetch(async () => { started(); await gate; return Response.json(pull); });
      const first = bind({ url: pull.html_url });
      const second = bind({ repository: "repo_widgets", number: 42 });
      await began;
      store.advanceScmEntitySnapshot(snapshot({ ...pull, title: "Newer title", state: "closed", updated_at: "2026-11-17T00:00:00Z" }));
      release();
      for (const response of await Promise.all([first, second])) {
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ changeRequest: { title: "Newer title", state: "closed" }, link: { active: true, source: "manual" } });
      }
      expect(count("change_requests")).toBe(1);
      expect(count("issue_links")).toBe(1);
      expect(store.listScmChangeRequestsForIssue(issue.id)).toHaveLength(1);
    });

    it.each(["disable", "credential", "delete", "transfer"])("rejects configuration %s during provider access without partial writes", async change => {
      const { store, connection, bind, count } = await setup();
      mockFetch(() => {
        if (change === "disable") store.updateScmConnection(connection.id, { enabled: false });
        if (change === "credential") store.updateScmConnection(connection.id, { accessToken: "rotated-secret" });
        if (change === "delete") store.deleteScmRepositoryBinding(connection.id, "repo_widgets");
        if (change === "transfer") {
          const next = store.createScmConnection({ id: "scm_next", workspaceId: "local", name: "Replacement", provider: "github", accessToken: "next-secret", repositoryIds: [] });
          const binding = store.getScmRepositoryBinding(connection.id, "repo_widgets")!;
          store.upsertScmRepositoryBinding({ ...binding, connectionId: next.id, transfer: true });
        }
        return Response.json(pull);
      });
      const response = await bind({ url: pull.html_url });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "scm_binding_conflict" });
      expect(count("entity_snapshots")).toBe(0);
      expect(count("change_requests")).toBe(0);
      expect(count("issue_links")).toBe(0);
    });

    it("rolls back the imported snapshot and projection when link insertion fails, and emits nothing", async () => {
      const { store, db, issue, bind, count } = await setup();
      const events: unknown[] = [];
      store.onWorkspaceEvent(event => { if (event.type === "change_request:updated") events.push(event); });
      // Fail the real link INSERT after the snapshot and projection writes.
      if (backend === "sqlite") db.exec("CREATE TRIGGER reject_bind_link BEFORE INSERT ON multiremi_scm_issue_links BEGIN SELECT RAISE(ABORT, 'injected link failure'); END");
      else {
        db.exec("CREATE FUNCTION reject_bind_link_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected link failure'; END $$");
        db.exec("CREATE TRIGGER reject_bind_link BEFORE INSERT ON multiremi_scm_issue_links FOR EACH ROW EXECUTE FUNCTION reject_bind_link_fn()");
      }
      mockFetch(() => Response.json(pull));
      expect((await bind({ url: pull.html_url })).status).not.toBe(200);
      expect(count("entity_snapshots")).toBe(0);
      expect(count("change_requests")).toBe(0);
      expect(count("issue_links")).toBe(0);
      expect(events).toHaveLength(0);
      db.exec("DROP TRIGGER reject_bind_link" + (backend === "postgres" ? " ON multiremi_scm_issue_links" : ""));
      expect((await bind({ url: pull.html_url })).status).toBe(200);
    });

    it.each(["body", "provider"])("rejects an Issue moved during %s processing", async phase => {
      const { store, app, bind, issue, connection, count } = await setup();
      const destination = store.createWorkspace({ name: "Destination", slug: "destination" });
      const member = store.createWorkspaceMember({ name: "Destination owner", workspaceId: destination.id });
      const move = () => store.updateIssue(issue.id, {
        workspaceId: destination.id, responsibleMemberId: member.id, actorType: "member", actorId: member.id,
      });
      const credentials = spyOn(ScmRepo.prototype, "getConnectionCredential");
      const updates: unknown[] = [];
      store.onWorkspaceEvent(event => { if (event.type === "change_request:updated") updates.push(event); });
      let reads = 0;
      mockFetch(() => { reads++; if (phase === "provider") move(); return Response.json(pull); });
      try {
        let response: Response;
        if (phase === "body") {
          const request = new Request(`http://localhost/api/issues/${issue.id}/change-requests/by-reference`, {
            method: "PUT", headers, body: JSON.stringify({ url: pull.html_url }),
          });
          const text = request.text.bind(request);
          request.text = async () => { move(); return text(); };
          response = await app.request(request);
        } else {
          response = await bind({ url: pull.html_url });
        }
        expect(store.getIssue(issue.id)?.workspaceId).toBe(destination.id);
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: "scm_binding_conflict" });
        expect(credentials.mock.calls).toEqual(phase === "body" ? [] : [[connection.id]]);
        expect(reads).toBe(phase === "body" ? 0 : 1);
        for (const table of ["change_requests", "issue_links", "events", "effects"]) expect(count(table)).toBe(0);
        expect(updates).toEqual([]);
      } finally { credentials.mockRestore(); }
    });

    it("allows same-workspace Task binding but denies cross-workspace and daemon access before fetching", async () => {
      const { store, issue, bind, count } = await setup();
      const agent = store.createAgent({ name: "Binding task", provider: "codex", workspaceId: "local" });
      const task = store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId: "local", prompt: "Bind" });
      const token = await store.createTaskAccessToken(task, "local");
      const other = store.createWorkspace({ name: "Other", slug: "binding-other" });
      const foreignIssue = createResponsibleTestIssue(store, { title: "Private", workspaceId: other.id });
      const daemon = await store.createAccessToken({ name: "Daemon", type: "daemon", workspaceId: "local", daemonId: "dmn_bind" });
      let calls = 0;
      mockFetch(() => { calls++; return Response.json(pull); });
      const taskHeaders = { ...headers, Authorization: `Bearer ${token.token}` };
      expect((await bind({ url: pull.html_url }, taskHeaders, foreignIssue.id)).status).toBe(404);
      expect((await bind({ url: pull.html_url }, { ...headers, Authorization: `Bearer ${daemon.token}` })).status).toBe(403);
      expect(calls).toBe(0);
      expect((await bind({ url: pull.html_url }, taskHeaders)).status).toBe(200);
      expect(calls).toBe(1);
      expect(count("issue_links")).toBe(1);
    });

    it("rejects ambiguous owner/name while resolving a host-qualified URL", async () => {
      const { store, bind } = await setup();
      process.env.MULTIREMI_SCM_ALLOWED_API_HOSTS = "github.enterprise.example";
      store.updateWorkspace("local", { repos: [
        { id: "repo_widgets", name: "widgets", url: "https://github.com/acme/widgets.git" },
        { id: "repo_enterprise", name: "widgets", url: "https://github.enterprise.example/acme/widgets.git" },
      ] });
      store.createScmConnection({ id: "scm_enterprise", workspaceId: "local", name: "Enterprise", provider: "github", baseUrl: "https://github.enterprise.example", accessToken: "enterprise-secret", repositoryIds: ["repo_enterprise"] });
      let calls = 0;
      mockFetch(() => { calls++; return Response.json(pull); });
      const ambiguous = await bind({ repository: "acme/widgets", number: 42 });
      expect(ambiguous.status).toBe(409);
      expect(await ambiguous.json()).toMatchObject({ code: "scm_reference_ambiguous" });
      expect(calls).toBe(0);
      expect((await bind({ url: pull.html_url })).status).toBe(200);
    });

    it("imports and binds a Codebase MR through the configured adapter using local fixtures", async () => {
      const { store, issue, bind, count } = await setup();
      process.env.MULTIREMI_SCM_ALLOWED_API_HOSTS = "code.example";
      store.updateWorkspace("local", { repos: [
        { id: "repo_widgets", name: "widgets", url: "https://github.com/acme/widgets.git" },
        { id: "repo_codebase", name: "widgets", url: "https://code.example/acme/widgets.git", source: "codebase" },
      ] });
      const connection = store.createScmConnection({ id: "scm_codebase", workspaceId: "local", name: "Codebase fixture", provider: "codebase", baseUrl: "https://code.example", apiBaseUrl: "https://code.example/api", accessToken: "fixture-token", repositoryIds: ["repo_codebase"] });
      const binding = store.getScmRepositoryBinding(connection.id, "repo_codebase")!;
      store.upsertScmRepositoryBinding({ ...binding, externalId: "101" });
      mockFetch((url, init) => {
        expect(new URL(url).searchParams.get("Action")).toBe("ListRepoMergeRequests");
        expect(JSON.parse(String(init?.body)).TargetRepoId).toBe("101");
        return Response.json({ Result: { TotalCount: 1, MergeRequests: [{ Id: "mr_9001", Number: 42, Title: "Clean MR", Status: "open", URL: "https://code.example/acme/widgets/merge_requests/42", UpdatedAt: "2026-11-16T00:00:00Z" }] } });
      });
      const response = await bind({ url: "https://code.example/acme/widgets/merge_requests/42" });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ changeRequest: { externalId: "mr_9001", provider: "codebase", title: "Clean MR" }, link: { issueId: issue.id, source: "manual", active: true } });
      expect(count("events")).toBe(0);
    });

    it("fails closed for disabled, missing and foreign repositories", async () => {
      const { store, connection, bind, count } = await setup();
      mockFetch(() => { throw new Error("Must not fetch"); });
      expect((await bind({ repository: "repo_missing", number: 42 })).status).toBe(404);
      expect((await bind({ url: "https://elsewhere.example/acme/widgets/pull/42" })).status).toBe(404);
      store.updateScmConnection(connection.id, { enabled: false });
      expect((await bind({ repository: "repo_widgets", number: 42 })).status).toBe(409);
      store.updateScmConnection(connection.id, { enabled: true });
      const binding = store.getScmRepositoryBinding(connection.id, "repo_widgets")!;
      store.upsertScmRepositoryBinding({ ...binding, enabled: false });
      expect((await bind({ url: pull.html_url })).status).toBe(404);
      expect(count("change_requests")).toBe(0);
    });

    it.each([401, 403, 404, 429, 500, "timeout", "mismatch", "incomplete"])("reports provider failure %s without data or secrets", async failure => {
      const { bind, count } = await setup();
      mockFetch(() => {
        if (failure === "timeout") throw new DOMException("connection-secret", "TimeoutError");
        if (failure === "mismatch") return Response.json({ ...pull, number: 43 });
        if (failure === "incomplete") return Response.json({ ...pull, head: { ref: "feature" } });
        return Response.json({ message: "connection-secret" }, { status: Number(failure) });
      });
      const response = await bind({ url: pull.html_url });
      expect(response.status).toBe(failure === "timeout" ? 504 : failure === "mismatch" ? 502 : failure === 404 ? 404 : [401, 403].includes(Number(failure)) ? 403 : 502);
      expect(await response.text()).not.toContain("connection-secret");
      expect(count("entity_snapshots")).toBe(0);
      expect(count("change_requests")).toBe(0);
      expect(count("issue_links")).toBe(0);
    });
  });
}

async function appList(store: MigratedStore["store"], issueId: string) {
  return (await (await createMultiremiApp({ store, authToken: "dashboard-secret" }).request(`/api/issues/${issueId}/change-requests`, { headers })).json());
}

describe("SCM URL and provider reference parsing", () => {
  it.each([
    "https://user:secret@github.com/acme/widgets/pull/42", "https://@github.com/acme/widgets/pull/42",
    "http://github.com/acme/widgets/pull/42", " https://github.com/acme/widgets/pull/42",
    "https://github.com/acme/widgets/pull/42?token=secret", "https://github.com/acme/widgets/pull/42#x",
    "https://github.com/acme/widgets/pull/0", "https://github.com/acme/widgets/pull/01",
    "https://github.com/acme/widgets/pull/9007199254740992", "https://github.com/acme/widgets/pull/42/files",
    "https://github.com/acme/../widgets/pull/42", "https://github.com/acme%2fother/widgets/pull/42",
    "https://github.com/acme/widgets/pull/42/", "https://github.com\\@other/acme/widgets/pull/42",
  ])("rejects untrusted URL form %s", value => { expect(() => parseChangeRequestUrl(value)).toThrow(); });

  it.each([{ url: pull.html_url, repository: "repo_widgets", number: 42 }, { repository: "repo_widgets", number: "42" }, { repository: "repo_widgets", number: -1 }, { url: pull.html_url, title: "forged" }, {}, null])("rejects invalid/extraneous reference input %j", value => { expect(() => parseChangeRequestReference(value)).toThrow(); });

  it("parses fixture-supported Codebase MR URLs and preserves non-default ports", () => {
    expect(parseChangeRequestUrl("https://code.example:8443/taoze/personal_automation/merge_requests/45")).toEqual({ repository: "https://code.example:8443/taoze/personal_automation", number: 45, provider: "codebase" });
  });

  it.each([
    { code: "AccessDenied", expected: "scm_provider_forbidden", status: 403 },
    { code: "Throttling", expected: "scm_rate_limited", status: 502 },
    { code: "ResourceNotFound", expected: "scm_change_request_not_found", status: 404 },
    { code: "InternalError", expected: "scm_provider_error", status: 502 },
  ])("classifies Codebase envelope errors without exposing messages: $code", async ({ code, expected, status }) => {
    mockFetch(() => Response.json({ ResponseMetadata: { Error: { Code: code, Message: "fixture-token" } } }));
    const context = { connection: scmConnection({ provider: "codebase", apiBaseUrl: "https://code.example/api" }), binding: scmBinding(), credential: { accessToken: "fixture-token", webhookSecret: null } };
    await expect(readChangeRequest(context, 42)).rejects.toMatchObject({ code: expected, status });
    try { await readChangeRequest(context, 42); } catch (error) { expect(String(error)).not.toContain("fixture-token"); }
  });

  it("uses bounded Codebase ListRepoMergeRequests without a watermark or persisted ingestion state", async () => {
    let calls = 0;
    mockFetch((url, init) => {
      expect(new URL(url).searchParams.get("Action")).toBe("ListRepoMergeRequests");
      const body = JSON.parse(String(init?.body));
      expect(body.TargetRepoId).toBe("101");
      expect(body.PageNumber).toBe(++calls);
      expect(body.Since).toBeUndefined();
      return Response.json({ Result: { TotalCount: 201, MergeRequests: calls === 2 ? [{ Id: "mr_9001", Number: 42, Title: "Clean MR", Status: "open", UpdatedAt: "2020-01-01T00:00:00Z" }] : [] } });
    });
    const context = { connection: scmConnection({ provider: "codebase", apiBaseUrl: "https://code.example/api" }), binding: scmBinding(), credential: { accessToken: "fixture-token", webhookSecret: null } };
    expect(await readChangeRequest(context, 42)).toMatchObject({ externalId: "mr_9001", payload: { number: 42, title: "Clean MR" } });
    expect(calls).toBe(2);
    calls = 0;
    mockFetch(() => { calls++; return Response.json({ Result: { TotalCount: 5000, MergeRequests: [] } }); });
    await expect(readChangeRequest(context, 42)).rejects.toMatchObject({ code: "scm_pagination_limit" });
    expect(calls).toBe(20);
    mockFetch(() => Response.json({ Result: { TotalCount: 0, MergeRequests: [] } }));
    await expect(readChangeRequest(context, 42)).rejects.toMatchObject({ code: "scm_change_request_not_found" });
  });
});
