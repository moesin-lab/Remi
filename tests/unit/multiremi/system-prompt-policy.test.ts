import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultiremiStore } from "@multiremi/store.js";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import type { StoreContext } from "@multiremi/store/context.js";
import { SystemPromptsRepo } from "@multiremi/store/repos/system-prompts-repo.js";
import { SCHEMA_MIGRATIONS } from "@multiremi/store/schema-migrations.js";
import { runSchemaExpands } from "@multiremi/store/schema-migration-runner.js";
import { readSchemaLevels } from "@multiremi/store/schema-levels.js";
import { DEFAULT_SYSTEM_PROMPT_CONTENT, type SystemPromptActor } from "@multiremi/contracts/system-prompt-policy.js";
import { CURRENT_SYSTEM_PROMPT_DEFAULT, hashSystemPromptContent } from "@shared/system-prompt-policy-hash.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

const actor: SystemPromptActor = { type: "human", operatorId: "local", userId: "real-user", displayName: "Real user" };
const content = (common: string) => ({ ...DEFAULT_SYSTEM_PROMPT_CONTENT, common });
const ctx = (store: MultiremiStore) => (store as unknown as { ctx: StoreContext }).ctx;
const MASTER = { Authorization: "Bearer MASTER", "content-type": "application/json" };
afterEach(resetMultiremiTestEnv);

