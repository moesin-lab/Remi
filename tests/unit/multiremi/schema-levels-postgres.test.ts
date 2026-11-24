import { fileURLToPath } from "node:url";
import { MultiremiStore } from "@multiremi/store.js";
import { SCHEMA_MIGRATIONS } from "@multiremi/store/schema-migrations.js";
import type { SystemPromptWriteResult } from "@multiremi/contracts/system-prompt-policy.js";
import type { SystemPromptPgJob } from "../../fixtures/system-prompt-pg-worker.js";
import { verifyPlannedRestartSchemaUpgrade } from "../../fixtures/planned-restart-schema-upgrade.js";
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { PostgresSyncDatabase, advisoryLock } from '@multiremi/store/db/postgres.js';
import { MIGRATION_ADVISORY_LOCK_KEY } from '@multiremi/store/advisory-locks.js';
import { assertSchemaCompatible, readSchemaLevels } from '@multiremi/store/schema-levels.js';
import { runMigrations, runStartupMigrations } from '@multiremi/store/migrations.js';
import { assertSchemaContractClientsOffline } from '@multiremi/store/schema-contracts.js';
import { runSchemaExpands, runSchemaContracts, type SchemaMigration } from '@multiremi/store/schema-migration-runner.js';

const adminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
describe.skipIf(!adminUrl)('schema protocol on real PostgreSQL', () => {
  let admin: Bun.SQL, db: PostgresSyncDatabase, url: string;
  const name = `mul173_${process.pid}_${crypto.randomUUID().replaceAll('-', '')}`;
  let created = false;
  beforeAll(async () => {
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(adminUrl!).hostname)) throw new Error('Requires local PostgreSQL');
    admin = new Bun.SQL(adminUrl!, { max: 1 });
    await admin.unsafe(`CREATE DATABASE ${name}`); created = true;
    const target = new URL(adminUrl!); target.pathname = `/${name}`; url = target.toString();
    db = new PostgresSyncDatabase(url);
  });
  afterAll(async () => {
    db?.close();
    try { if (created) await admin.unsafe(`DROP DATABASE ${name}`); }
    finally { await admin?.close(); }
  });
  it('enrolls and reopens the production migration chain on PostgreSQL', () => {
    expect(readSchemaLevels(db)).toEqual({ expandLevel: 0, contractLevel: 0 });
    runMigrations(db); runMigrations(db);
    expect(readSchemaLevels(db)).toEqual({ expandLevel: 4, contractLevel: 0 });
  }, 30_000);
  it('adds A3 live terms to an enrolled level 1 database and preserves old reader compatibility', () => {
    db.exec('DROP TABLE multiremi_live_terms');
    db.exec('DELETE FROM multiremi_schema_steps WHERE level>=2');
    db.exec('UPDATE multiremi_schema_meta SET expand_level=1');
    runStartupMigrations(db);
    expect(readSchemaLevels(db)).toEqual({ expandLevel: 4, contractLevel: 0 });
    expect(db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='multiremi_live_terms'").get()).not.toBeNull();
    expect(() => assertSchemaCompatible(readSchemaLevels(db), { minLevel: 1, maxLevel: 1 })).not.toThrow();
    console.info('A3 startup expand: level 1 -> 2, live terms table exists; previous B1 reader interval [1,1] remains compatible');
  });
  it('refuses contracted schemas before historical migrations execute', () => {
    db.exec('UPDATE multiremi_schema_meta SET expand_level=5, contract_level=5');
    try {
      let refusal: Error | undefined;
      try { runStartupMigrations(db); } catch (error) { refusal = error as Error; }
      expect(refusal?.message).toContain('contract_level=5 exceeds code maxLevel=4');
      console.info(`startup guard: ${refusal?.message}`);
    }
    finally { db.exec('UPDATE multiremi_schema_meta SET contract_level=0, expand_level=4'); }
  });
  it('upgrades level 2 planned restart schema atomically and preserves old drains on PostgreSQL', () => {
    verifyPlannedRestartSchemaUpgrade(db);
  }, 30_000);
  it('production maintenance CLI refuses undeclared contract and retains the floor', () => {
    db.close();
    const childHome = mkdtempSync(join(tmpdir(), 'mul173-contract-cli-'));
    let child;
    try { child = Bun.spawnSync([process.execPath, 'apps/remi/main.ts', 'db', 'contract', '--level', '1'], {
      cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: childHome, BUN_INSTALL_CACHE_DIR: join(childHome, 'cache'), MULTIREMI_DATABASE_URL: url }, stdout: 'pipe', stderr: 'pipe',
    });
    } finally { rmSync(childHome, { recursive: true, force: true }); }
    db = new PostgresSyncDatabase(url);
    expect(child.exitCode).not.toBe(0);
    expect(child.stderr.toString()).toContain('No declared contract migration');
    expect(readSchemaLevels(db).contractLevel).toBe(0);
    console.info('explicit CLI contract --level 1: refused (No declared contract migration for the target level); contractLevel=0');
  });
  it('rejects all four COLUMN-omitted destructive actions without advancing metadata', () => {
    db.exec('CREATE TABLE mul173_omitted_column (c TEXT)');
    const before = readSchemaLevels(db);
    const columns = () => db.query("SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_name='mul173_omitted_column' ORDER BY ordinal_position").all();
    const original = columns();
    for (const [index, action] of ['DROP c', 'RENAME c TO d', 'ALTER c TYPE integer', 'ALTER c SET NOT NULL'].entries()) {
      const sql = `ALTER TABLE mul173_omitted_column ${action}`;
      const id = `pg-omitted-column-${index}`;
      const steps: SchemaMigration[] = [{ id, phase: 'expand', level: before.expandLevel + 1,
        expandRelease: '9.0.0', release: '9.0.0', run: guarded => guarded.exec(sql) }];
      expect(() => runSchemaExpands(db, steps, '9.0.0', { minLevel: 2, maxLevel: 2 })).toThrow('Destructive DDL is forbidden');
      expect(readSchemaLevels(db)).toEqual(before);
      expect(db.query('SELECT id FROM multiremi_schema_steps WHERE id=?').get(id)).toBeNull();
      expect(columns()).toEqual(original);
      console.info(`Rejected through runSchemaExpands: ${sql}; expandLevel=${before.expandLevel}, contractLevel=${before.contractLevel}; step absent, columns unchanged`);
    }
  });
  it('checks actual online clients before contract, and executes after they disconnect', async () => {
    const steps: SchemaMigration[] = [{ id: 'pg-expand', phase: 'expand', level: 1, expandRelease: '1.0.0', release: '1.0.0',
      run: db => db.exec('CREATE TABLE mul173_retained (id INTEGER)') },
    { id: 'pg-contract', phase: 'contract', level: 1, expandRelease: '1.0.0', release: '1.1.0',
      run: db => db.exec('DROP TABLE mul173_retained') }];
    const code = { minLevel: 1, maxLevel: 1 };
    runSchemaExpands(db, steps, '1.1.0', code);
    expect(readSchemaLevels(db).contractLevel).toBe(0);
    expect(db.query("SELECT table_name FROM information_schema.tables WHERE table_name='mul173_retained'").get()).not.toBeNull();
    console.info('startup expand at later release: retained table exists; contractLevel=0');
    const other = new Bun.SQL(url, { max: 1 });
    try {
      await other`SELECT 1`;
      expect(() => advisoryLock(db, MIGRATION_ADVISORY_LOCK_KEY, () => runSchemaContracts(db, steps, {
        release: '1.1.0', targetLevel: 1, code, assertSlotsCompatible: () => assertSchemaContractClientsOffline(db),
      }))).toThrow('other database clients are online');
      expect(readSchemaLevels(db).contractLevel).toBe(0);
    } finally { await other.close(); }
    // Wait only for PostgreSQL to observe the closed socket, never ignore an
    // active client or substitute a fixture inventory.
    for (let attempt = 0; ; attempt++) {
      try { assertSchemaContractClientsOffline(db); break; }
      catch (error) { if (attempt === 100) throw error; await Bun.sleep(10); }
    }
    advisoryLock(db, MIGRATION_ADVISORY_LOCK_KEY, () => runSchemaContracts(db, steps, {
      release: '1.1.0', targetLevel: 1, code, assertSlotsCompatible: () => assertSchemaContractClientsOffline(db),
    }));
    expect(readSchemaLevels(db).contractLevel).toBe(1);
    console.info('explicit maintenance executor: online client refused; after disconnect contractLevel=1 and retained table removed');
    expect(db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='mul173_retained'").get()).toBeNull();
  }, 15_000);
});

// Kept in the existing PostgreSQL CI entrypoint so the schema job executes these cases.
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
