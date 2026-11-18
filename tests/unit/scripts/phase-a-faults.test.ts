import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

async function fixture(mode: string, isolated = '1') {
  const root = await mkdtemp(join(tmpdir(), 'mul172-fault-'));
  await mkdir(join(root, 'api'));
  const module = pathToFileURL(resolve(import.meta.dir, '../../../scripts/phase-a/fault-preload.mjs')).href;
  const code = `import { installFault } from ${JSON.stringify(module)};
    installFault(${JSON.stringify(mode)}, 'bad-release');
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      const path = new URL(request.url).pathname;
      return path === '/readyz' ? Response.json({ state: 'active', term: '1' }) : Response.json({ business: true });
    } }); console.log(server.url.toString());`;
  const child = Bun.spawn([process.execPath, '--eval', code], { stdout: 'pipe', stderr: 'pipe', env: {
    ...process.env, REMI_SUPERVISOR_CONTROL: root, MUL172_ISOLATED: isolated,
  } });
  const output = child.stdout.getReader();
  const first = await output.read();
  const url = new TextDecoder().decode(first.value).trim();
  const evidence = () => readFile(join(root, 'api/mul172-fault-bad-release.json'), 'utf8').then(JSON.parse);
  return { child, url, evidence, close: async () => { child.kill(); await child.exited; output.releaseLock();
    await new Response(child.stderr).text(); await rm(root, { recursive: true, force: true }); } };
}

test('fault wrapper requires isolated marker', async () => {
  const f = await fixture('never-ready', '0');
  try { expect(await f.child.exited).toBe(1); } finally { await f.close(); }
});
test('not-ready injection preserves business handlers and records actual active readiness denial', async () => {
  const f = await fixture('never-ready');
  try {
    expect((await fetch(f.url + 'readyz')).status).toBe(503);
    expect(await (await fetch(f.url + 'business')).json()).toEqual({ business: true });
    expect(await f.evidence()).toMatchObject({ event: 'active_ready_denied', mode: 'never-ready', releaseId: 'bad-release' });
  } finally { await f.close(); }
});
test('activate injection exits the actual API process rather than returning 503', async () => {
  const f = await fixture('activate-crash');
  try {
    await fetch(f.url + 'internal/slot/activate', { method: 'POST' }).catch(() => {});
    expect(await f.child.exited).toBe(86);
    expect(await f.evidence()).toMatchObject({ event: 'activate_exit' });
  } finally { await f.close(); }
});
test('30s crash starts only on public active readiness and records actual process exit', async () => {
  const f = await fixture('crash-after-30s');
  try {
    expect((await fetch(f.url + 'readyz')).status).toBe(200);
    expect(await f.evidence().catch(() => null)).toBeNull();
    expect((await fetch(f.url + 'readyz', { headers: { 'X-Real-IP': '127.0.0.1' } })).status).toBe(200);
    expect(await f.evidence()).toMatchObject({ event: 'crash_armed' });
    expect(await f.child.exited).toBe(87);
    const evidence = await f.evidence();
    expect(evidence.event).toBe('public_live_exit');
    expect(evidence.at - evidence.armedAt).toBeGreaterThanOrEqual(30000);
  } finally { await f.close(); }
}, 40000);
