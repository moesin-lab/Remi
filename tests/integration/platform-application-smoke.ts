/**
 * Real, isolated Docker update/rollback test. No production ports, data or images
 * are replaced. Requires cached Bun 1.3.14, Node 22 and pgvector/pgvector:pg17.
 * bun run tests/integration/platform-application-smoke.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ContainerApplicationDriver } from '@remi-platform/updater/application-driver.js';
import { PlatformUpdaterClient } from '@remi-platform/updater/client.js';
import { PlatformUpdateWorker } from '@remi-platform/updater/worker.js';
import { BunCommandRunner, type CommandRunner } from '@remi-platform/updater/types.js';
import { DATA_SCHEMA_INPUTS, isWithin, migrationFingerprint } from '@remi-platform/updater/safety.js';
import { API_BASE_INPUTS, type ApplicationManifest } from '@remi-platform/updater/application-manifest.js';
import type { MultiremiPlatformOperation, MultiremiPlatformStatus } from '@multiremi/contracts';
import { baseFingerprints } from '../../packages/platform-updater/src/supervisor.mjs';

const internal = process.argv.includes('--internal');
const repository = resolve(import.meta.dir, '../..');
const root = await mkdtemp(join(tmpdir(), 'remi-application-smoke-'));
const project = 'remi-app-test-' + randomUUID().slice(0, 8);
const apiImage = project + '-api:base', webImage = project + '-web:base';
const updaterImage = project + '-updater:base';
const bunBase = process.env.MULTIREMI_TEST_BUN_IMAGE ?? 'oven/bun:1.3.14';
const nodeBase = process.env.MULTIREMI_TEST_NODE_IMAGE ?? 'node:22-bookworm-slim';
const pgBase = process.env.MULTIREMI_TEST_PG_IMAGE ?? 'pgvector/pgvector:pg17';
// The internal path must prove executable version changes, not merely copies of
// the runtime already in the image. Build/test tooling still uses pinned 1.3.14.
const apiBaseImage = internal ? 'oven/bun:1.3.13' : bunBase;
const webBaseImage = internal ? 'node:22.13.1-bookworm-slim' : nodeBase;
const runner = new BunCommandRunner();
const calls: string[][] = [];
const traced: CommandRunner = { async run(command, args, options) {
  calls.push(args);
  const result = await runner.run(command, args, options);
  if (result.exitCode !== 0 && !args.includes('pg_isready')) console.error('isolated fixture command failed:', args[0], result.stderr.slice(-1800));
  return result;
} };
async function docker(args: string[]) {
  const result = await traced.run('docker', args);
  if (result.exitCode !== 0) throw new Error('Isolated Docker step failed: ' + args[0]);
  return result.stdout.trim();
}
const composeFile = join(root, 'compose.json'), envFile = join(root, 'compose.env');
const compose = (args: string[]) => docker(['compose', '-p', project, '--env-file', envFile, '-f', composeFile, ...args]);
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
async function save(path: string, data: string) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, data); }
const originalFetch = globalThis.fetch;
const archives = new Map<string, string>();
const feedUrl = internal ? 'https://feed:8443/releases.json' : 'https://fixture.invalid/releases.json';
let advertised: ApplicationManifest | null = null;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  if (String(input) === feedUrl) return Response.json({ latest: advertised });
  const path = archives.get(String(input));
  return path ? new Response(Bun.file(path)) : originalFetch(input, init);
}) as typeof fetch;
let started = false, builtApi = false, builtWeb = false, builtUpdater = false;
try {
  for (const image of new Set([bunBase, nodeBase, pgBase, apiBaseImage, webBaseImage])) await docker(['image', 'inspect', '--format', '{{.Id}}', image]);
  const apiRoot = join(root, 'api');
  const fixtureBuild = await Bun.build({ entrypoints: [join(import.meta.dir, 'platform-application-api-fixture.ts')], target: 'bun', outdir: join(apiRoot, 'apps/server') });
  if (!fixtureBuild.success) throw new Error(fixtureBuild.logs.map(String).join('\n'));
  await cp(resolve(import.meta.dir, '../../packages/server/src/store/db/pg-worker.ts'), join(apiRoot, 'apps/server/pg-worker.ts'));
  await save(join(apiRoot, 'deploy/docker/Dockerfile.api'), `FROM ${apiBaseImage}\nCOPY api /app\n`);
  await save(join(apiRoot, 'deploy/docker/api-entrypoint.sh'), '#!/bin/sh\nexec "$@"\n');
  for (const path of DATA_SCHEMA_INPUTS) await save(join(apiRoot, path), '// isolated fixture\n');
  await save(join(apiRoot, 'package.json'), '{"type":"module"}');
  await save(join(apiRoot, 'packages/server/src/store/db/postgres.ts'), 'export function openMultiremiDatabase(){return new Bun.SQL(process.env.MULTIREMI_DATABASE_URL!)}');
  const oldMigration = 'export async function runMigrations(db){await db.unsafe("CREATE TABLE IF NOT EXISTS sentinel(id integer PRIMARY KEY, value text NOT NULL)")}';
  const newMigration = 'export async function runMigrations(db){await db.unsafe("CREATE TABLE IF NOT EXISTS sentinel(id integer PRIMARY KEY, value text NOT NULL)");await db.unsafe("ALTER TABLE sentinel ADD COLUMN IF NOT EXISTS note text NOT NULL DEFAULT \'\'")}';
  await save(join(apiRoot, 'packages/server/src/store/migrations.ts'), oldMigration);
  const apiSource = `import {app} from './platform-application-api-fixture.js';
import {openMultiremiDatabase} from '../../packages/server/src/store/db/postgres.ts';
import {runMigrations} from '../../packages/server/src/store/migrations.ts';
const db=openMultiremiDatabase();await runMigrations(db);
Bun.serve({hostname:'0.0.0.0',port:6120,async fetch(r,s){
 const path=new URL(r.url).pathname;
 if(path==='/ws'&&s.upgrade(r))return;
 if(path==='/api/verify')return Response.json({version:process.env.MULTIREMI_VERSION||'1.0.0',rows:await db.unsafe('SELECT * FROM sentinel ORDER BY id')});
 if(path==='/write')return new Response('write admitted');
 if(path==='/readyz')return Response.json({ok:true,version:process.env.MULTIREMI_VERSION||'1.0.0'});
 return app.fetch(r);
},websocket:{open(ws){ws.send(JSON.stringify({type:'auth_ack'}))},message(ws){ws.send(JSON.stringify({type:'pong'}))}}});`;
  await save(join(apiRoot, 'apps/server/main.ts'), apiSource);
  await save(join(root, 'web/package.json'), '{"type":"module"}');
  await save(join(root, 'web/frontend/apps/web/server.js'), `import http from 'node:http';import{dirname}from'node:path';import{fileURLToPath}from'node:url';process.chdir(dirname(fileURLToPath(import.meta.url)));http.createServer(async(req,res)=>{if(req.url.startsWith('/api/')){const chunks=[];for await(const chunk of req)chunks.push(chunk);try{const response=await fetch('http://api:6120'+req.url,{method:req.method,headers:req.headers,body:chunks.length?Buffer.concat(chunks):undefined});res.statusCode=response.status;res.setHeader('content-type','application/json');res.end(await response.text());}catch{res.statusCode=503;res.end('{}');}return;}res.end('<h1>Isolated application update fixture</h1>')}).listen(3000,'0.0.0.0');`);
  await save(join(root, 'Dockerfile.api'), `FROM ${bunBase}\nWORKDIR /app\nCOPY api /app\nCMD ["bun","run","apps/server/main.ts","serve"]\n`);
  await save(join(root, 'Dockerfile.web'), `FROM ${nodeBase}\nUSER root\nRUN rm -rf /app && mkdir /app\nWORKDIR /app\nCOPY web /app\nUSER node\nCMD ["node","frontend/apps/web/server.js"]\n`);
  if (internal) {
    await mkdir(join(root, 'supervisor'));
    for (const name of ['supervisor.mjs', 'container-runtime.mjs']) await cp(join(repository, 'packages/platform-updater/src', name), join(root, 'supervisor', name));
    await cp(join(repository, 'deploy/docker/host-write-fence.ts'), join(root, 'supervisor/host-write-fence.ts'));
    const setup = `\nCOPY supervisor /usr/local/lib/remi\nRUN mkdir -p /remi-control /remi-program /remi-seed /tmp/remi-next-cache && chown 1000:1000 /remi-control /remi-program /remi-seed /tmp/remi-next-cache\nENV REMI_APPLICATION_BASE_VERSION=1.0.0 REMI_APPLICATION_BASE_REF=${'1'.repeat(40)}\nUSER 1000:1000\n`;
    await save(join(root, 'Dockerfile.api'), `FROM ${apiBaseImage}\nWORKDIR /app\nCOPY api /app\n${setup}CMD ["bun","/usr/local/lib/remi/supervisor.mjs"]\n`);
    await save(join(root, 'Dockerfile.web'), `FROM ${webBaseImage}\nUSER root\nRUN rm -rf /app && mkdir /app\nWORKDIR /app\nCOPY web /app\n${setup}CMD ["node","/usr/local/lib/remi/supervisor.mjs"]\n`);
    await docker(['build', '--pull=false', '-q', '-f', join(repository, 'deploy/docker/Dockerfile.updater'), '--build-arg', `BUN_IMAGE=${bunBase}`, '--build-arg', `POSTGRES_IMAGE=${pgBase}`, '-t', updaterImage, repository]); builtUpdater = true;
    await docker(['run', '--rm', '--pull=never', '--network', 'none', '--mount', `type=bind,src=${root},dst=/fixture`, '--entrypoint', 'openssl', pgBase, 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', '/fixture/feed-key.pem', '-out', '/fixture/feed-cert.pem', '-days', '1', '-subj', '/CN=feed', '-addext', 'subjectAltName=DNS:feed']);
    await save(join(root, 'feed.ts'), `Bun.serve({hostname:'0.0.0.0',port:8443,tls:{key:Bun.file('/feed/feed-key.pem'),cert:Bun.file('/feed/feed-cert.pem')},fetch(request){const name=new URL(request.url).pathname.slice(1);if(!/^(releases\\.json|application-[0-9.]+\\.tar\\.gz)$/.test(name))return new Response('missing',{status:404});return new Response(Bun.file('/feed/'+name));}});`);
    await save(join(root, 'releases.json'), JSON.stringify({ latest: null }));
  }
  await docker(['build', '--pull=false', '-q', '-f', join(root, 'Dockerfile.api'), '-t', apiImage, root]); builtApi = true;
  await docker(['build', '--pull=false', '-q', '-f', join(root, 'Dockerfile.web'), '-t', webImage, root]); builtWeb = true;
  const persistent = join(root, 'persistent'); await mkdir(persistent); await chmod(persistent, 0o777); await save(join(persistent, 'transcript.txt'), 'agent transcript must survive');
  const pgName = project + '-postgres-1';
  const adminToken = randomUUID(), updaterToken = randomUUID();
  const portProbe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const reservedApiPort = portProbe.port; portProbe.stop(true);
  const webProbe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const reservedWebPort = webProbe.port; webProbe.stop(true);
  await save(envFile, '');
  const model = { services: {
    postgres: { image: pgBase, environment: { POSTGRES_HOST_AUTH_METHOD: 'trust', POSTGRES_USER: 'fixture', POSTGRES_DB: 'fixture' }, volumes: ['db:/var/lib/postgresql/data'], healthcheck: { test: ['CMD-SHELL', 'pg_isready -U fixture -d fixture'], interval: '1s', retries: 30 } },
    api: { image: apiImage, init: true, environment: { MULTIREMI_DATABASE_URL: 'postgresql://fixture@postgres:5432/fixture', MULTIREMI_HOME: '/srv/multiremi', FIXTURE_ADMIN_TOKEN: adminToken, FIXTURE_UPDATER_TOKEN: updaterToken }, ports: [`127.0.0.1:${reservedApiPort}:6120`], volumes: [{ type: 'bind', source: persistent, target: '/srv/multiremi' }], depends_on: { postgres: { condition: 'service_healthy' } } },
    web: { image: webImage, init: true, ports: [`127.0.0.1:${reservedWebPort}:3000`] },
    daemon: { image: bunBase, init: true, command: ['bun', '-e', 'setInterval(()=>Bun.write("/tmp/heartbeat",String(Date.now())),50)'] },
  }, volumes: { db: {} } } as { services: Record<string, any>; volumes: Record<string, object> };
  if (internal) {
    Object.assign(model.volumes, { program: {}, control: {}, state: {}, 'api-seed': {}, 'web-seed': {} });
    for (const role of ['api', 'web']) {
      model.services[role].environment = { ...model.services[role].environment, REMI_SUPERVISOR_ROLE: role };
      model.services[role].volumes = [...(model.services[role].volumes ?? []), 'program:/remi-program:ro', 'control:/remi-control', `${role}-seed:/remi-seed`];
    }
    model.services.feed = { image: bunBase, command: ['bun', '/feed/feed.ts'], volumes: [{ type: 'bind', source: root, target: '/feed', read_only: true }] };
    model.services.updater = { image: updaterImage, init: true, environment: { MULTIREMI_API_URL: 'http://api:6120', MULTIREMI_TOKEN: adminToken, MULTIREMI_PLATFORM_UPDATER_TOKEN: updaterToken,
      MULTIREMI_DATABASE_URL: 'postgresql://fixture@postgres:5432/fixture', MULTIREMI_PLATFORM_RELEASE_FEED_URL: feedUrl,
      MULTIREMI_PLATFORM_MIN_FREE_BYTES: '1', MULTIREMI_PLATFORM_VERIFY_TIMEOUT_MS: '10000', NODE_EXTRA_CA_CERTS: '/feed-cert.pem' },
      volumes: ['program:/remi-program', 'control:/remi-control', 'state:/remi-state', 'api-seed:/remi-seeds/api:ro', 'web-seed:/remi-seeds/web:ro',
        { type: 'bind', source: persistent, target: '/remi-data', read_only: true }, { type: 'bind', source: join(root, 'feed-cert.pem'), target: '/feed-cert.pem', read_only: true }] };
    model.services.rehearsal = { image: updaterImage, init: true, command: ['rehearsal'], network_mode: 'none',
      volumes: ['program:/remi-program:ro', 'control:/remi-control', 'state:/remi-state:ro'], tmpfs: ['/tmp:rw,nosuid,size=2g,mode=1777'] };
  }
  await save(composeFile, JSON.stringify(model));
  started = true; await compose(['up', '-d', '--pull', 'never']);
  const apiId = (await compose(['ps', '-q', 'api'])), webId = await compose(['ps', '-q', 'web']);
  const identity = (service: string) => docker(['inspect', '--format', '{{.Id}}|{{.Image}}|{{.State.StartedAt}}', `${project}-${service}-1`]);
  const daemonBefore = await identity('daemon'), pgBefore = await identity('postgres');
  const apiPort = JSON.parse(await docker(['inspect', '--format', '{{json .NetworkSettings.Ports}}', apiId]))['6120/tcp'][0].HostPort;
  const webPort = JSON.parse(await docker(['inspect', '--format', '{{json .NetworkSettings.Ports}}', webId]))['3000/tcp'][0].HostPort;
  const apiUrl = `http://127.0.0.1:${apiPort}`, webUrl = `http://127.0.0.1:${webPort}`;
  for (let attempt = 0; ; attempt++) {
    try { if ((await originalFetch(apiUrl + '/readyz')).ok) break; } catch {}
    if (attempt > 120) { console.error(await docker(['logs', '--tail', '50', apiId])); throw new Error('Fixture API did not start'); } await Bun.sleep(250);
  }
  const sql = (query: string) => docker(['exec', pgName, 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'fixture', '-d', 'fixture', '-c', query]);
  await sql("INSERT INTO sentinel VALUES(1,'original business data')");
  const schemaAt = async (path: string) => migrationFingerprint((await Promise.all(DATA_SCHEMA_INPUTS.map(file => readFile(join(path, file), 'utf8')))).join(''));
  const oldSchema = await schemaAt(apiRoot);
  const apiBase = migrationFingerprint((await Promise.all(API_BASE_INPUTS.map(file => readFile(join(apiRoot, file), 'utf8')))).join(''));
  const installedApi = await docker(['inspect', '--format', '{{.Image}}', apiId]), installedWeb = await docker(['inspect', '--format', '{{.Image}}', webId]);
  const previous = { version: '1.0.0', ref: '1'.repeat(40), dataSchema: oldSchema, apiImage: installedApi, webImage: installedWeb, publishedAt: null, releaseUrl: null, manifestUrl: null };
  await save(join(root, 'current-release.json'), JSON.stringify(previous));
  const apiLibc = await docker(['exec', apiId, 'getconf', 'GNU_LIBC_VERSION']), webLibc = await docker(['exec', webId, 'getconf', 'GNU_LIBC_VERSION']);
  const architecture = await docker(['exec', apiId, 'bun', '-p', 'process.arch']);
  const targetVersions: Record<string, string> = {};
  if (internal) {
    await mkdir(join(root, 'runtimes'));
    for (const [runtime, image] of [['bun', bunBase], ['node', nodeBase]]) {
      const id = await docker(['create', '--pull=never', '--network', 'none', '--entrypoint', '/usr/local/bin/' + runtime, image!, '--version']);
      try {
        await docker(['cp', '-L', id + ':/usr/local/bin/' + runtime, join(root, 'runtimes', runtime!)]);
        targetVersions[runtime!] = (await docker(['start', '-a', id])).replace(/^v/, '');
      } finally { await docker(['rm', id]); }
    }
    check(targetVersions.bun !== '1.3.13' && targetVersions.node !== '22.13.1', 'Runtime fixture must exercise different versions');
  }
  async function bundle(version: string, ref: string, broken = false): Promise<ApplicationManifest> {
    const directory = join(root, 'bundle-' + version); await mkdir(directory);
    await cp(apiRoot, join(directory, 'api'), { recursive: true }); await cp(join(root, 'web'), join(directory, 'web'), { recursive: true });
    await save(join(directory, 'api/packages/server/src/store/migrations.ts'), newMigration);
    if (broken) await save(join(directory, 'api/apps/server/main.ts'), "throw new Error('deliberately broken application fixture')");
    const application: ApplicationManifest['application'] = { format: 1, bun: '1.3.14', nodeMajor: 22, apiLibc, webLibc, apiBase, rollbackSafeFrom: [oldSchema], assets: {} };
    if (internal) {
      await save(join(directory, 'api/deploy/docker/Dockerfile.api'), `FROM ${bunBase}\nCOPY api /app\n`);
      Object.assign(application, { supervisor: 1, bun: targetVersions.bun, node: targetVersions.node, nodeMajor: Number(targetVersions.node!.split('.')[0]), ...await baseFingerprints(join(directory, 'api')) });
      await mkdir(join(directory, 'runtime'));
      await cp(join(root, 'runtimes/bun'), join(directory, 'runtime/bun'));
      await cp(join(root, 'runtimes/node'), join(directory, 'runtime/node'));
      await chmod(join(directory, 'runtime/bun'), 0o755); await chmod(join(directory, 'runtime/node'), 0o755);
    }
    const manifest = { ...previous, version, ref, dataSchema: await schemaAt(join(directory, 'api')), application };
    await save(join(directory, 'application.json'), JSON.stringify({ ...manifest, arch: architecture }));
    const name = 'application-' + version + '.tar.gz';
    await docker(['run', '--rm', '--pull=never', '--network', 'none', '--mount', `type=bind,src=${directory},dst=/source,readonly`, '--mount', `type=bind,src=${root},dst=/output`, '--entrypoint', 'tar', bunBase, '--format=posix', '-czf', '/output/' + name, '-C', '/source', 'application.json', 'api', 'web', ...(internal ? ['runtime'] : [])]);
    const path = join(root, name), url = new URL(name, feedUrl).href;
    application.assets[`linux-${architecture}`] = { url, sha256: createHash('sha256').update(await readFile(path)).digest('hex') };
    archives.set(url, path); return manifest;
  }
  const driver = new ContainerApplicationDriver({ kind: 'docker_compose', projectName: project, composeFile, envFile, stateDir: root, apiHealthUrl: apiUrl + '/readyz', webHealthUrl: webUrl + '/login', minimumFreeBytes: 1, verificationTimeoutMs: 10_000,
    backup: { directory: join(root, 'backups'), dataPaths: [persistent, composeFile, envFile], databaseDumpCommand: ['docker', 'exec', pgName, 'pg_dump', '-U', 'fixture', '-d', 'fixture', '-Fc'], databaseVerifyCommand: ['docker', 'run', '--rm', '-i', '--pull=never', '--network', 'none', '--entrypoint', 'pg_restore', pgBase, '--list'] },
  }, traced);
  const client = new PlatformUpdaterClient(apiUrl, adminToken, updaterToken);
  const worker = new PlatformUpdateWorker(client, driver, feedUrl);
  const adminHeaders = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };
  const status = async () => await (await originalFetch(webUrl + '/api/multiremi/platform/status', { headers: adminHeaders })).json() as MultiremiPlatformStatus;
  async function drive(operationId: string) {
    if (!internal) return worker.tick();
    const deadline = Date.now() + 8 * 60_000;
    while (Date.now() < deadline) {
      try {
        const state = await status();
        if (state.lastOperation?.id === operationId && ['succeeded', 'failed', 'cancelled', 'rolled_back'].includes(state.lastOperation.status)
          && (await originalFetch(apiUrl + '/write', { method: 'POST' })).status === 200) return;
      } catch {} // API and Web children restart; the updater container continues.
      await Bun.sleep(250);
    }
    console.error(await docker(['logs', '--tail', '80', `${project}-updater-1`]));
    console.error(await docker(['logs', '--tail', '30', `${project}-rehearsal-1`]));
    throw new Error('Internal updater failed to complete the queued operation');
  }
  async function queue(body: Record<string, unknown>) {
    const response = await originalFetch(webUrl + '/api/multiremi/platform/operations', { method: 'POST', headers: adminHeaders, body: JSON.stringify(body) });
    check(response.status === 202, `Internal update request failed: ${response.status} ${await response.clone().text()}`);
    return (await response.json() as { operation: MultiremiPlatformOperation }).operation;
  }
  const originalReport = client.report.bind(client);
  client.report = async (id, value) => {
    console.log('application phase:', value.status);
    if (['succeeded', 'failed'].includes(value.status) && (await driver.pendingFinalization())?.operationId === id) {
      check((await originalFetch(apiUrl + '/write', { method: 'POST' })).status === 503, 'Writes were admitted before terminal reporting');
    }
    await originalReport(id, value);
  };
  async function checkFromWeb(manifest: ApplicationManifest) {
    advertised = manifest;
    if (internal) await save(join(root, 'releases.json'), JSON.stringify({ latest: advertised }));
    const operation = await queue({ kind: 'check_updates' });
    await drive(operation.id);
    const state = await status();
    check(state.preflight?.ready, 'Internal preflight blocked: ' + JSON.stringify(state.preflight));
    check(state.updateMode === (internal ? 'internal_application' : 'host_application'), 'Actual updater mode was not reported through the API');
    check(state.preflight?.source?.modes.some(mode => mode.mode === state.updateMode && mode.available), 'Source artifacts do not match the reported updater mode');
    check(state.latestRelease?.manifestUrl === feedUrl, 'Custom feed without manifestUrl lost its internal update address');
    return state.latestRelease!;
  }
  async function updateFromWeb(manifest: ApplicationManifest, waitForTask = false) {
    const latest = await checkFromWeb(manifest);
    const body = { kind: 'update', requestId: randomUUID(), targetVersion: latest.version, targetRef: latest.manifestUrl ?? latest.ref };
    let taskId: string | undefined;
    if (waitForTask) {
      const response = await originalFetch(apiUrl + '/fixture/task', { method: 'POST', headers: adminHeaders });
      check(response.ok, 'Could not start isolated active-task fixture');
      taskId = (await response.json() as { id: string }).id;
    }
    const operation = await queue(body);
    check((await queue(body)).id === operation.id, 'Repeated internal request created a second operation');
    // The real host worker claims the persisted HTTP request, coordinates drain,
    // restarts this very API, then reports back through the recovered endpoint.
    const execution = drive(operation.id);
    if (taskId) {
      try {
        const deadline = Date.now() + 120_000;
        for (;;) {
          const state = await status();
          if (state.activeOperation?.status === 'draining') {
            check(await identity('daemon') === daemonBefore, 'Agent was interrupted during drain');
            check(await identity('api') === apiBefore, 'API restarted while a task was active');
            const progress = state.activeOperation.progress.drain as { active_tasks?: number } | undefined;
            check(Number(progress?.active_tasks) > 0, 'Drain did not report the active task');
            break;
          }
          check(state.activeOperation && Date.now() < deadline, 'Internal update failed to wait for active execution');
          await Bun.sleep(250);
        }
      } finally {
        await originalFetch(apiUrl + `/fixture/task/${taskId}/finish`, { method: 'POST', headers: adminHeaders });
        await execution;
      }
    } else await execution;
    const state = await status();
    check(!state.activeOperation && state.maintenance.mode === 'normal', 'Internal operation left maintenance held');
    check(state.lastOperation?.id === operation.id, 'API restart lost the internal operation');
    check((await queue(body)).id === operation.id, 'Retry after API restart duplicated the operation');
    return state.lastOperation!;
  }
  const apiBefore = await identity('api'), webBefore = await identity('web');
  const supervisorsBefore = internal ? await docker(['exec', apiId, 'cat', '/remi-control/api/status.json', '/remi-control/web/status.json']) : '';
  const denied = await originalFetch(webUrl + '/api/multiremi/platform/operations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'check_updates' }) });
  check(denied.status === 401, 'Internal update endpoint allowed an unauthenticated caller');
  const settings = await originalFetch(webUrl + '/api/multiremi/platform/settings', { method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ releaseFeedUrl: feedUrl }) });
  check(settings.ok, 'Could not configure source through the internal API');
  const first = await bundle('1.0.1', '2'.repeat(40));
  console.log('phase: bootstrap with existing base images');
  check((await updateFromWeb(first, true)).status === 'succeeded', 'Internally triggered bootstrap failed');
  const upgraded = await (await originalFetch(webUrl + '/api/verify')).json() as { version: string; rows: Array<{ value: string }> };
  check(upgraded.version === '1.0.1' && upgraded.rows[0]?.value === 'original business data', 'Web/API update or data continuity failed');
  const stableApi = await docker(['inspect', '--format', '{{.Id}}|{{.Image}}', `${project}-api-1`]);
  const stableWeb = await docker(['inspect', '--format', '{{.Id}}|{{.Image}}', `${project}-web-1`]);
  check(stableApi.endsWith(installedApi) && stableWeb.endsWith(installedWeb), 'Bootstrap changed a base image');
  await sql("INSERT INTO sentinel(id,value,note) VALUES(2,'write after update','retained')");
  console.log('phase: subsequent update without container replacement');
  const second = await bundle('1.0.2', '3'.repeat(40));
  check((await updateFromWeb(second)).status === 'succeeded', 'Internally triggered application update failed');
  check(await docker(['inspect', '--format', '{{.Id}}|{{.Image}}', `${project}-api-1`]) === stableApi, 'Subsequent update replaced API container/image');
  check(await docker(['inspect', '--format', '{{.Id}}|{{.Image}}', `${project}-web-1`]) === stableWeb, 'Subsequent update replaced Web container/image');
  console.log('phase: broken application rolls code back and preserves later writes');
  const broken = await bundle('1.0.3', '4'.repeat(40), true);
  check((await updateFromWeb(broken)).status === 'failed', 'Broken release unexpectedly succeeded');
  const recovered = await (await originalFetch(webUrl + '/api/verify')).json() as { version: string; rows: Array<{ value: string; note: string }> };
  check(recovered.version === '1.0.2' && recovered.rows[1]?.value === 'write after update' && recovered.rows[1]?.note === 'retained', 'Code rollback lost post-update data');
  check(await identity('daemon') === daemonBefore, 'Daemon process/container was interrupted');
  check(await identity('postgres') === pgBefore, 'Production database container was interrupted');
  if (internal) {
    check(await identity('api') === apiBefore && await identity('web') === webBefore, 'Internal update restarted or replaced a container');
    const before = supervisorsBefore.trim().split('\n').map(line => JSON.parse(line));
    const after = (await docker(['exec', apiId, 'cat', '/remi-control/api/status.json', '/remi-control/web/status.json'])).trim().split('\n').map(line => JSON.parse(line));
    check(after.every((value, index) => value.supervisorPid === before[index].supervisorPid && value.childPid !== before[index].childPid), 'Supervisor PID changed or application child did not change');
    for (const [index, role] of ['api', 'web'].entries()) {
      const executable = await docker(['exec', `${project}-${role}-1`, 'readlink', `/proc/${after[index].childPid}/exe`]);
      check(executable.startsWith('/remi-program/releases/') && executable.includes('/runtime/'), 'Application used the image runtime instead of the bundled runtime');
      const actualVersion = (await docker(['exec', `${project}-${role}-1`, `/proc/${after[index].childPid}/exe`, '--version'])).replace(/^v/, '');
      check(actualVersion === targetVersions[role === 'api' ? 'bun' : 'node'], 'Running application executable has the wrong version');
    }
    const mounts = await docker(['inspect', '--format', '{{json .Mounts}}', `${project}-updater-1`]);
    check(!mounts.includes('docker.sock'), 'Internal updater received a Docker socket');
    console.log('runtime changes:', JSON.stringify({ bun: ['1.3.13', targetVersions.bun], node: ['22.13.1', targetVersions.node] }));
    console.log('phase: explicit rollback retains data and restores previous runtimes');
    const rollback = await queue({ kind: 'rollback', requestId: randomUUID(), targetVersion: '1.0.0', targetRef: previous.ref });
    await drive(rollback.id);
    check((await status()).lastOperation?.status === 'rolled_back', 'Explicit rollback failed');
    const restored = await (await originalFetch(webUrl + '/api/verify')).json() as typeof recovered;
    check(restored.version === '1.0.0' && restored.rows[1]?.note === 'retained', 'Explicit rollback restored stale data');
    for (const [role, expected] of [['api', '1.3.13'], ['web', '22.13.1']]) {
      const state = JSON.parse(await docker(['exec', apiId, 'cat', `/remi-control/${role}/status.json`]));
      const version = (await docker(['exec', `${project}-${role}-1`, `/proc/${state.childPid}/exe`, '--version'])).replace(/^v/, '');
      check(version === expected, 'Explicit rollback did not restore the prior runtime');
    }
  }
  check(await readFile(join(persistent, 'transcript.txt'), 'utf8') === 'agent transcript must survive', 'Persistent transcript changed');
  check(Number(await docker(['exec', `${project}-daemon-1`, 'cat', '/tmp/heartbeat'])) > Date.now() - 5000, 'Agent heartbeat stopped');
  await new Promise<void>((ok, fail) => {
    const ws = new WebSocket(apiUrl.replace('http:', 'ws:') + '/ws');
    const timeout = setTimeout(() => { ws.close(); fail(new Error('WebSocket recovery failed')); }, 5000);
    ws.onmessage = event => { const value = JSON.parse(String(event.data)); if (value.type === 'auth_ack') ws.send('ping'); if (value.type === 'pong') { clearTimeout(timeout); ws.close(); ok(); } };
    ws.onerror = () => { clearTimeout(timeout); fail(new Error('WebSocket recovery failed')); };
  });
  check(!calls.some(args => args[0] === 'pull'), 'Updater pulled an image');
  console.log(JSON.stringify({ socketFreeInternalUpdater: internal, bundledRuntimesVerified: internal, runtimeVersionsChanged: internal, explicitRuntimeRollbackVerified: internal, unchangedSupervisors: internal, internalApiTriggerVerified: true, operationSurvivedApiRestart: true, activeTaskDrainVerified: true, applicationUpdated: true, unchangedBaseImages: true, unchangedContainersAfterBootstrap: true, failedReleaseRolledBack: true, postUpdateWritesPreserved: true, agentProcessUninterrupted: true, databaseContainerUninterrupted: true, webAndWebSocketVerified: true }));
} finally {
  globalThis.fetch = originalFetch;
  if (started) await compose(['down', '--volumes', '--remove-orphans']).catch(() => {});
  const volume = project + '_application-releases';
  const found = await docker(['volume', 'ls', '--format', '{{.Name}}', '--filter', `name=^${volume}$`]);
  if (found === volume) await docker(['volume', 'rm', volume]);
  if (builtApi) await docker(['image', 'rm', apiImage]).catch(() => {});
  if (builtWeb) await docker(['image', 'rm', webImage]).catch(() => {});
  if (builtUpdater) await docker(['image', 'rm', updaterImage]).catch(() => {});
  if (!isWithin(await realpath(tmpdir()), await realpath(root)) || !root.includes('remi-application-smoke-')) throw new Error('Refusing to clean unexpected fixture directory');
  await rm(root, { recursive: true, force: true });
}
