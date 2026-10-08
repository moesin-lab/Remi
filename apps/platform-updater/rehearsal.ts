// Runs in a dedicated network_mode:none container with read-only application
// and backup volumes. No production DB URL or API credentials enter this image.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { readJson, releaseDirectory, writeJson } from '../../packages/platform-updater/src/supervisor.mjs';

const root = process.env.REMI_APPLICATION_ROOT || '/remi-program';
const state = process.env.REMI_INTERNAL_UPDATE_STATE || '/remi-state';
const control = join(process.env.REMI_SUPERVISOR_CONTROL || '/remi-control', 'rehearsal');
if ((await readdir('/sys/class/net')).some(name => name !== 'lo') || process.env.MULTIREMI_DATABASE_URL || process.env.MULTIREMI_TOKEN) throw new Error('Rehearsal requires an isolated network and no production credentials');
const heartbeat = () => writeJson(join(control, 'status.json'), { protocol: 1, isolated: true, heartbeatAt: Date.now() });
await heartbeat();
let heartbeatPending = false;
setInterval(() => { if (!heartbeatPending) { heartbeatPending = true; heartbeat().catch(console.error).finally(() => { heartbeatPending = false; }); } }, 1000);

async function command(executable: string, args: string[], env: Record<string, string>, cwd?: string) {
  const child = Bun.spawn([executable, ...args], { env, cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5 * 60_000);
  try {
    const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error('Isolated ' + executable.split('/').at(-1) + ' failed or timed out');
    return output.trim();
  } finally { clearTimeout(timeout); }
}
const query = "SELECT table_schema||'.'||table_name||'.'||column_name||':'||data_type||':'||udt_name||':'||is_nullable FROM information_schema.columns WHERE table_schema='public' ORDER BY 1";
async function rehearse(job: { backup: string; previous: string; target: string }) {
  if (!/^backups\/pop_[A-Za-z0-9_-]+$/.test(job.backup)) throw new Error('Invalid rehearsal backup path');
  const backup = resolve(state, job.backup);
  if (!backup.startsWith(resolve(state, 'backups') + sep)) throw new Error('Backup escaped state root');
  if (!await readJson(join(backup, 'complete.json'))) throw new Error('Backup is incomplete');
  const scratch = await mkdtemp(join(tmpdir(), 'remi-internal-rehearsal-'));
  const pg = join(scratch, 'postgres');
  const env = { PATH: process.env.PATH!, HOME: scratch, TMPDIR: scratch, LANG: 'C.UTF-8',
    PGHOST: '127.0.0.1', PGPORT: '55432', PGUSER: 'remi_rehearsal', PGDATABASE: 'remi_update_rehearsal', PGCONNECT_TIMEOUT: '10' };
  let started = false;
  try {
    await command('initdb', ['-D', pg, '-U', env.PGUSER, '--auth=trust', '--no-locale'], env);
    await command('pg_ctl', ['-D', pg, '-l', join(scratch, 'postgres.log'), '-w', '-t', '30', '-o', '-h 127.0.0.1 -p 55432 -k ' + scratch, 'start'], env); started = true;
    await command('createdb', [env.PGDATABASE], env);
    await command('pg_restore', ['--dbname', env.PGDATABASE, '--no-owner', '--no-privileges', '--exit-on-error', join(backup, 'database.dump')], env);
    const before = (await command('psql', ['-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', query], env)).split('\n');
    for (const id of [job.target, job.previous]) {
      const release = releaseDirectory(root, id);
      if (!await readJson(join(release, 'complete.json'))) throw new Error('Rehearsal release is incomplete');
      await command(join(release, 'runtime/bun'), ['--eval',
        "const {openMultiremiDatabase}=await import('./packages/server/src/store/db/postgres.ts');const {runMigrations}=await import('./packages/server/src/store/migrations.ts');const db=openMultiremiDatabase();try{await runMigrations(db)}finally{await db.close()}"],
      { ...env, MULTIREMI_DATABASE_URL: 'postgresql://remi_rehearsal@127.0.0.1:55432/remi_update_rehearsal', MULTIREMI_HOME: join(scratch, 'home') }, join(release, 'api'));
      const after = new Set((await command('psql', ['-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', query], env)).split('\n'));
      if (before.some(column => !after.has(column))) throw new Error('Migration removed or changed an existing column');
    }
  } finally {
    if (started) await command('pg_ctl', ['-D', pg, '-m', 'immediate', '-w', 'stop'], env);
    if (!scratch.startsWith(resolve(tmpdir()) + sep + 'remi-internal-rehearsal-')) throw new Error('Invalid scratch cleanup path');
    await rm(scratch, { recursive: true, force: true });
  }
}
for (;;) {
  const job = await readJson<{ id: string; backup: string; previous: string; target: string }>(join(control, 'job.json'));
  const previous = await readJson<{ id: string }>(join(control, 'result.json'));
  if (job && job.id !== previous?.id) {
    try { await rehearse(job); await writeJson(join(control, 'result.json'), { id: job.id, ok: true }); }
    catch (error) { await writeJson(join(control, 'result.json'), { id: job.id, ok: false, error: error instanceof Error ? error.message : String(error) }); }
  }
  await Bun.sleep(200);
}
