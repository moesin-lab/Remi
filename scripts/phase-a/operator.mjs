#!/usr/bin/env node
// Operator-only candidate preparation. Never requests Docker access for an agent.
import { mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { edgeStatus } from './support.mjs';

const action = process.argv[2];
const project = process.env.A5_PROJECT ?? 'remi-a5';
const port = Number(process.env.A5_API_PORT ?? 26120);
const webPort = Number(process.env.A5_WEB_PORT ?? 23000);
const data = resolve(process.env.A5_DATA_DIR ?? join(homedir(), '.local/share', project));
const evidence = join(data, 'evidence');
const canonicalData = await realpath(data).catch(error => { if (error.code !== 'ENOENT') throw error; return data; });
if (!/^remi-a5(?:-[a-z0-9-]+)?$/.test(project) || [port, webPort].some(p => !Number.isInteger(p) || p < 1024 || p > 65535 || [16120, 13000].includes(p)) || port === webPort
  || /(^|[\\/])(?:stable|remi-stable)([\\/]|$)/i.test(canonicalData)) throw new Error('Use an isolated remi-a5 project, directory and ports');
const secret = () => randomBytes(32).toString('hex');
const privateWrite = (name, value) => writeFile(join(data, name), value, { mode: 0o600, flag: 'wx' });
if (action === 'init') {
  const source = await realpath(process.env.A5_SOURCE_DIR ?? '.');
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
  if (!/^[a-f0-9]{40}$/.test(process.env.A5_MERGED_SHA ?? '') || sha !== process.env.A5_MERGED_SHA) throw new Error('A5_SOURCE_DIR HEAD must equal A4 final A5_MERGED_SHA');
  await readFile(join(source, 'packages/platform-updater/src/slot-supervisor.mjs'));
  execFileSync('git', ['merge-base', '--is-ancestor', '27a7d7cc2', sha], { cwd: source });
  if (execFileSync('git', ['status', '--porcelain'], { cwd: source, encoding: 'utf8' }).trim()) throw new Error('Candidate source must be clean');
  if ([source, data].some(p => /[\s$#"'\\]/.test(p))) throw new Error('Use simple absolute source/data paths without whitespace or shell characters');
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  await mkdir(join(data, 'control'), { mode: 0o700 });
  const token = secret(), updater = secret();
  await privateWrite('api.env', `MULTIREMI_TOKEN=${token}\nJWT_SECRET=${secret()}\nMULTIREMI_SHARE_SECRET=${secret()}\nMULTIREMI_PLATFORM_UPDATER_TOKEN=${updater}\n`);
  await privateWrite('updater.env', `MULTIREMI_TOKEN=${token}\nMULTIREMI_PLATFORM_UPDATER_TOKEN=${updater}\n`);
  const env = { COMPOSE_PROJECT_NAME: project, POSTGRES_PASSWORD: secret(), REMI_SOURCE_DIR: source,
    REMI_API_IMAGE: `${project}-api:${sha}`, REMI_WEB_IMAGE: `${project}-web:${sha}`, REMI_UPDATER_IMAGE: `${project}-updater:${sha}`,
    REMI_APP_VERSION: `a5-${sha.slice(0, 12)}`, REMI_BUILD_REF: sha, REMI_PROFILE: 'dev', REMI_BIND_ADDRESS: '127.0.0.1',
    REMI_API_BIND_PORT: port, REMI_WEB_BIND_PORT: webPort, REMI_PUBLIC_URL: `http://127.0.0.1:${webPort}`,
    REMI_PUBLIC_WS_URL: `ws://127.0.0.1:${port}/ws`, REMI_DAEMON_SERVER_URL: `http://127.0.0.1:${port}`,
    REMI_API_ENV_FILE: join(data, 'api.env'), REMI_UPDATER_ENV_FILE: join(data, 'updater.env') };
  await privateWrite('compose.env', Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  await privateWrite('candidate.compose.json', JSON.stringify({ services: { api: { environment: { REMI_SLOT_SWITCH: '1', MUL172_ISOLATED: '1' } } },
    volumes: { 'update-control': { driver: 'local', driver_opts: { type: 'none', o: 'bind', device: join(data, 'control') } } } }, null, 2));
  await privateWrite('environment.json', JSON.stringify({ project, port, webPort, source, sha, controlDir: join(data, 'control/api'),
    scope: 'Preparation only; operator must verify final A4 merge, release installation and provider setup', phaseAAccepted: false }, null, 2));
  console.log(`Prepared ${data}. Before up, Operator must grant candidate runtime UID 1000 ownership of control only. No Docker command executed.`);
} else if (['build', 'up', 'collect'].includes(action)) {
  const setup = JSON.parse(await readFile(join(data, 'environment.json'), 'utf8'));
  if (setup.project !== project || setup.port !== port || setup.webPort !== webPort) throw new Error('Parameters differ from initialized candidate');
  const args = ['compose', '--env-file', join(data, 'compose.env'), '-p', project,
    '-f', join(setup.source, 'deploy/docker/compose.local.yml'), '-f', join(setup.source, 'deploy/docker/compose.internal-updates.yml'), '-f', join(data, 'candidate.compose.json')];
  const docker = extra => execFileSync('docker', [...args, ...extra], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (action === 'build') {
    if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: setup.source, encoding: 'utf8' }).trim() !== setup.sha
      || execFileSync('git', ['status', '--porcelain'], { cwd: setup.source, encoding: 'utf8' }).trim()) throw new Error('Candidate source changed after init');
    process.stdout.write(docker(['build', 'api', 'web', 'updater']));
  } else if (action === 'up') process.stdout.write(docker(['up', '-d']));
  else {
    await mkdir(evidence, { recursive: true, mode: 0o700 });
    const errors = [];
    const collect = async (name, fn) => { try { await writeFile(join(evidence, name), await fn(), { mode: 0o600 }); } catch { errors.push(name); } };
    await collect('compose-images.json', () => docker(['images', '--format', 'json']));
    await collect('compose-ps.json', () => docker(['ps', '--format', 'json']));
    // Raw logs can contain application data: operator reviews these before uploading.
    await collect('candidate-logs.private.txt', () => docker(['logs', '--no-color', '--tail', '2000']));
    for (const name of ['status.json', 'slot-selection.json']) await collect(name, () => readFile(join(data, 'control/api', name)));
    await collect('edge.json', async () => JSON.stringify(await edgeStatus(join(data, 'control/api')), null, 2));
    await collect('environment.json', () => readFile(join(data, 'environment.json')));
    await writeFile(join(evidence, 'collection.json'), JSON.stringify({ at: new Date().toISOString(), missing: errors }, null, 2), { mode: 0o600 });
    console.log(`Evidence in ${evidence}; missing: ${errors.join(', ') || 'none'}. Review private logs before sharing.`);
    if (errors.length) process.exitCode = 1;
  }
} else throw new Error('Usage: node scripts/phase-a/operator.mjs init|build|up|collect (A5_PROJECT/A5_API_PORT/A5_WEB_PORT/A5_DATA_DIR/A5_SOURCE_DIR/A5_MERGED_SHA)');
