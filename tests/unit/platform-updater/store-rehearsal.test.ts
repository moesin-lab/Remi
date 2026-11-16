import { afterEach, expect, it } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(fails = false) {
  const root = await mkdtemp(join(tmpdir(), 'remi-store-rehearsal-')); roots.push(root);
  const source = join(root, 'releases', 'candidate', 'api', 'packages/server/src/store');
  await mkdir(join(source, 'db'), { recursive: true });
  await writeFile(join(source, 'db/postgres.ts'), 'export function openMultiremiDatabase(){return {close(){}}}');
  await writeFile(join(source, 'store.ts'), `import {writeFileSync} from 'node:fs';
export class MultiremiStore { constructor(){writeFileSync('startup-ran','operator and question migrations');if(!process.env.MULTIREMI_MIGRATION_REPORT_DIR?.endsWith('/scratch/reports/migrations'))throw new Error('Missing report override');${fails ? "throw new Error('invalid historical route');" : ''}} }`);
  const reports = join(root, 'home/reports/migrations');
  await mkdir(reports, { recursive: true });
  await writeFile(join(reports, 'test-before.json'), '{"phase":"before"}');
  const archive = join(root, 'api-home.archive');
  const tar = Bun.spawn(['tar', '-cf', archive, '-C', join(root, 'home'), '.']);
  if (await tar.exited !== 0) throw new Error('Fixture tar failed');
  const run = async (url = 'postgres://remi_rehearsal:fixture@127.0.0.1/remi_update_rehearsal') => {
    const runtime = resolve('packages/platform-updater/src/container-runtime.mjs');
    const script = `import {rehearseStoreMigration} from ${JSON.stringify(runtime)}; await rehearseStoreMigration(${JSON.stringify(resolve(source, '../../../..'))}, ${JSON.stringify(archive)}, ${JSON.stringify(join(root, 'scratch'))});`;
    const args = url.endsWith('/production') ? [runtime, 'migrate', 'candidate'] : ['--eval', script];
    const child = Bun.spawn([process.execPath, ...args], {
      env: { ...process.env, REMI_APPLICATION_ROOT: root, MULTIREMI_DATABASE_URL: url }, stdout: 'pipe', stderr: 'pipe',
    });
    const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    return { code, error };
  };
  return { run, marker: join(root, 'releases/candidate/api/startup-ran') };
}

it('rehearses operator and Question startup before a candidate can switch', async () => {
  const f = await fixture();
  expect(await f.run()).toEqual({ code: 0, error: '' });
  expect(await readFile(f.marker, 'utf8')).toBe('operator and question migrations');
}, 15_000);

it('rejects a candidate whose store startup fails', async () => {
  const f = await fixture(true);
  const result = await f.run();
  expect(result.code).not.toBe(0);
  expect(result.error).toContain('Migration rehearsal failed');
}, 15_000);

it('rejects a production database before importing the candidate', async () => {
  const f = await fixture();
  const result = await f.run('postgres://remi_rehearsal:fixture@127.0.0.1/production');
  expect(result.code).not.toBe(0);
  expect(result.error).toContain('isolated rehearsal database');
  expect(await Bun.file(f.marker).exists()).toBe(false);
}, 15_000);

it('direct store startup still refuses an applied migration without persistent reports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remi-store-report-guard-')); roots.push(root);
  const script = `
    import { MultiremiStore } from ${JSON.stringify(resolve('packages/server/src/store/store.ts'))};
    import { openSqliteDatabase } from ${JSON.stringify(resolve('packages/server/src/store/db/sqlite.ts'))};
    import { rmSync, mkdirSync } from 'node:fs';
    const db = openSqliteDatabase(':memory:');
    try {
      new MultiremiStore(db);
      rmSync(process.env.MULTIREMI_MIGRATION_REPORT_DIR, { recursive: true });
      mkdirSync(process.env.MULTIREMI_MIGRATION_REPORT_DIR);
      try { new MultiremiStore(db); throw new Error('startup unexpectedly succeeded'); }
      catch (error) {
        if (!error.message.includes('Unified migration before report missing: restore the persistent report directory')) throw error;
      }
    } finally { db.close(); }
  `;
  const child = Bun.spawn([process.execPath, '--eval', script], {
    env: { ...process.env, MULTIREMI_MIGRATION_REPORT_DIR: join(root, 'reports') }, stdout: 'pipe', stderr: 'pipe',
  });
  const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect({ code, error }).toEqual({ code: 0, error: '' });
}, 15_000);
