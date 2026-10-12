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
export class MultiremiStore { constructor(){writeFileSync('startup-ran','operator and question migrations');${fails ? "throw new Error('invalid historical route');" : ''}} }`);
  const run = async (url = 'postgres://remi_rehearsal:fixture@127.0.0.1/remi_update_rehearsal') => {
    const child = Bun.spawn([process.execPath, resolve('packages/platform-updater/src/container-runtime.mjs'), 'migrate', 'candidate'], {
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
