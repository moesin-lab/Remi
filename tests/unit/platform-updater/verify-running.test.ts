import { expect, it } from 'bun:test';
import { mkdtemp, mkdir, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const linuxTest = process.platform === 'linux' ? it : it.skip;
const runtime = resolve('packages/platform-updater/src/container-runtime.mjs');

async function scenario(role: 'web' | 'api', release: string, kind: 'node' | 'other' | 'api' | 'unrelated') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'remi-verify-running-')));
  const cwd = join(root, 'releases', release, role === 'web' ? 'web/frontend/apps/web' : 'api');
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await mkdir(cwd, { recursive: true });
    // A long original argv leaves room for Linux process.title to overwrite it.
    await writeFile(join(cwd, 'server.js'), "process.title='next-server (vX)';console.log('ready');setInterval(()=>{},1000);");
    await mkdir(join(cwd, 'apps/server'), { recursive: true });
    await writeFile(join(cwd, 'apps/server/main.ts'), "console.log('ready');setInterval(()=>{},1000);");
    const command = kind === 'node' ? ['node', 'server.js', 'x'.repeat(100)]
      : kind === 'other' ? ['/bin/sh', '-c', "printf 'ready\\n'; exec sleep 60", 'server.js']
      : kind === 'api' ? [process.execPath, 'apps/server/main.ts']
      : [process.execPath, '--eval', "console.log('ready');setInterval(()=>{},1000);"];
    child = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe' });
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    try {
      const ready = await reader.read();
      expect(new TextDecoder().decode(ready.value)).toContain('ready');
    } finally { reader.releaseLock(); }
    expect(await readlink(`/proc/${child.pid}/cwd`)).toBe(cwd);
    if (kind === 'node') {
      const argv = await readFile(`/proc/${child.pid}/cmdline`, 'utf8');
      expect(argv).toContain('next-server (vX)');
      expect(argv).not.toContain('server.js');
    }
    const verifier = Bun.spawn(['node', runtime, 'verify-running', 'candidate', role], {
      env: { ...process.env, REMI_APPLICATION_ROOT: root }, stdout: 'pipe', stderr: 'pipe',
    });
    const [code, error] = await Promise.all([verifier.exited, new Response(verifier.stderr).text()]);
    return { code, error };
  } finally {
    if (child) { child.kill(); await child.exited; }
    await rm(root, { recursive: true, force: true });
  }
}

linuxTest('accepts selected Web release after Next rewrites process.title', async () => {
  expect(await scenario('web', 'candidate', 'node')).toEqual({ code: 0, error: '' });
});

linuxTest('rejects a renamed Node process in an old Web release', async () => {
  const result = await scenario('web', 'old', 'node');
  expect(result.code).toBe(1);
  expect(result.error).toContain('Service is not running the selected application release');
});

linuxTest('rejects a non-Node process in the selected Web cwd even with server.js in argv', async () => {
  expect((await scenario('web', 'candidate', 'other')).code).toBe(1);
});

linuxTest('accepts the API entrypoint in the selected release', async () => {
  expect(await scenario('api', 'candidate', 'api')).toEqual({ code: 0, error: '' });
});

linuxTest('rejects the API entrypoint in an old release', async () => {
  expect((await scenario('api', 'old', 'api')).code).toBe(1);
});

linuxTest('rejects an unrelated process in the selected API cwd', async () => {
  expect((await scenario('api', 'candidate', 'unrelated')).code).toBe(1);
});
