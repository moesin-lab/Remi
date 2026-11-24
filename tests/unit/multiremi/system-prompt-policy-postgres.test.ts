import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";
import { SCHEMA_MIGRATIONS } from "@multiremi/store/schema-migrations.js";
import { runSchemaExpands } from "@multiremi/store/schema-migration-runner.js";
import { readSchemaLevels } from "@multiremi/store/schema-levels.js";
import type { SystemPromptWriteResult } from "@multiremi/contracts/system-prompt-policy.js";
import type { SystemPromptPgJob } from "../../fixtures/system-prompt-pg-worker.js";

// No implicit service, Docker, or remote database fallback. An explicit bad URL fails setup.
const adminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
const databaseName = `mul3_system_prompt_${process.pid}_${crypto.randomUUID().replaceAll("-", "")}`;
const workerPath = fileURLToPath(new URL("../../fixtures/system-prompt-pg-worker.ts", import.meta.url));
type WorkerResult = { participant: string; status: number;
  body: Partial<SystemPromptWriteResult> & { code?: string; currentRevision?: number } };

describe.skipIf(!adminUrl)("System Prompt atomicity on real PostgreSQL (requires MULTIREMI_TEST_POSTGRES_URL)", () => {
  let admin: Bun.SQL;
  let db: PostgresSyncDatabase;
  let store: MultiremiStore;
  let databaseUrl: string;
  let created = false;

  beforeAll(async () => {
    if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(adminUrl!).hostname)) throw new Error("Requires local PostgreSQL");
    admin = new Bun.SQL(adminUrl!, { max: 1 });
    await admin.unsafe(`CREATE DATABASE ${databaseName}`);
    created = true;
    const target = new URL(adminUrl!);
    target.pathname = `/${databaseName}`;
    databaseUrl = target.toString();
    db = new PostgresSyncDatabase(databaseUrl);
    store = new MultiremiStore(db);
    store.ensureLocalWorkspace();
    db.exec("CREATE TABLE system_prompt_test_barrier (batch TEXT NOT NULL, participant TEXT NOT NULL, PRIMARY KEY(batch,participant))");
    expect(readSchemaLevels(db)).toEqual({ expandLevel: 4, contractLevel: 0 });
  }, 60_000);

  afterAll(async () => {
    db?.close();
    try { if (created) await admin.unsafe(`DROP DATABASE ${databaseName} WITH (FORCE)`); }
    finally { await admin?.close(); }
  });

  async function race(workspaceId: string, writers: [{ requestId: string; common: string }, { requestId: string; common: string }]): Promise<WorkerResult[]> {
    const batch = crypto.randomUUID();
    const children = writers.map((writer, index) => {
      const job: SystemPromptPgJob = { workspaceId, batch, participant: String(index), expectedRevision: 0, ...writer };
      return Bun.spawn([process.execPath, workerPath], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
        env: { ...process.env, SYSTEM_PROMPT_TEST_URL: databaseUrl, SYSTEM_PROMPT_TEST_JOB: JSON.stringify(job), MULTIREMI_TEST_LOCK_ORDER_SENTINEL: "1" } });
    });
    const deadline = setTimeout(() => { for (const child of children) if (child.exitCode === null) child.kill(); }, 40_000);
    try {
      return await Promise.all(children.map(async child => {
        const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
        const line = stdout.split("\n").find(line => line.startsWith("SYSTEM_PROMPT_TEST_RESULT:"));
        expect(line).toBeDefined();
        return JSON.parse(line!.slice("SYSTEM_PROMPT_TEST_RESULT:".length)) as WorkerResult;
      }));
    } finally {
      clearTimeout(deadline);
      for (const child of children) if (child.exitCode === null) child.kill();
    }
  }

  function assertCoherentFirstEdit(workspaceId: string) {
    const state = store.getSystemPrompt(workspaceId);
    const versions = store.listSystemPromptVersions(workspaceId).versions;
    expect(state.document.revision).toBe(2);
    expect(versions.map(version => [version.versionNumber, version.operation, version.isCurrent])).toEqual([[2, "edit", true], [1, "initialize", false]]);
    expect(state.document.currentVersionId).toBe(versions[0]!.id);
    expect(versions[0]!.parentVersionId).toBe(versions[1]!.id);
    expect(versions.every(version => version.documentId === state.document.id)).toBe(true);
    const orphans = db.query(`SELECT count(*) AS n FROM multiremi_system_prompt_versions v
      LEFT JOIN multiremi_system_prompt_documents d ON d.id=v.document_id AND d.workspace_id=v.workspace_id
      WHERE v.workspace_id=? AND d.id IS NULL`).get(workspaceId) as { n: string | number };
    expect(Number(orphans.n)).toBe(0);
    const documents = db.query("SELECT count(*) AS n FROM multiremi_system_prompt_documents WHERE workspace_id=?").get(workspaceId) as { n: string | number };
    expect(Number(documents.n)).toBe(1);
  }

  it("rolls failed level-4 DDL back, then applies exactly once on retry", async () => {
    const migrationName = `${databaseName}_ddl`;
    let migrationDb: PostgresSyncDatabase | undefined;
    await admin.unsafe(`CREATE DATABASE ${migrationName}`);
    try {
      const target = new URL(adminUrl!);
      target.pathname = `/${migrationName}`;
      migrationDb = new PostgresSyncDatabase(target.toString());
      const step = SCHEMA_MIGRATIONS.find(step => step.level === 4)!;
      const compatibility = { minLevel: 4, maxLevel: 4 };
      expect(() => runSchemaExpands(migrationDb!, [{ ...step, run: database => { step.run(database); throw new Error("injected expand failure"); } }], step.release, compatibility)).toThrow("injected expand failure");
      expect(readSchemaLevels(migrationDb).expandLevel).toBe(0);
      expect(migrationDb.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='multiremi_system_prompt_versions'").get()).toBeNull();
      expect(migrationDb.query("SELECT id FROM multiremi_schema_steps WHERE id=?").get(step.id)).toBeNull();
      runSchemaExpands(migrationDb, [step], step.release, compatibility);
      runSchemaExpands(migrationDb, [step], step.release, compatibility);
      expect(readSchemaLevels(migrationDb)).toEqual({ expandLevel: 4, contractLevel: 0 });
      expect(Number((migrationDb.query("SELECT count(*) AS n FROM multiremi_schema_steps WHERE id=?").get(step.id) as { n: string | number }).n)).toBe(1);
      for (const name of ["multiremi_system_prompt_documents", "multiremi_system_prompt_versions", "multiremi_attempt_system_prompts"]) {
        expect(migrationDb.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name=?").get(name)).not.toBeNull();
      }
    } finally {
      migrationDb?.close();
      await admin.unsafe(`DROP DATABASE ${migrationName} WITH (FORCE)`);
    }
  }, 60_000);

  it("serializes simultaneous first edits from two independent HTTP clients/processes", async () => {
    const workspace = store.createWorkspace({ name: "PG first edit CAS" });
    const results = await race(workspace.id, [{ requestId: "left", common: "left writer" }, { requestId: "right", common: "right writer" }]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    const winner = results.find(result => result.status === 200)!;
    const loser = results.find(result => result.status === 409)!;
    expect(loser.body).toMatchObject({ code: "system_prompt_conflict", currentRevision: 2 });
    expect(store.getSystemPrompt(workspace.id).content.common).toBe(winner.body.content!.common);
    assertCoherentFirstEdit(workspace.id);
  }, 60_000);

  it("replays a simultaneous identical request before the now-stale CAS without appending versions", async () => {
    const workspace = store.createWorkspace({ name: "PG idempotency replay" });
    const request = { requestId: "same-request", common: "same canonical payload" };
    const results = await race(workspace.id, [request, request]);
    expect(results.map(result => result.status)).toEqual([200, 200]);
    expect(results.map(result => result.body.replayed).sort()).toEqual([false, true]);
    expect(results[0]!.body.version!.id).toBe(results[1]!.body.version!.id);
    const requests = db.query("SELECT count(*) AS n FROM multiremi_system_prompt_versions WHERE workspace_id=? AND request_id=?").get(workspace.id, request.requestId) as { n: string | number };
    expect(Number(requests.n)).toBe(1);
    assertCoherentFirstEdit(workspace.id);
  }, 60_000);

  it("rejects simultaneous request ID reuse with different payloads and leaves no losing version", async () => {
    const workspace = store.createWorkspace({ name: "PG request conflict" });
    const results = await race(workspace.id, [{ requestId: "same-key", common: "left" }, { requestId: "same-key", common: "right" }]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    expect(results.find(result => result.status === 409)!.body).toMatchObject({ code: "system_prompt_request_conflict", currentRevision: 2 });
    assertCoherentFirstEdit(workspace.id);
  }, 60_000);
});