describe("System Prompt version domain", () => {
  it("reads a virtual default without writes and leaves the old appendix independent", () => {
    const store = createLocalStore();
    store.updateWorkspace("local", { settings: { prompt_appendix: "Existing appendix" } });
    const state = store.getSystemPrompt("local");
    expect(state.document).toMatchObject({ id: null, revision: 0, mode: "default", currentVersionId: null });
    expect(state.content).toEqual(DEFAULT_SYSTEM_PROMPT_CONTENT);
    expect(store.listSystemPromptVersions("local")).toEqual({ versions: [], nextCursor: null });
    expect(db!.query("SELECT count(*) AS n FROM multiremi_system_prompt_documents").get()).toEqual({ n: 0 });
    const edit = store.editSystemPrompt("local", { content: content("中文\r\ncustom"), expectedRevision: 0, requestId: "first" }, actor);
    expect(edit.document.revision).toBe(2);
    expect(edit.version).toMatchObject({ versionNumber: 2, operation: "edit", mode: "custom", content: content("中文\ncustom"), actor });
    const versions = store.listSystemPromptVersions("local").versions;
    expect(versions.map(v => [v.versionNumber, v.operation, v.isCurrent])).toEqual([[2, "edit", true], [1, "initialize", false]]);
    expect(versions[1]!.actor.type).toBe("system");
    expect(versions[0]).not.toHaveProperty("content");
    expect(store.getWorkspace("local")!.settings!.prompt_appendix).toBe("Existing appendix");
  });

  it("records every reset and copies any historical snapshot as a new custom rollback", () => {
    const store = createLocalStore();
    const edit = store.editSystemPrompt("local", { content: content("keep me"), expectedRevision: 0, requestId: "edit" }, actor);
    const reset = store.resetSystemPrompt("local", { expectedRevision: 2, requestId: "reset" }, actor);
    expect(reset.document).toMatchObject({ revision: 3, mode: "default" });
    expect(reset.version.content).toEqual(DEFAULT_SYSTEM_PROMPT_CONTENT);
    const restored = store.restoreSystemPrompt("local", { expectedRevision: 3, requestId: "restore", versionId: edit.version.id }, actor);
    expect(restored).toMatchObject({ content: content("keep me"), document: { revision: 4, mode: "custom" },
      version: { operation: "rollback", restoredFromVersionId: edit.version.id, parentVersionId: reset.version.id } });
    const oldDefault = store.listSystemPromptVersions("local").versions.at(-1)!;
    const restoredDefault = store.restoreSystemPrompt("local", { expectedRevision: 4, requestId: "restore-default", versionId: oldDefault.id }, actor);
    expect(restoredDefault.document.mode).toBe("custom");
    expect(restoredDefault.content).toEqual(DEFAULT_SYSTEM_PROMPT_CONTENT);
    expect(store.getSystemPromptVersion("local", edit.version.id)!.content).toEqual(content("keep me"));
    expect(store.resetSystemPrompt("local", { expectedRevision: 5, requestId: "reset-again" }, actor).document.revision).toBe(6);
  });

  it("creates only reset v1 on the first reset, and empty custom slots stay custom", () => {
    const store = createLocalStore();
    expect(store.resetSystemPrompt("local", { expectedRevision: 0, requestId: "reset" }, actor).version).toMatchObject({ versionNumber: 1, operation: "reset" });
    const empty = Object.fromEntries(Object.keys(DEFAULT_SYSTEM_PROMPT_CONTENT).map(key => [key, ""])) as typeof DEFAULT_SYSTEM_PROMPT_CONTENT;
    const edited = store.editSystemPrompt("local", { expectedRevision: 1, requestId: "empty", content: empty }, actor);
    expect(edited.document.mode).toBe("custom");
    expect(edited.content).toEqual(empty);
  });

  it("replays before stale revision checks, rejects reused request IDs and stale writers atomically", () => {
    const store = createLocalStore();
    const input = { content: content("one\r\ntwo"), expectedRevision: 0, requestId: "retry" };
    const first = store.editSystemPrompt("local", input, actor);
    store.resetSystemPrompt("local", { expectedRevision: 2, requestId: "newer" }, actor);
    const replay = store.editSystemPrompt("local", { ...input, content: content("one\ntwo") }, actor);
    expect(replay.replayed).toBe(true);
    expect(replay.version.id).toBe(first.version.id);
    expect(replay.document.revision).toBe(3);
    expect(() => store.editSystemPrompt("local", { ...input, content: content("different") }, actor)).toThrow("requestId was already used");
    expect(() => store.editSystemPrompt("local", { ...input, requestId: "stale" }, actor)).toThrow("changed; reload");
    expect(store.listSystemPromptVersions("local").versions).toHaveLength(3);
  });

  it("rolls the new head, both initial versions, and events back with its caller transaction", () => {
    const store = createLocalStore();
    const events: string[] = [];
    store.onWorkspaceEvent(event => { if (event.type === "workspace:updated") events.push(event.type); });
    expect(() => ctx(store).db.transaction(() => {
      store.editSystemPrompt("local", { content: content("rollback"), expectedRevision: 0, requestId: "aborted" }, actor);
      expect(events).toHaveLength(0);
      throw new Error("abort outer");
    })()).toThrow("abort outer");
    expect(store.getSystemPrompt("local").document.revision).toBe(0);
    expect(store.listSystemPromptVersions("local").versions).toHaveLength(0);
    expect(events).toHaveLength(0);
    store.resetSystemPrompt("local", { expectedRevision: 0, requestId: "committed" }, actor);
    expect(events).toEqual(["workspace:updated"]);
  });

  it("follows catalog upgrades only in default mode and uses authoritative historical edit bases", () => {
    const store = createLocalStore();
    let catalog = CURRENT_SYSTEM_PROMPT_DEFAULT;
    const repo = new SystemPromptsRepo(ctx(store), () => catalog);
    const initialReset = repo.resetSystemPrompt("local", { expectedRevision: 0, requestId: "reset" }, actor);
    const oldRevision = catalog.revision;
    const nextContent = content("upgraded default");
    catalog = { revision: hashSystemPromptContent(nextContent), contentHash: hashSystemPromptContent(nextContent), content: nextContent };
    expect(repo.getSystemPrompt("local").content).toEqual(nextContent);
    expect(repo.getSystemPromptVersion("local", initialReset.version.id)!.content).toEqual(DEFAULT_SYSTEM_PROMPT_CONTENT);
    expect(repo.getSystemPrompt("local").defaultUpdated).toBe(true);
    const custom = repo.editSystemPrompt("local", { content: content("custom"), expectedRevision: 1, requestId: "custom", baseDefaultRevision: oldRevision }, actor);
    expect(custom.baseDefault).toMatchObject({ revision: oldRevision, content: DEFAULT_SYSTEM_PROMPT_CONTENT });
    expect(custom.defaultUpdated).toBe(true);
    expect(repo.getSystemPrompt("local").content).toEqual(content("custom"));
    expect(() => repo.editSystemPrompt("local", { content: content("bad base"), expectedRevision: 2, requestId: "bad", baseDefaultRevision: "forged" }, actor)).toThrow("not a known default");
    expect(repo.getSystemPrompt("local").document.revision).toBe(2);
    const restore = repo.restoreSystemPrompt("local", { expectedRevision: 2, requestId: "historical", versionId: initialReset.version.id }, actor);
    expect(restore.content).toEqual(DEFAULT_SYSTEM_PROMPT_CONTENT);
    expect(restore.document.mode).toBe("custom");
    expect(repo.resetSystemPrompt("local", { expectedRevision: 3, requestId: "latest" }, actor).content).toEqual(nextContent);
  });

  it("paginates metadata and scopes every history detail and restore to its workspace", () => {
    const store = createLocalStore();
    const ws = store.createWorkspace({ name: "Other" });
    const edit = store.editSystemPrompt("local", { content: content("private"), expectedRevision: 0, requestId: "one" }, actor);
    store.resetSystemPrompt("local", { expectedRevision: 2, requestId: "two" }, actor);
    const page = store.listSystemPromptVersions("local", { limit: 2 });
    expect(page.versions.map(v => v.versionNumber)).toEqual([3, 2]);
    expect(store.listSystemPromptVersions("local", { limit: 2, cursor: page.nextCursor! }).versions.map(v => v.versionNumber)).toEqual([1]);
    expect(store.getSystemPromptVersion(ws.id, edit.version.id)).toBeNull();
    expect(() => store.restoreSystemPrompt(ws.id, { expectedRevision: 0, requestId: "steal", versionId: edit.version.id }, actor)).toThrow("version not found");
    expect(() => store.listSystemPromptVersions("local", { cursor: "broken" })).toThrow("cursor");
    expect(() => store.listSystemPromptVersions("local", { limit: 101 })).toThrow("limit");
  });

  it("cleans the document, historical versions, and attempt bindings on workspace deletion", () => {
    const store = createLocalStore();
    const ws = store.createWorkspace({ name: "Disposable" });
    store.editSystemPrompt(ws.id, { content: content("delete"), expectedRevision: 0, requestId: "edit" }, actor);
    const agent = store.createAgent({ name: "Agent", provider: "codex", workspaceId: ws.id });
    const task = store.createTask({ agentId: agent.id, workspaceId: ws.id, prompt: "test" });
    ctx(store).db.transaction(() => { ctx(store).lockWorkspaceRuntimeLifecycle(ws.id); store.systemPromptsRepo().bindAttemptSystemPrompt(task.id, ws.id, { legacyCompatible: false }); })();
    expect(store.deleteWorkspace(ws.id)).toBe(true);
    for (const table of ["multiremi_system_prompt_documents", "multiremi_system_prompt_versions", "multiremi_attempt_system_prompts"]) {
      expect(db!.query(`SELECT count(*) AS n FROM ${table} WHERE workspace_id=?`).get(ws.id)).toEqual({ n: 0 });
    }
  });

  it("serializes two SQLite clients with the same expected revision without orphan versions", async () => {
    createLocalStore();
    const dir = mkdtempSync(join(tmpdir(), "system-prompt-cas-"));
    const file = join(dir, "db.sqlite");
    writeFileSync(file, db!.serialize());
    const leftDb = openSqliteDatabase(file), rightDb = openSqliteDatabase(file);
    try {
      const left = new MultiremiStore(leftDb), right = new MultiremiStore(rightDb);
      const results = await Promise.all([left, right].map(async (store, index) => {
        const app = createMultiremiApp({ store, authToken: "MASTER" });
        return app.request("/api/workspaces/local/system-prompt", { method: "PUT", headers: MASTER,
          body: JSON.stringify({ content: content(`writer ${index}`), expectedRevision: 0, requestId: `writer-${index}` }) });
      }));
      expect(results.map(r => r.status).sort()).toEqual([200, 409]);
      expect(right.getSystemPrompt("local").document.revision).toBe(2);
      expect(right.listSystemPromptVersions("local").versions).toHaveLength(2);
    } finally { leftDb.close(); rightDb.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("uses an atomic level-4 expand and retries after DDL failure", () => {
    const database = openSqliteDatabase(":memory:");
    const step = SCHEMA_MIGRATIONS.find(step => step.level === 4)!;
    const compatibility = { minLevel: 4, maxLevel: 4 };
    try {
      expect(() => runSchemaExpands(database, [{ ...step, run: db => { step.run(db); throw new Error("DDL failure"); } }], step.release, compatibility)).toThrow("DDL failure");
      expect(readSchemaLevels(database).expandLevel).toBe(0);
      expect(database.query("SELECT name FROM sqlite_master WHERE name='multiremi_system_prompt_versions'").get()).toBeNull();
      expect(database.query("SELECT id FROM multiremi_schema_steps WHERE id=?").get(step.id)).toBeNull();
      runSchemaExpands(database, [step], step.release, compatibility);
      expect(readSchemaLevels(database).expandLevel).toBe(4);
      runSchemaExpands(database, [step], step.release, compatibility);
      expect(database.query("SELECT count(*) AS n FROM multiremi_schema_steps WHERE id=?").get(step.id)).toEqual({ n: 1 });
    } finally { database.close(); }
  });
});

describe("System Prompt HTTP permissions and validation", () => {
  it("audits the authenticated human account and ignores client actor/current markers", async () => {
    const store = createLocalStore();
    const user = store.getOrCreateUser({ name: "Alice", email: "alice@example.test", externalId: "alice-open" });
    const token = await store.createAccessToken({ workspaceId: "local", type: "pat", userId: user.id, purpose: "session", name: "Alice" });
    const app = createMultiremiApp({ store, authToken: "MASTER" });
    const response = await app.request("/api/workspaces/local/system-prompt", { method: "PUT",
      headers: { Authorization: `Bearer ${token.token}`, "content-type": "application/json" },
      body: JSON.stringify({ content: content("human"), expectedRevision: 0, requestId: "human", actor: { userId: "forged" }, isCurrent: false }) });
    expect(response.status).toBe(200);
    expect((await response.json()).version.actor).toEqual({ type: "human", operatorId: "local", userId: user.id, displayName: "Alice" });
  });

  it("denies task/daemon writes, allows scoped task reads/preview and blocks cross-workspace history", async () => {
    const store = createLocalStore();
    const other = store.createWorkspace({ name: "Other" });
    const agent = store.createAgent({ name: "Worker", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, workspaceId: "local", prompt: "test" });
    const token = await store.createAccessToken({ workspaceId: "local", type: "task", name: "task", agentId: agent.id, taskId: task.id });
    const daemon = await store.createAccessToken({ workspaceId: "local", type: "daemon", name: "daemon", daemonId: "daemon-test" });
    const app = createMultiremiApp({ store, authToken: "MASTER" });
    for (const credential of [token, daemon]) {
      const headers = { Authorization: `Bearer ${credential.token}`, "content-type": "application/json" };
      for (const [method, suffix] of [["PUT", ""], ["POST", "/reset"], ["POST", "/restore"]]) {
        const response = await app.request(`/api/workspaces/local/system-prompt${suffix}`, { method, headers,
          body: JSON.stringify({ expectedRevision: 0, requestId: "forbidden", content: content("no"), versionId: "no" }) });
        expect(response.status).toBe(403);
      }
    }
    const headers = { Authorization: `Bearer ${token.token}`, "content-type": "application/json" };
    expect((await app.request("/api/workspaces/local/system-prompt", { headers })).status).toBe(200);
    expect((await app.request("/api/workspaces/local/system-prompt/preview", { method: "POST", headers, body: "{}" })).status).toBe(200);
    const version = store.resetSystemPrompt(other.id, { expectedRevision: 0, requestId: "other" }, actor).version;
    expect((await app.request(`/api/workspaces/${other.id}/system-prompt/versions/${version.id}`, { headers })).status).toBe(404);
    expect((await app.request(`/api/workspaces/local/system-prompt/versions/${version.id}`, { headers: MASTER })).status).toBe(404);
    expect(store.getSystemPrompt("local").document.revision).toBe(0);
  });

  it("rejects invalid payloads and returns conflict codes; preview remains read-only", async () => {
    const store = createLocalStore();
    const app = createMultiremiApp({ store, authToken: "MASTER" });
    const put = (body: unknown) => app.request("/api/workspaces/local/system-prompt", { method: "PUT", headers: MASTER, body: JSON.stringify(body) });
    for (const invalidContent of [null, {}, { ...content("ok"), unsupported: "no" }, content("😀".repeat(8001)), content("\0"), content("\ud800")]) {
      const response = await put({ content: invalidContent, expectedRevision: 0, requestId: "invalid" });
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe("invalid_system_prompt");
    }
    const preview = await app.request("/api/workspaces/local/system-prompt/preview", { method: "POST", headers: MASTER,
      body: JSON.stringify({ content: content("Preview literal <script> {{not_a_template}}") }) });
    expect(preview.status).toBe(200);
    const body = await preview.json();
    expect(body).toMatchObject({ excludesLocalContext: true, scenario: "feishu-issue-topic-codex-linux" });
    expect(body.instructions).toContain("Preview literal <script> {{not_a_template}}");
    expect(store.getSystemPrompt("local").document.revision).toBe(0);
    expect((await put({ content: content("one"), expectedRevision: 0, requestId: "save" })).status).toBe(200);
    const stale = await put({ content: content("stale"), expectedRevision: 0, requestId: "stale" });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "system_prompt_conflict", currentRevision: 2 });
    const reused = await put({ content: content("different"), expectedRevision: 0, requestId: "save" });
    expect(reused.status).toBe(409);
    expect((await reused.json()).code).toBe("system_prompt_request_conflict");
  });

  it("checks actual daemon-reported binding against the claim and projects its immutable metadata", () => {
    const store = createLocalStore();
    const agent = store.createAgent({ name: "Worker", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, workspaceId: "local", prompt: "test" });
    const binding = ctx(store).db.transaction(() => {
      ctx(store).lockWorkspaceRuntimeLifecycle("local");
      return store.systemPromptsRepo().bindAttemptSystemPrompt(task.id, "local", { legacyCompatible: false });
    })();
    const prompt = "actual turn input";
    const input = { mode: "bootstrap" as const, prompt, sha256: createHash("sha256").update(prompt).digest("hex"), instructions: "actual instructions" };
    expect(() => store.recordTaskPrompt(task.id, input)).toThrow("binding mismatch");
    expect(() => store.recordTaskPrompt(task.id, { ...input, systemPromptPolicy: { ...binding, versionNumber: 99 } })).toThrow("binding mismatch");
    expect(store.recordTaskPrompt(task.id, { ...input, systemPromptPolicy: binding }).systemPromptPolicy).toEqual(binding);
    const turn = store.getTurnForAttempt(task.id)!;
    expect(store.getTurnInput(turn.id).system_prompt_policy).toEqual(binding);
    store.editSystemPrompt("local", { content: content("later"), expectedRevision: 0, requestId: "later" }, actor);
    expect(store.getTaskPrompt(task.id)!.systemPromptPolicy).toEqual(binding);
  });
});
