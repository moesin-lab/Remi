/** Opt-in real v0.2.90 migration/restore rehearsal; all databases and volumes are disposable. */
import { expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ContainerApplicationDriver } from '@remi-platform/updater/application-driver.js';
import { assertSchemaContract, SchemaContractRefusedError } from '@remi-platform/updater/schema-contract.js';
import { BunCommandRunner, type CommandOptions } from '@remi-platform/updater/types.js';
import type { MultiremiPlatformRelease, PlatformSchemaContractFailure } from '@multiremi/contracts';

const BASE = '0aa459ba2d841940b694d4b144a96421b85cf12d';
const repository = resolve(import.meta.dir, '../..');
const evidencePath = resolve(repository, 'schema-boundary-evidence/evidence.json');
const shapeQuery = "SELECT table_schema||'.'||table_name||'.'||column_name||':'||data_type||':'||udt_name||':'||is_nullable FROM information_schema.columns WHERE table_schema='public' ORDER BY 1";
const migration = 'const {openMultiremiDatabase}=await import("./packages/server/src/store/db/postgres.ts"); const {MultiremiStore}=await import("./packages/server/src/store/store.ts"); const db=openMultiremiDatabase(); try { new MultiremiStore(db); } finally { db.close(); } process.exit(0);';

export async function runSchemaBoundaryScenario(): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), 'remi-schema-boundary-'));
  const oldSource = join(scratch, 'v0.2.90');
  const name = `remi-schema-boundary-${process.pid}`;
  const volume = `${name}-program`;
  const label = `io.remi.schema-boundary=${name}`;
  const commands: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const evidence: Record<string, unknown> = { base: BASE, productBaseline: '84e31e785b9faa3a085587732a9b9d26751de658', commands, cleanup: {}, manual: 'docs/deploy/manual-schema-boundary-upgrade.md' };
  let pgCreated = false, volumeCreated = false, worktreeCreated = false;
  const command = (executable: string, args: string[], input?: Buffer | string) => {
    commands.push({ command: executable, args });
    const result = spawnSync(executable, args, { cwd: repository, input, maxBuffer: 128 * 1024 * 1024, timeout: 180_000 });
    if (result.status !== 0) throw new Error(`${executable} ${args.slice(0, 4).join(' ')} failed (${result.status}): ${result.stderr?.toString()} ${result.error?.message ?? ''}`);
    return result.stdout;
  };
  const docker = (args: string[], input?: Buffer | string) => command('docker', args, input);
  const sql = (database: string, query: string) => docker(['exec', '-i', name, 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'remi_rehearsal', '-d', database], query).toString().trim();
  const shape = (database: string) => sql(database, shapeQuery).split('\n').filter(Boolean);
  const home = join(scratch, 'home'), backup = join(scratch, 'backup');
  mkdirSync(join(home, 'archives'), { recursive: true }); mkdirSync(backup);
  // A valid empty ZIP represents legacy bytes; the fixture verifies their digest, not archive reading support.
  writeFileSync(join(home, 'archives', 'legacy.zip'), Buffer.from('504b0506000000000000000000000000000000000000', 'hex'));
  const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const manifest = (root: string, relative = ''): Record<string, string> => Object.fromEntries(readdirSync(join(root, relative), { withFileTypes: true }).flatMap(entry => {
    const path = join(relative, entry.name);
    return entry.isDirectory() ? Object.entries(manifest(root, path)) : [[path, digest(join(root, path))]];
  }));
  const archiveHash = digest(join(home, 'archives/legacy.zip'));
  try {
    evidence.target = command('git', ['rev-parse', 'HEAD']).toString().trim();
    evidence.targetMeaning = 'Actual checked-out CI HEAD (pull_request merge commit when run by the existing workflow)';
    command('git', ['fetch', '--depth', '1', 'origin', BASE]);
    command('git', ['worktree', 'add', '--detach', oldSource, BASE]); worktreeCreated = true;
    commands.push({ command: 'bun', args: ['install', '--registry', 'https://registry.npmjs.org', '--frozen-lockfile', '--ignore-scripts'], cwd: oldSource });
    const install = spawnSync(process.execPath, ['install', '--registry', 'https://registry.npmjs.org', '--frozen-lockfile', '--ignore-scripts'], { cwd: oldSource, encoding: 'utf8', timeout: 180_000 });
    if (install.status !== 0) throw new Error(`Released dependency install failed: ${install.stderr} ${install.error?.message ?? ''}`);
    expect(command('git', ['-C', oldSource, 'rev-parse', 'HEAD']).toString().trim()).toBe(BASE);
    docker(['run', '--detach', '--pull=never', '--name', name, '--label', label, '--network', 'none',
      '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', '--env', 'POSTGRES_USER=remi_rehearsal', '--env', 'POSTGRES_DB=boundary', 'pgvector/pgvector:pg17']); pgCreated = true;
    for (let attempt = 0; ; attempt++) {
      const probe = spawnSync('docker', ['exec', name, 'psql', '-X', '-At', '-h', '127.0.0.1', '-U', 'remi_rehearsal', '-d', 'boundary', '-c', 'SELECT 1']);
      if (probe.status === 0) break;
      if (attempt >= 60) throw new Error('PostgreSQL readiness timed out');
      await Bun.sleep(500);
    }
    const migrate = (source: string, database: string, apiHome: string) => docker(['run', '--rm', '--pull=never', '--label', label, '--network', `container:${name}`, '--read-only', '--tmpfs', '/tmp:rw,nosuid,size=512m',
      '--mount', `type=bind,src=${source},dst=/source,readonly`, '--mount', `type=bind,src=${apiHome},dst=/data/home`, '--workdir', '/source',
      '--env', 'HOME=/data/home', '--env', 'REMI_HOME=/data/home', '--env', 'MULTIREMI_HOME=/data/home', '--env', 'MULTIREMI_MIGRATION_REPORT_DIR=/data/home/reports/migrations',
      '--env', `MULTIREMI_DATABASE_URL=postgresql://remi_rehearsal@127.0.0.1:5432/${database}`, 'oven/bun:1.3.14', 'bun', '--eval', migration]);
    migrate(oldSource, 'boundary', home);
    // No DDL fixture: these are the real released migration's tables.
    sql('boundary', `INSERT INTO multiremi_session_archives (id,subject_kind,subject_id,runtime_id,daemon_id,source_revision,sha256,size_bytes,status,relative_path,created_at,updated_at)
      VALUES ('arc_fixture','issue','iss_fixture','rt_fixture','daemon_fixture','source_fixture','${archiveHash}',22,'ready','archives/legacy.zip','2026-10-10','2026-10-10');
      INSERT INTO multiremi_session_archive_requests (id,runtime_id,subject_kind,subject_id,status,created_by,created_at,updated_at)
      VALUES ('request_fixture','rt_fixture','issue','iss_fixture','completed','local','2026-10-10','2026-10-10');
      INSERT INTO multiremi_trace_backfill_progress (subject_kind,subject_id,status,task_count,row_count,archive_id,updated_at)
      VALUES ('issue','iss_fixture','done',1,1,'arc_fixture','2026-10-10');
      INSERT INTO multiremi_task_traces (task_id,location,archive_id,member_path,data_offset,compressed_size,uncompressed_size,sha256,event_count,head_seq,updated_at)
      VALUES ('tsk_fixture','archive','arc_fixture','trace.jsonl',0,1,1,'${archiveHash}',1,1,'2026-10-10');`);
    // Writer processes have exited; no API, updater, daemon or business ingress exists in this isolated project.
    evidence.writersStopped = true;
    const beforeFiles = manifest(home); evidence.beforeFiles = beforeFiles;
    evidence.images = Object.fromEntries(['pgvector/pgvector:pg17', 'oven/bun:1.3.14'].map(image => [image, docker(['image', 'inspect', '--format', '{{.Id}} {{json .RepoDigests}}', image]).toString().trim()]));
    evidence.postgresVersion = sql('boundary', 'SELECT version()');
    const before = shape('boundary'); evidence.before = before;
    const oldTables = ['multiremi_session_archives', 'multiremi_session_archive_requests', 'multiremi_trace_backfill_progress', 'multiremi_task_traces'];
    const rows = (database: string, tables: string[]) => Object.fromEntries(tables.map(table => [table, sql(database, `SELECT count(*) FROM ${table}`)]));
    const beforeRows = rows('boundary', oldTables); evidence.beforeRows = beforeRows;
    expect(Object.values(beforeRows)).toEqual(['1', '1', '1', '1']);
    // Same dump/list/tar/checksum/restore commands as the operator manual.
    const dump = docker(['exec', name, 'pg_dump', '-U', 'remi_rehearsal', '-d', 'boundary', '-Fc']);
    writeFileSync(join(backup, 'database.dump'), dump);
    docker(['exec', '-i', name, 'pg_restore', '--list'], dump);
    command('tar', ['-C', home, '-cf', join(backup, 'volume-api-home.archive'), '.']);
    command('tar', ['-tf', join(backup, 'volume-api-home.archive')]);
    const backupHashes = { dump: digest(join(backup, 'database.dump')), home: digest(join(backup, 'volume-api-home.archive')) };
    evidence.backupHashes = backupHashes;
    writeFileSync(join(backup, 'SHA256SUMS'), command('sha256sum', [join(backup, 'database.dump'), join(backup, 'volume-api-home.archive')]));
    // Real ContainerApplicationDriver.rehearse, including scratch restore, migration runtime and finally cleanup.
    // Only the private entry point is selected: no command or migration is mocked.
    docker(['volume', 'create', '--label', label, volume]); volumeCreated = true;
    for (const [id, source, sha] of [['previous', oldSource, BASE], ['target', repository, String(evidence.target)]]) {
      const archive = command('git', ['-C', source!, 'archive', sha!, 'packages', 'apps', 'deploy', 'tsconfig.json', 'package.json', 'bun.lock']);
      docker(['run', '--rm', '--pull=never', '--label', label, '--network', 'none', '--mount', `type=volume,src=${volume},dst=/program`, 'oven/bun:1.3.14', 'sh', '-c', `mkdir -p /program/releases/${id}/api && tar -C /program/releases/${id}/api -xf -`].toSpliced(1, 0, '-i'), archive);
      docker(['run', '--rm', '--pull=never', '--label', label, '--network', 'none', '--mount', `type=volume,src=${volume},dst=/program`, '--mount', `type=bind,src=${source},dst=/input,readonly`, 'oven/bun:1.3.14', 'cp', '-a', '/input/node_modules', `/program/releases/${id}/api/node_modules`]);
    }
    const bootstrap = join(scratch, 'bootstrap'); mkdirSync(bootstrap);
    copyFileSync(join(repository, 'packages/platform-updater/src/container-runtime.mjs'), join(bootstrap, 'runtime.mjs'));
    const runner = new BunCommandRunner();
    const driver = new ContainerApplicationDriver({ kind: 'docker_compose', composeFile: join(scratch, 'compose.yml'), envFile: join(scratch, 'compose.env'), stateDir: scratch, apiHealthUrl: '', webHealthUrl: '' }, {
      run: (executable: string, args: string[], options?: CommandOptions) => { commands.push({ command: executable, args }); return runner.run(executable, args, options); },
    });
    const release = (version: string, ref: string): MultiremiPlatformRelease => ({ version, ref, publishedAt: null, releaseUrl: null, manifestUrl: null, apiImage: null, webImage: null });
    let refusal: PlatformSchemaContractFailure | undefined;
    const rehearsal = driver as unknown as { rehearse(installation: Record<string, string>, backup: string, previous: { id: string; release: MultiremiPlatformRelease }, target: { id: string; release: MultiremiPlatformRelease }, operationId: string): Promise<void> };
    try {
      await rehearsal.rehearse({ project: name, volume, bootstrap, apiImage: 'oven/bun:1.3.14', postgresImage: 'pgvector/pgvector:pg17' }, backup,
        { id: 'previous', release: release('0.2.90', BASE) }, { id: 'target', release: release('candidate', String(evidence.target)) }, 'pop_boundary');
    } catch (error) { expect(error).toBeInstanceOf(SchemaContractRefusedError); refusal = (error as SchemaContractRefusedError).failure; }
    expect(refusal?.reason).toBe('schema_contract_refused'); expect(refusal?.stage).toBe('target'); evidence.refusal = refusal;
    // Rehearsal cannot change the live (still isolated) source database or files.
    expect(shape('boundary')).toEqual(before); expect(rows('boundary', oldTables)).toEqual(beforeRows);
    expect(digest(join(home, 'archives/legacy.zip'))).toBe(archiveHash);
    migrate(repository, 'boundary', home);
    const after = shape('boundary'); evidence.after = after;
    const afterSet = new Set(after);
    const removed = before.filter(signature => !afterSet.has(signature)); evidence.removed = removed;
    const removedByTable = Object.fromEntries([...new Set(removed.map(signature => signature.split(':')[0]!.split('.').slice(0, -1).join('.')))].map(table => [table, removed.filter(signature => signature.startsWith(table + '.')).length]));
    evidence.removedByTable = removedByTable;
    expect(removed).toHaveLength(50);
    expect(removedByTable).toEqual({ 'public.multiremi_issue_workspaces': 3, 'public.multiremi_session_archive_requests': 8, 'public.multiremi_session_archives': 24, 'public.multiremi_task_traces': 7, 'public.multiremi_trace_backfill_progress': 8 });
    for (const stage of ['target', 'previous'] as const) {
      try { assertSchemaContract(before, after, { stage, currentVersion: '0.2.90', targetVersion: 'candidate' }); }
      catch (error) {
        const failure = (error as SchemaContractRefusedError).failure;
        expect(failure).toMatchObject({ stage, affectedColumnCount: 50, removedTables: { total: 3 }, removedColumns: { total: 10 }, changedColumns: { total: 0 } });
        if (stage === 'target') expect(failure).toEqual(refusal!);
      }
    }
    expect(sql('boundary', `SELECT sha256||'|'||relative_path FROM multiremi_legacy_session_archives WHERE id='arc_fixture'`)).toBe(`${archiveHash}|archives/legacy.zip`);
    expect(sql('boundary', `SELECT archive_id||'|'||sha256 FROM multiremi_legacy_trace_pointers WHERE task_id='tsk_fixture'`)).toBe(`arc_fixture|${archiveHash}`);
    expect(sql('boundary', `SELECT location FROM multiremi_task_traces WHERE task_id='tsk_fixture'`)).toBe('lost');
    expect(sql('boundary', "SELECT to_regclass('public.multiremi_session_archive_requests') IS NULL AND to_regclass('public.multiremi_trace_backfill_progress') IS NULL")).toBe('t');
    evidence.afterRows = rows('boundary', ['multiremi_legacy_session_archives', 'multiremi_legacy_trace_pointers', 'multiremi_task_traces']);
    expect(Object.values(evidence.afterRows as object)).toEqual(['1', '1', '1']);
    expect(digest(join(home, 'archives/legacy.zip'))).toBe(archiveHash);
    command('sha256sum', ['-c', join(backup, 'SHA256SUMS')]);
    docker(['exec', name, 'createdb', '-U', 'remi_rehearsal', '--template=template0', 'restored']);
    docker(['exec', '-i', name, 'pg_restore', '-U', 'remi_rehearsal', '-d', 'restored', '--no-owner', '--no-privileges', '--exit-on-error', '--single-transaction'], dump);
    const restoredHome = join(scratch, 'restored-home'); mkdirSync(restoredHome);
    command('tar', ['-C', restoredHome, '-xf', join(backup, 'volume-api-home.archive')]);
    expect(digest(join(backup, 'database.dump'))).toBe(backupHashes.dump); expect(digest(join(backup, 'volume-api-home.archive'))).toBe(backupHashes.home);
    expect(shape('restored')).toEqual(before); expect(rows('restored', oldTables)).toEqual(beforeRows);
    expect(digest(join(restoredHome, 'archives/legacy.zip'))).toBe(archiveHash);
    expect(manifest(restoredHome)).toEqual(beforeFiles);
    evidence.restoredFiles = manifest(restoredHome);
    // Old startup against the restored pair confirms the migration-report guard accepts the complete backup.
    migrate(oldSource, 'restored', restoredHome);
    expect(shape('restored')).toEqual(before); expect(rows('restored', oldTables)).toEqual(beforeRows);
    evidence.restore = { shapeEqual: true, rows: rows('restored', oldTables), archiveHash, backupHashesEqual: true, oldStoreStartup: true };
    evidence.success = true;
  } catch (error) { evidence.error = error instanceof Error ? error.stack : String(error); throw error; }
  finally {
    try {
      if (pgCreated) docker(['rm', '--force', '--volumes', name]);
      if (volumeCreated) docker(['volume', 'rm', volume]);
      const containers = docker(['ps', '--all', '--filter', `label=${label}`, '--format', '{{.Names}}']).toString().trim();
      const rehearsals = docker(['ps', '--all', '--filter', `label=io.remi.application.project=${name}`, '--format', '{{.Names}}']).toString().trim();
      const volumes = docker(['volume', 'ls', '--filter', `label=${label}`, '--format', '{{.Name}}']).toString().trim();
      if (worktreeCreated) command('git', ['worktree', 'remove', '--force', oldSource]);
      const worktreeListed = command('git', ['worktree', 'list', '--porcelain']).toString().split('\n').includes('worktree ' + oldSource);
      evidence.cleanup = { containers, rehearsals, volumes, worktreeListed }; expect([containers, rehearsals, volumes, worktreeListed]).toEqual(['', '', '', false]);
    } finally {
      mkdirSync(resolve(evidencePath, '..'), { recursive: true }); writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
      console.log('SCHEMA_BOUNDARY_EVIDENCE ' + JSON.stringify(evidence));
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}
