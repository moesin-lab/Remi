#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, openSync, closeSync, fsyncSync, realpathSync, unlinkSync, renameSync, readdirSync, rmSync, statSync, statfsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, delimiter, relative, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { isIPv4 } from 'node:net';
import { loadCiImages } from './ci-images.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profilesRoot = resolve(process.env.REMI_PROFILES_ROOT || join(homedir(), '.remi', 'profiles'));
const settings = {
  stable: { webPort: 13000, apiPort: 16120, hostname: '127.0.0.1', backgroundJobs: '1' },
  dev: { webPort: 14000, apiPort: 16220, hostname: 'localhost', backgroundJobs: '0' },
};

function canonicalPath(path) {
  if (existsSync(path)) return realpathSync(path);
  return join(canonicalPath(dirname(path)), basename(path));
}

function validateProfilesRoot() {
  const path = relative(realpathSync(repository), canonicalPath(profilesRoot));
  if (!path || (!path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && path !== '..' && !isAbsolute(path))) {
    throw new Error('REMI_PROFILES_ROOT must be outside the source repository, including through symbolic links');
  }
}

function execute(command, args, options = {}) {
  const environment = { ...process.env };
  if (command === 'docker') {
    // Shell variables override Compose --env-file. Never let a previous profile
    // or a remote Docker session silently redirect this local operation.
    for (const key of Object.keys(environment)) {
      if (/^(REMI_|MULTIREMI_|POSTGRES_|COMPOSE_)/iu.test(key)
        || /^(DOCKER_HOST|DOCKER_CONTEXT|DOCKER_CONFIG|DOCKER_TLS_VERIFY|DOCKER_CERT_PATH|BUILDX_CONFIG|BUILDX_BUILDER|BUILDKIT_HOST)$/iu.test(key)) delete environment[key];
    }
    args = ['--context', process.platform === 'win32' ? 'desktop-linux' : 'default', ...args];
  }
  // Docker Desktop's credential helper is not always on a PowerShell PATH.
  if (process.platform === 'win32') {
    const helpers = join(process.env.ProgramFiles || 'C:/Program Files', 'Docker', 'Docker', 'resources', 'bin');
    const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === 'path') || 'Path';
    environment[pathKey] = `${helpers}${delimiter}${environment[pathKey] || ''}`;
  }
  const { preserveWhitespace = false, ...spawnOptions } = options;
  const result = spawnSync(command, args, { cwd: repository, env: environment, stdio: 'inherit', windowsHide: true, ...spawnOptions });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args[0] || ''} failed (${result.status})`);
  return typeof result.stdout === 'string' && !preserveWhitespace ? result.stdout.trim() : result.stdout;
}

function capture(command, args) {
  return execute(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function savePrivateFile(path, contents) {
  const temporary = `${path}.tmp-${process.pid}`;
  const descriptor = openSync(temporary, 'w', 0o600);
  try {
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
  renameSync(temporary, path);
}

function saveJson(path, value) { savePrivateFile(path, `${JSON.stringify(value, null, 2)}\n`); }

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function secret() { return randomBytes(32).toString('hex'); }

function validateLanHost(hostname) {
  const [a, b] = hostname.split('.').map(Number);
  if (!isIPv4(hostname) || !(a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))) {
    throw new Error('--lan-host must be a private IPv4 address of this machine, not a URL, loopback, or 0.0.0.0');
  }
  return hostname;
}

function networkSettings(deployment) {
  return deployment.network ?? { hostname: settings[deployment.profile].hostname, bindAddress: '127.0.0.1' };
}

function envValue(value) {
  const text = String(value).replaceAll('\\', '/');
  if (/[\r\n']/u.test(text)) throw new Error('Profile paths and values cannot contain newlines or single quotes');
  return `'${text}'`;
}

function initialize(profile) {
  const root = join(profilesRoot, profile);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'backups'), { recursive: true, mode: 0o700 });
  const credentials = join(root, 'credentials.json');
  if (!existsSync(credentials)) {
    saveJson(credentials, { databasePassword: secret() });
  }
  const apiEnv = join(root, 'api.env');
  if (!existsSync(apiEnv)) {
    writeFileSync(apiEnv, [
      '# Local profile credentials. Keep outside Git; never copy stable credentials into dev.',
      `MULTIREMI_TOKEN=${secret()}`, `JWT_SECRET=${secret()}`, `MULTIREMI_SHARE_SECRET=${secret()}`,
      `MULTIREMI_SCM_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`,
      'MULTIREMI_ALLOW_EMAIL_CODE_LOGIN=0', 'ANALYTICS_DISABLED=true', '',
    ].join('\n'), { mode: 0o600 });
  }
  return root;
}

function composeArgs(root, ...args) {
  const deployment = readJson(join(root, 'deployment.json'));
  if (!Object.hasOwn(settings, deployment.profile) || resolve(root) !== resolve(profilesRoot, deployment.profile)) {
    throw new Error('Profile metadata does not match its directory; refusing to operate on another environment');
  }
  const flags = ['compose', '-p', `remi-${deployment.profile}`, '--env-file', join(root, 'compose.env'), '-f', join(root, 'compose.yml')];
  if (deployment.profile === 'dev') flags.push('-f', join(root, 'compose.dev.yml'));
  if (deployment.profile === 'stable' && existsSync(join(root, 'compose.host-control.yml'))) flags.push('-f', join(root, 'compose.host-control.yml'));
  if (deployment.profile === 'stable' && existsSync(join(root, 'compose.application.json'))) flags.push('-f', join(root, 'compose.application.json'));
  if (deployment.profile === 'stable' && existsSync(join(root, 'compose.internal-updates.yml'))) {
    if (existsSync(join(root, 'compose.application.json')) || existsSync(join(root, 'compose.host-control.yml'))) throw new Error('Internal updates cannot be combined with host updater overlays');
    flags.push('-f', join(root, 'compose.internal-updates.yml'));
  }
  if (deployment.profile === 'stable' && args[0] === 'up' && !args.includes('--build')) args = [args[0], '--no-build', ...args.slice(1)];
  return [...flags, ...args];
}

function compose(root, ...args) { return execute('docker', composeArgs(root, ...args)); }

function writeComposeEnvironment(root, deployment) {
  const config = settings[deployment.profile];
  const network = networkSettings(deployment);
  const credentials = readJson(join(root, 'credentials.json'));
  const variables = {
    REMI_PROFILE: deployment.profile,
    POSTGRES_PASSWORD: credentials.databasePassword,
    REMI_API_ENV_FILE: join(root, 'api.env'),
    REMI_SOURCE_DIR: deployment.source,
    REMI_API_IMAGE: deployment.apiImage,
    REMI_WEB_IMAGE: deployment.webImage,
    REMI_BUILD_REF: deployment.ref,
    REMI_APP_VERSION: deployment.version,
    REMI_PUBLIC_URL: `http://${network.hostname}:${config.webPort}`,
    REMI_PUBLIC_WS_URL: `ws://${network.hostname}:${config.apiPort}/ws`,
    REMI_DAEMON_SERVER_URL: `http://${network.hostname}:${config.apiPort}`,
    REMI_BIND_ADDRESS: network.bindAddress,
    REMI_API_BIND_PORT: config.apiPort,
    REMI_WEB_BIND_PORT: config.webPort,
    REMI_BACKGROUND_JOBS: config.backgroundJobs,
  };
  writeFileSync(join(root, 'compose.env'), Object.entries(variables).map(([key, value]) => `${key}=${envValue(value)}`).join('\n') + '\n', { mode: 0o600 });
}

function prepare(profile, ref, lanHost) {
  const root = initialize(profile);
  const previous = existsSync(join(root, 'deployment.json')) ? readJson(join(root, 'deployment.json')) : { profile };
  const network = lanHost
    ? { hostname: validateLanHost(lanHost), bindAddress: '0.0.0.0' }
    : profile === 'dev' ? { hostname: settings.dev.hostname, bindAddress: '127.0.0.1' } : networkSettings(previous);
  const managedFiles = ['deployment.json', 'compose.env', 'compose.yml', 'compose.dev.yml'];
  const original = new Map(managedFiles.map((name) => [name, existsSync(join(root, name)) ? readFileSync(join(root, name)) : null]));
  const sha = capture('git', ['rev-parse', '--verify', `${ref}^{commit}`]);
  if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error('A full Git commit is required');
  let source = repository;
  if (profile === 'stable') {
    source = join(root, 'releases', sha);
    if (!existsSync(join(source, '.remi-profile-source'))) {
      mkdirSync(source, { recursive: true });
      const archive = join(root, 'releases', `${sha}.tar`);
      execute('git', ['archive', '--format=tar', '--output', archive, sha]);
      execute('tar', ['-xf', archive, '-C', source]);
      writeFileSync(join(source, '.remi-profile-source'), `${sha}\n`);
    }
  }
  const version = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version;
  const buildId = profile === 'stable' ? sha : 'working-tree';
  const deployment = {
    profile, ref: sha, source, network, version: `${version}-${profile}.${sha.slice(0, 8)}`,
    apiImage: `remi-api:${profile}-${buildId}`, webImage: `remi-web:${profile}-${buildId}`,
  };
  copyFileSync(join(repository, 'deploy/docker/compose.local.yml'), join(root, 'compose.yml'));
  if (profile === 'dev') copyFileSync(join(repository, 'deploy/docker/compose.local-dev.yml'), join(root, 'compose.dev.yml'));
  saveJson(join(root, 'deployment.json'), deployment);
  writeComposeEnvironment(root, deployment);
  // Quiet validation: docker compose config without -q prints environment secrets.
  try { compose(root, 'config', '--quiet'); }
  catch (error) {
    for (const [name, contents] of original) {
      if (contents) writeFileSync(join(root, name), contents);
      else if (existsSync(join(root, name))) unlinkSync(join(root, name));
    }
    throw error;
  }
  return root;
}

function backup(root, operationId = null) {
  const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const backupDir = join(root, 'backups', timestamp);
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  for (const name of ['api.env', 'credentials.json', 'compose.env', 'deployment.json', 'active.json', 'compose.yml', 'compose.dev.yml']) {
    if (existsSync(join(root, name))) copyFileSync(join(root, name), join(backupDir, name));
  }
  // Persist immutable image identities with the matching data snapshot. A tag
  // alone cannot prove that a later rollback is running the backed-up code.
  const deployment = withImageIdentities(readJson(join(root, 'deployment.json')));
  saveJson(join(backupDir, 'deployment.json'), deployment);
  saveJson(join(backupDir, 'active.json'), deployment);
  const db = openSync(join(backupDir, 'postgres.dump'), 'w', 0o600);
  try {
    execute('docker', composeArgs(root, 'exec', '-T', 'postgres', 'pg_dump', '-U', 'multiremi', '-d', 'multiremi', '-Fc'), { stdio: ['ignore', db, 'inherit'] });
  } finally { closeSync(db); }
  const controlPlane = openSync(join(backupDir, 'control-plane.dump'), 'w', 0o600);
  try {
    execute('docker', composeArgs(root, 'exec', '-T', 'postgres', 'pg_dump', '-U', 'multiremi', '-d', 'multiremi', '-Fc',
      '--table=public.multiremi_platform_operations', '--table=public.multiremi_platform_maintenance', '--table=public.multiremi_platform_state'),
    { stdio: ['ignore', controlPlane, 'inherit'] });
  } finally { closeSync(controlPlane); }
  const apiFiles = openSync(join(backupDir, 'api-home.tar'), 'w', 0o600);
  try {
    const deployment = readJson(join(root, 'deployment.json'));
    execute('docker', ['run', '--rm', '--network', 'none', '--mount', `type=volume,src=remi-${deployment.profile}_api-home,dst=/backup,readonly`, '--entrypoint', 'tar', deployment.apiImage, '-C', '/backup', '-cf', '-', '.'], { stdio: ['ignore', apiFiles, 'inherit'] });
  } finally { closeSync(apiFiles); }
  const files = {};
  for (const name of readdirSync(backupDir)) {
    if (name === 'complete.json') continue;
    const path = join(backupDir, name);
    if (!statSync(path).isFile()) continue;
    files[name] = { size: statSync(path).size, sha256: fileSha256(path) };
  }
  saveJson(join(backupDir, 'complete.json'), {
    schemaVersion: 2,
    completedAt: new Date().toISOString(),
    operationId,
    files,
    restoreCommand: `node scripts/local-profile.mjs ${deployment.profile} host-rollback-stage --operation-id <new-operation-id> --ref ${deployment.ref}`,
  });
  console.log(`Backup: ${backupDir}`);
  return backupDir;
}

const managedProfileFiles = ['api.env', 'credentials.json', 'compose.env', 'deployment.json', 'active.json', 'compose.yml', 'compose.dev.yml'];
const switchPhases = new Set(['switching', 'backup_complete', 'activating', 'rolling_back']);
const updaterAuthKeys = ['MULTIREMI_TOKEN', 'MULTIREMI_PLATFORM_UPDATER_TOKEN'];

function validateUpdaterAuth(values) {
  for (const key of updaterAuthKeys) {
    if (typeof values[key] !== 'string' || !values[key].trim() || /[\r\n\0]/u.test(values[key])) {
      throw new Error(`Host updater credential ${key} is missing or invalid`);
    }
  }
  return values;
}

function readHostUpdaterAuth(path) {
  // Match Compose env_file format: raw. Dotenv parsing would strip a '#' or
  // quotes from opaque credential values that must be preserved byte-for-byte.
  return Object.fromEntries(readFileSync(path, 'utf8').split(/\r?\n/u).filter(Boolean).map((line) => {
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error('The captured host updater credentials are invalid');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

function captureHostUpdaterAuth(root, operationId, refreshFromProfile = false) {
  const controlRoot = join(root, 'host-control');
  const authPath = join(controlRoot, 'updater-auth.env');
  const receiptPath = join(controlRoot, 'auth-operation.json');
  mkdirSync(controlRoot, { recursive: true, mode: 0o700 });
  if (!refreshFromProfile && existsSync(receiptPath) && readJson(receiptPath).operationId === operationId) {
    // The profile may already contain historic credentials after restore. A
    // resumed operation must use the durable pre-switch capture, or fail shut.
    if (!existsSync(authPath)) throw new Error('The captured host updater credentials are missing');
    validateUpdaterAuth(readHostUpdaterAuth(authPath));
    return authPath;
  }
  const fromProfile = parseEnv(readFileSync(join(root, 'api.env'), 'utf8'));
  const currentOverlay = !refreshFromProfile && existsSync(authPath) ? readHostUpdaterAuth(authPath) : {};
  // Compose reads this env_file last, so its values are the actual effective
  // credentials even after a rollback has restored an older api.env.
  const effective = validateUpdaterAuth({ ...fromProfile, ...currentOverlay });
  savePrivateFile(authPath, updaterAuthKeys.map((key) => `${key}=${effective[key]}`).join('\n') + '\n');
  saveJson(receiptPath, { operationId, capturedAt: new Date().toISOString() });
  return authPath;
}

function installHostWriteFence(root, operationId) {
  const controlRoot = join(root, 'host-control');
  const marker = join(controlRoot, 'write-fence.json');
  if (existsSync(marker) && readJson(marker).operationId !== operationId) {
    throw new Error('Another host operation still owns the write fence');
  }
  mkdirSync(controlRoot, { recursive: true, mode: 0o700 });
  const authPath = captureHostUpdaterAuth(root, operationId);
  copyFileSync(join(repository, 'deploy/docker/host-write-fence.ts'), join(controlRoot, 'host-write-fence.ts'));
  // This host-owned mount survives restoring old application configuration and
  // works with older API images that predate the in-process maintenance guard.
  const override = {
    services: {
      api: {
        env_file: [{ path: authPath.replaceAll('\\', '/'), format: 'raw' }],
        volumes: [{ type: 'bind', source: controlRoot.replaceAll('\\', '/'), target: '/remi-host', read_only: true }],
        command: ['bun', 'run', '--preload', '/remi-host/host-write-fence.ts', 'apps/server/main.ts', 'serve'],
      },
    },
  };
  saveJson(join(root, 'compose.host-control.yml'), override);
  saveJson(marker, { operationId });
}

function hostAuthRefresh(profile) {
  if (profile !== 'stable') throw new Error('The recoverable host executor only manages the stable profile');
  const root = join(profilesRoot, profile);
  const release = acquireHostLock(root);
  try {
    if (existsSync(join(root, 'host-control', 'write-fence.json'))) throw new Error('Cannot rotate host updater credentials during a fenced operation');
    if (!existsSync(join(root, 'compose.host-control.yml'))) throw new Error('Host control must be installed before refreshing its credentials');
    captureHostUpdaterAuth(root, null, true);
  } finally { release(); }
}

function hostFinalize(profile, flags) {
  if (profile !== 'stable') throw new Error('The recoverable host executor only manages the stable profile');
  const operationId = safeOperationId(flags['--operation-id']);
  const root = join(profilesRoot, profile);
  const release = acquireHostLock(root);
  try {
    const state = readJson(operationPath(root, operationId));
    if (!['succeeded', 'rolled_back', 'failed', 'cancelled'].includes(state.status)) {
      throw new Error('Host operation is not terminal; its write fence must remain installed');
    }
    const marker = join(root, 'host-control', 'write-fence.json');
    if (!existsSync(marker)) return;
    if (readJson(marker).operationId !== operationId) throw new Error('Host operation does not own the write fence');
    unlinkSync(marker);
  } finally { release(); }
}

function fileSha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function safeOperationId(value) {
  if (!/^[A-Za-z0-9_-]{3,128}$/u.test(value || '')) throw new Error('--operation-id is invalid');
  return value;
}

function operationDirectory(root, operationId) {
  const base = join(root, 'host-operations');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const directory = resolve(base, safeOperationId(operationId));
  if (dirname(directory) !== resolve(base)) throw new Error('Operation path escapes the profile root');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function operationPath(root, operationId) {
  return join(operationDirectory(root, operationId), 'operation.json');
}

function saveOperation(root, state, change = {}) {
  const next = { ...state, ...change, updatedAt: new Date().toISOString() };
  saveJson(operationPath(root, next.operationId), next);
  return next;
}

function snapshotProfile(root, destination) {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const files = managedProfileFiles.filter((name) => existsSync(join(root, name)));
  for (const name of files) copyFileSync(join(root, name), join(destination, name));
  saveJson(join(destination, 'files.json'), { files });
}

function restoreProfileSnapshot(root, source) {
  const { files } = readJson(join(source, 'files.json'));
  for (const name of managedProfileFiles) {
    const target = join(root, name);
    if (existsSync(target)) unlinkSync(target);
  }
  for (const name of files) copyFileSync(join(source, name), join(root, name));
}

function acquireHostLock(root) {
  const path = join(root, 'host-update.lock');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(path, 'wx', 0o600);
      writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
      return () => {
        try { closeSync(descriptor); } catch {}
        try { unlinkSync(path); } catch {}
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let active = true;
      try {
        const pid = Number(readJson(path).pid);
        process.kill(pid, 0);
      } catch (probe) {
        active = probe?.code === 'EPERM';
      }
      if (active) throw new Error('Another local-profile host operation holds the lock');
      unlinkSync(path);
    }
  }
  throw new Error('Unable to acquire the local-profile host lock');
}

function validateHostCapacity(root) {
  const minimum = Number(process.env.REMI_HOST_MIN_FREE_BYTES || 5 * 1024 * 1024 * 1024);
  const stats = statfsSync(root);
  const available = Number(stats.bavail) * Number(stats.bsize);
  if (!Number.isFinite(minimum) || minimum < 1) throw new Error('REMI_HOST_MIN_FREE_BYTES is invalid');
  if (available < minimum) throw new Error(`Insufficient disk space: ${available} bytes available, ${minimum} required`);
  const expected = (process.env.REMI_HOST_EXPECTED_ARCH || process.arch).toLowerCase();
  const actual = process.arch.toLowerCase();
  const aliases = { amd64: 'x64', x86_64: 'x64', aarch64: 'arm64' };
  if ((aliases[expected] || expected) !== (aliases[actual] || actual)) {
    throw new Error(`Host architecture ${actual} does not match required ${expected}`);
  }
  const dockerArchitecture = capture('docker', ['info', '--format', '{{.Architecture}}']).trim().toLowerCase();
  if (dockerArchitecture && (aliases[dockerArchitecture] || dockerArchitecture) !== (aliases[expected] || expected)) {
    throw new Error(`Docker architecture ${dockerArchitecture} does not match required ${expected}`);
  }
}

async function validateReleaseArtifact(url, expectedSha256) {
  const parsed = validateReleaseArtifactInput(url, expectedSha256);
  const response = await fetch(parsed, { signal: AbortSignal.timeout(120_000) });
  const ok = response.ok ?? (response.status >= 200 && response.status < 300);
  if (!ok) throw new Error(`Release source returned HTTP ${response.status}`);
  const digest = createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
  if (digest !== expectedSha256.toLowerCase()) throw new Error('Release source checksum mismatch');
}

function validateReleaseArtifactInput(url, expectedSha256) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Release source URL is invalid'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Release source URL must use HTTPS without credentials, query, or fragment');
  }
  if (!/^[a-f0-9]{64}$/iu.test(expectedSha256 || '')) throw new Error('Release source SHA-256 is invalid');
  return parsed;
}

function profileSchema(ref) {
  if (!/^[a-f0-9]{40}$/iu.test(ref || '')) throw new Error('Data schema requires an immutable commit');
  const inputs = readJson(join(repository, 'packages/platform-updater/src/data-schema-inputs.json'));
  const source = inputs.map(path => execute('git', ['show', `${ref}:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], preserveWhitespace: true })).join('').replaceAll('\r\n', '\n');
  if (!source) throw new Error('Data schema source is unavailable');
  return createHash('sha256').update(source).digest('hex');
}

function resultRelease(deployment) {
  return {
    dataSchema: deployment.dataSchema ?? null,
    version: deployment.version.split('-stable.')[0],
    ref: deployment.ref,
    publishedAt: new Date().toISOString(),
    releaseUrl: null,
    manifestUrl: null,
    apiImage: deployment.apiImage,
    webImage: deployment.webImage,
  };
}

async function verifyProfileHealth(profile) {
  const root = join(profilesRoot, profile);
  verifyServiceImages(root, false);
  const config = settings[profile];
  for (const [service, url] of [['api', `http://127.0.0.1:${config.apiPort}/readyz`], ['web', `http://127.0.0.1:${config.webPort}/login`]]) {
    let last = `${service} did not become ready`;
    for (let attempt = 0; attempt < 24; attempt += 1) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
        const ok = response.ok ?? (response.status >= 200 && response.status < 300);
        if (ok) { last = ''; break; }
        last = `${service} returned HTTP ${response.status}`;
      } catch (error) { last = error.message; }
      await new Promise((resolveWait) => setTimeout(resolveWait, 2_500));
    }
    if (last) throw new Error(last);
  }
  // `restart` returns before Docker's next health probe, unlike compose up
  // --wait. Allow that probe to catch up after both HTTP endpoints are ready.
  for (let attempt = 0; attempt < 24; attempt += 1) {
    try { verifyServiceImages(root); return; }
    catch (error) {
      if (attempt === 23) throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 2_500));
    }
  }
}

function withImageIdentities(deployment) {
  const next = { ...deployment };
  for (const service of ['api', 'web']) {
    const id = capture('docker', ['image', 'inspect', '--format', '{{.Id}}', deployment[`${service}Image`]]);
    if (!/^sha256:[a-f0-9]{64}$/u.test(id)) throw new Error(`${service} image is unavailable or has an invalid identity`);
    if (deployment[`${service}ImageId`] && deployment[`${service}ImageId`] !== id) {
      throw new Error(`${service} image no longer matches the recorded release`);
    }
    next[`${service}ImageId`] = id;
  }
  return next;
}

function assertReleaseImageRevision(deployment, service) {
  const image = deployment[`${service}Image`];
  const labels = JSON.parse(capture('docker', ['image', 'inspect', '--format', '{{json .Config.Labels}}', image]));
  if (labels?.['org.opencontainers.image.revision'] !== deployment.ref) {
    throw new Error(`${service} image ${image} revision does not match the requested commit; refusing to overwrite a fixed release tag`);
  }
}

function buildMissingReleaseImages(root, deployment) {
  const missing = [];
  for (const service of ['api', 'web']) {
    const image = deployment[`${service}Image`];
    // Listing distinguishes an absent image (successful empty response) from
    // Docker/permission errors. Never treat a failed inspection as cache miss.
    const cached = capture('docker', ['image', 'ls', '--quiet', '--no-trunc', '--filter', `reference=${image}`]);
    if (cached) assertReleaseImageRevision(deployment, service);
    else missing.push(service);
  }
  // Validate every existing tag before building anything. Rebuilding a fixed
  // commit tag could change the image ID already recorded by an older backup.
  if (missing.length > 0) compose(root, 'build', ...missing);
  for (const service of ['api', 'web']) assertReleaseImageRevision(deployment, service);
}

function prepareDeploymentImages(root, flags) {
  const deployment = readJson(join(root, 'deployment.json'));
  if (deployment.profile !== 'stable' || flags['--build-local'] === 'true') {
    buildMissingReleaseImages(root, deployment);
    return deployment;
  }
  const manifest = loadCiImages({ deployment, manifestPath: flags['--image-manifest'], root, capture, execute });
  if (manifest.version !== deployment.version) throw new Error('CI image version does not match the commit package version');
  const candidate = { ...deployment, apiImage: manifest.apiImage, webImage: manifest.webImage, imageSource: 'ci' };
  for (const service of ['api', 'web']) {
    execute('docker', ['pull', candidate[`${service}Image`]]);
    assertReleaseImageRevision(candidate, service);
  }
  const labels = JSON.parse(capture('docker', ['image', 'inspect', '--format', '{{json .Config.Labels}}', candidate.webImage]));
  if (labels['io.remi.local-profile.hostname'] !== networkSettings(deployment).hostname) throw new Error('CI Web image hostname label mismatch');
  const verified = withImageIdentities(candidate);
  saveJson(join(root, 'deployment.json'), verified);
  writeComposeEnvironment(root, verified);
  return verified;
}

function verifyServiceImages(root, requireHealthy = true) {
  const deployment = withImageIdentities(readJson(join(root, 'deployment.json')));
  for (const service of ['api', 'web']) {
    const ids = capture('docker', composeArgs(root, 'ps', '--all', '--quiet', service)).split(/\r?\n/u).filter(Boolean);
    if (ids.length !== 1) throw new Error(`${service} must have exactly one running container`);
    const image = JSON.parse(capture('docker', ['inspect', '--format', '{{json .Image}}', ids[0]]));
    const state = JSON.parse(capture('docker', ['inspect', '--format', '{{json .State}}', ids[0]]));
    if (image !== deployment[`${service}ImageId`]) throw new Error(`${service} container is running a different release image`);
    if (!state.Running || (requireHealthy && state.Health?.Status !== 'healthy')) throw new Error(`${service} container is not healthy`);
  }
}

function verifyCompleteBackup(backupDir) {
  const marker = readJson(join(backupDir, 'complete.json'));
  if (marker.schemaVersion !== 2 || !marker.files || typeof marker.files !== 'object') {
    throw new Error(`Backup ${backupDir} lacks a verifiable v2 completion manifest`);
  }
  for (const [name, expected] of Object.entries(marker.files)) {
    if (!/^[A-Za-z0-9.-]+$/u.test(name) || dirname(resolve(backupDir, name)) !== resolve(backupDir)) {
      throw new Error('Backup completion manifest contains an invalid file name');
    }
    const path = join(backupDir, name);
    if (!existsSync(path) || statSync(path).size !== expected.size || fileSha256(path) !== expected.sha256) {
      throw new Error(`Backup integrity check failed for ${name}`);
    }
  }
  for (const required of ['postgres.dump', 'api-home.tar', 'deployment.json', 'active.json', 'api.env', 'credentials.json', 'compose.env', 'compose.yml']) {
    if (!marker.files[required] || marker.files[required].size < 1) throw new Error(`Backup completion manifest is missing or empty: ${required}`);
  }
  return marker;
}

function checkedBackupDirectory(root, backupDir) {
  const backupsRoot = resolve(root, 'backups');
  const resolvedBackup = resolve(backupDir);
  if (dirname(resolvedBackup) !== backupsRoot) throw new Error('Backup path escapes the profile backup root');
  return resolvedBackup;
}

function restoreBackup(root, backupDir, controlPlaneBackupDir = null, preserveData = false) {
  backupDir = checkedBackupDirectory(root, backupDir);
  verifyCompleteBackup(backupDir);
  let controlPlaneDump = null;
  if (controlPlaneBackupDir && resolve(controlPlaneBackupDir) !== backupDir) {
    controlPlaneBackupDir = checkedBackupDirectory(root, controlPlaneBackupDir);
    const marker = verifyCompleteBackup(controlPlaneBackupDir);
    if (!marker.files['control-plane.dump']?.size) throw new Error('Rollback rescue backup lacks the current control plane');
    controlPlaneDump = join(controlPlaneBackupDir, 'control-plane.dump');
  }
  // Refuse an unavailable/mutated old image before stopping the current pair or
  // replacing any data. Both services must be recoverable from this snapshot.
  const savedDeployment = withImageIdentities(readJson(join(backupDir, 'deployment.json')));
  for (const name of managedProfileFiles) {
    const source = join(backupDir, name);
    const target = join(root, name);
    if (existsSync(target)) unlinkSync(target);
    if (existsSync(source)) copyFileSync(source, target);
  }
  const deployment = readJson(join(root, 'deployment.json'));
  saveJson(join(root, 'deployment.json'), savedDeployment);
  if (preserveData) {
    // Automatic rollback changes application containers only. Current business
    // data and API-home volumes must never be replaced by a historical snapshot.
    compose(root, 'up', '-d', '--no-deps', '--wait', '--wait-timeout', '240', 'api', 'web');
    saveJson(join(root, 'active.json'), savedDeployment);
    return;
  }
  compose(root, 'stop', 'web', 'api');
  compose(root, 'up', '-d', '--wait', 'postgres');
  execute('docker', [
    'run', '--rm', '--network', 'none',
    '--mount', `type=volume,src=remi-${deployment.profile}_api-home,dst=/restore`,
    '--mount', `type=bind,src=${backupDir},dst=/snapshot,readonly`,
    '--entrypoint', 'sh', deployment.apiImage,
    '-c', 'find /restore -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && tar -xf /snapshot/api-home.tar -C /restore',
  ]);
  // --clean only drops objects present in the old dump; new-version tables
  // would survive it. Recreate the database and restore atomically instead.
  compose(root, 'exec', '-T', 'postgres', 'dropdb', '-U', 'multiremi', '--if-exists', '--force', 'multiremi');
  compose(root, 'exec', '-T', 'postgres', 'createdb', '-U', 'multiremi', '--owner=multiremi', '--template=template0', 'multiremi');
  // Omit a filename so pg_restore owns stdin directly. /dev/stdin makes its
  // archive-format probe reopen an already-consumed Docker pipe.
  execute('docker', composeArgs(root, 'exec', '-T', 'postgres', 'pg_restore', '-U', 'multiremi', '-d', 'multiremi', '--exit-on-error', '--single-transaction'), {
    input: readFileSync(join(backupDir, 'postgres.dump')),
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (controlPlaneDump) {
    // These three tables have no external foreign keys. Keep the current
    // operation and drain fence when business data is rolled back to an older
    // point in time; otherwise the new API could start accepting writes early.
    execute('docker', composeArgs(root, 'exec', '-T', 'postgres', 'pg_restore', '-U', 'multiremi', '-d', 'multiremi',
      '--clean', '--if-exists', '--exit-on-error', '--single-transaction'), {
      input: readFileSync(controlPlaneDump), stdio: ['pipe', 'inherit', 'inherit'],
    });
  }
  compose(root, 'up', '-d', '--wait', '--wait-timeout', '240');
  saveJson(join(root, 'active.json'), readJson(join(root, 'deployment.json')));
}

async function hostStage(profile, flags) {
  if (profile !== 'stable') throw new Error('The recoverable host executor only manages the stable profile');
  const operationId = safeOperationId(flags['--operation-id']);
  const ref = flags['--ref'];
  const version = flags['--version'];
  const dataSchema = flags['--data-schema'];
  if (dataSchema && !/^[a-f0-9]{64}$/iu.test(dataSchema)) throw new Error('--data-schema must be SHA-256');
  if (!/^[a-f0-9]{40}$/iu.test(ref || '')) throw new Error('--ref must be a full Git commit');
  if (!/^v?\d+\.\d+\.\d+$/u.test(version || '')) throw new Error('--version must be SemVer');
  validateReleaseArtifactInput(flags['--source-url'], flags['--source-sha256']);
  const root = initialize(profile);
  if (!existsSync(join(root, 'active.json'))) throw new Error('The stable profile must be active before a host update');
  const release = acquireHostLock(root);
  try {
    const path = operationPath(root, operationId);
    let state = existsSync(path) ? readJson(path) : null;
    if (state) {
      if (state.kind !== 'update' || state.targetRef !== ref || state.targetVersion !== version || state.dataSchema !== dataSchema) {
        throw new Error('Operation ID was already used with different update parameters');
      }
      if (state.status === 'succeeded' || state.phase === 'built') return;
      if (state.status !== 'running') throw new Error(state.error || `Host operation is ${state.status}`);
    } else {
      state = {
        schemaVersion: 1,
        operationId,
        kind: 'update',
        status: 'running',
        phase: 'requested',
        targetRef: ref.toLowerCase(),
        targetVersion: version.replace(/^v/u, ''),
        dataSchema,
        sourceUrl: flags['--source-url'],
        sourceSha256: flags['--source-sha256']?.toLowerCase(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        error: null,
        backupDir: null,
        resultRelease: null,
      };
      saveJson(path, state);
    }
    const directory = operationDirectory(root, operationId);
    const previous = join(directory, 'previous');
    const candidate = join(directory, 'candidate');
    try {
      validateHostCapacity(root);
      await validateReleaseArtifact(state.sourceUrl, state.sourceSha256);
      execute('git', ['fetch', '--no-tags', 'origin', ref]);
      const resolved = capture('git', ['rev-parse', '--verify', `${ref}^{commit}`]).toLowerCase();
      if (resolved !== ref.toLowerCase()) throw new Error('Fetched Git object does not match the requested commit');
      if (dataSchema) {
        if (profileSchema(ref) !== dataSchema || profileSchema(readJson(join(root, 'active.json')).ref) !== dataSchema) {
          throw new Error('Data schema is unknown or incompatible; automatic update refused');
        }
      }
      state = saveOperation(root, state, { phase: 'fetched' });
      if (!existsSync(join(previous, 'files.json'))) snapshotProfile(root, previous);
      else restoreProfileSnapshot(root, previous);
      prepare(profile, ref);
      let deployment = readJson(join(root, 'deployment.json'));
      if (!deployment.version.startsWith(`${state.targetVersion}-stable.`)) {
        throw new Error(`Commit package version ${deployment.version} does not match manifest ${state.targetVersion}`);
      }
      state = saveOperation(root, state, { phase: 'prepared' });
      deployment = prepareDeploymentImages(root, flags);
      if (dataSchema) deployment.dataSchema = dataSchema;
      saveJson(join(root, 'deployment.json'), withImageIdentities(deployment));
      snapshotProfile(root, candidate);
      restoreProfileSnapshot(root, previous);
      saveOperation(root, state, { phase: 'built' });
    } catch (error) {
      if (existsSync(join(previous, 'files.json'))) restoreProfileSnapshot(root, previous);
      saveOperation(root, state, { status: 'failed', phase: 'failed', error: error.message });
      throw error;
    }
  } finally { release(); }
}

async function rollbackInterruptedUpdate(root, state, reason) {
  const directory = operationDirectory(root, state.operationId);
  const previous = join(directory, 'previous');
  let next = saveOperation(root, state, { status: 'recovery_required', phase: 'rolling_back', error: reason });
  try {
    if (next.backupDir) restoreBackup(root, next.backupDir, null, Boolean(next.dataSchema));
    else {
      restoreProfileSnapshot(root, previous);
      compose(root, 'up', '-d', '--wait', '--wait-timeout', '240', ...(next.dataSchema ? ['--no-deps', 'api', 'web'] : []));
      saveJson(join(root, 'active.json'), readJson(join(root, 'deployment.json')));
    }
    await verifyProfileHealth('stable');
    next = saveOperation(root, next, { status: 'rolled_back', phase: 'rolled_back', error: reason, resultRelease: resultRelease(readJson(join(root, 'active.json'))) });
    return next;
  } catch (rollbackError) {
    saveOperation(root, next, {
      status: 'recovery_required',
      phase: 'rolling_back',
      error: `${reason}; automatic rollback failed: ${rollbackError.message}`,
    });
    throw rollbackError;
  }
}

async function hostActivate(profile, flags) {
  if (profile !== 'stable') throw new Error('The recoverable host executor only manages the stable profile');
  const operationId = safeOperationId(flags['--operation-id']);
  const root = join(profilesRoot, profile);
  const release = acquireHostLock(root);
  try {
    let state = readJson(operationPath(root, operationId));
    if (state.kind !== 'update') throw new Error('Host operation is not an update');
    if (state.status === 'succeeded') return;
    if (state.status !== 'running' || state.phase !== 'built') throw new Error(state.error || `Host operation cannot activate from ${state.phase}`);
    const directory = operationDirectory(root, operationId);
    const previous = join(directory, 'previous');
    const candidate = join(directory, 'candidate');
    try {
      withImageIdentities(readJson(join(candidate, 'deployment.json')));
      withImageIdentities(readJson(join(previous, 'deployment.json')));
      restoreProfileSnapshot(root, previous);
      installHostWriteFence(root, operationId);
      state = saveOperation(root, state, { phase: 'switching' });
      compose(root, 'stop', 'web', 'api');
      compose(root, 'up', '-d', '--wait', 'postgres');
      const saved = backup(root, operationId);
      state = saveOperation(root, state, { phase: 'backup_complete', backupDir: saved });
      restoreProfileSnapshot(root, candidate);
      state = saveOperation(root, state, { phase: 'activating' });
      compose(root, 'up', '-d', '--wait', '--wait-timeout', '240', ...(state.dataSchema ? ['--no-deps', 'api', 'web'] : []));
      await verifyProfileHealth(profile);
      const deployment = readJson(join(root, 'deployment.json'));
      saveJson(join(root, 'active.json'), deployment);
      saveOperation(root, state, { status: 'succeeded', phase: 'succeeded', resultRelease: resultRelease(deployment) });
    } catch (error) {
      if (switchPhases.has(state.phase)) await rollbackInterruptedUpdate(root, state, `Update failed: ${error.message}`);
      else saveOperation(root, state, { status: 'failed', phase: 'failed', error: error.message });
      throw error;
    }
  } finally { release(); }
}

function findBackupForTarget(root, target) {
  const backupsRoot = join(root, 'backups');
  const names = existsSync(backupsRoot) ? readdirSync(backupsRoot).sort().reverse() : [];
  for (const name of names) {
    const backupDir = join(backupsRoot, name);
    try {
      verifyCompleteBackup(backupDir);
      const deployment = readJson(join(backupDir, 'active.json'));
      if (deployment.ref === target || deployment.version === target || deployment.version.startsWith(`${target}-`)) return backupDir;
    } catch {}
  }
  throw new Error(`No verified complete backup matches ${target}`);
}

function hostRollbackStage(profile, flags) {
  if (profile !== 'stable') throw new Error('The recoverable host executor only manages the stable profile');
  const operationId = safeOperationId(flags['--operation-id']);
  const target = flags['--ref'];
  const preserveData = flags['--preserve-data'] === 'true';
  if (!target) throw new Error('--ref is required');
  const root = join(profilesRoot, profile);
  const release = acquireHostLock(root);
  try {
    const path = operationPath(root, operationId);
    if (existsSync(path)) {
      const state = readJson(path);
      if (state.kind !== 'rollback' || state.targetRef !== target || Boolean(state.preserveData) !== preserveData) throw new Error('Operation ID was already used with different rollback parameters');
      if (state.status === 'succeeded' || state.phase === 'rollback_ready') return;
      throw new Error(state.error || `Host rollback is ${state.status}`);
    }
    validateHostCapacity(root);
    const backupDir = findBackupForTarget(root, target);
    if (preserveData && profileSchema(readJson(join(root, 'active.json')).ref) !== profileSchema(readJson(join(backupDir, 'active.json')).ref)) {
      throw new Error('Data schema is incompatible; automatic rollback refused');
    }
    withImageIdentities(readJson(join(backupDir, 'deployment.json')));
    snapshotProfile(root, join(operationDirectory(root, operationId), 'previous'));
    saveJson(path, {
      schemaVersion: 1, operationId, kind: 'rollback', status: 'running', phase: 'rollback_ready',
      targetRef: target, backupDir, fallbackBackupDir: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      preserveData,
      error: null, resultRelease: null,
    });
  } finally { release(); }
}

async function hostRollbackActivate(profile, flags) {
  const operationId = safeOperationId(flags['--operation-id']);
  const root = join(profilesRoot, profile);
  const release = acquireHostLock(root);
  try {
    let state = readJson(operationPath(root, operationId));
    if (state.kind !== 'rollback') throw new Error('Host operation is not a rollback');
    if (state.status === 'succeeded') return;
    if (state.status !== 'running' || state.phase !== 'rollback_ready') throw new Error(state.error || `Host rollback cannot activate from ${state.phase}`);
    installHostWriteFence(root, operationId);
    state = saveOperation(root, state, { status: 'recovery_required', phase: 'rollback_backing_up' });
    try {
      compose(root, 'stop', 'web', 'api');
      compose(root, 'up', '-d', '--wait', 'postgres');
      const fallbackBackupDir = backup(root, operationId);
      state = saveOperation(root, state, { phase: 'rolling_back', fallbackBackupDir, controlPlaneBackupDir: fallbackBackupDir });
      restoreBackup(root, state.backupDir, state.controlPlaneBackupDir, state.preserveData);
      await verifyProfileHealth(profile);
      const deployment = readJson(join(root, 'active.json'));
      saveOperation(root, state, { status: 'succeeded', phase: 'succeeded', resultRelease: resultRelease(deployment) });
    } catch (error) {
      await recoverFailedRollback(root, state, `Rollback failed: ${error.message}`);
      throw error;
    }
  } finally { release(); }
}

async function recoverFailedRollback(root, state, reason) {
  const next = saveOperation(root, state, { status: 'recovery_required', phase: 'rollback_recovering', error: reason });
  try {
    if (next.fallbackBackupDir) restoreBackup(root, next.fallbackBackupDir, null, next.preserveData);
    else {
      restoreProfileSnapshot(root, join(operationDirectory(root, state.operationId), 'previous'));
      compose(root, 'up', '-d', '--wait', '--wait-timeout', '240', ...(next.preserveData ? ['--no-deps', 'api', 'web'] : []));
      saveJson(join(root, 'active.json'), readJson(join(root, 'deployment.json')));
    }
    await verifyProfileHealth('stable');
    saveOperation(root, next, { status: 'failed', phase: 'failed', resultRelease: resultRelease(readJson(join(root, 'active.json'))) });
  } catch (error) {
    saveOperation(root, next, { error: `${reason}; restoring pre-rollback state failed: ${error.message}` });
    throw error;
  }
}

async function hostRecover(profile) {
  if (profile !== 'stable') throw new Error('The recoverable host executor only manages the stable profile');
  const root = join(profilesRoot, profile);
  if (!existsSync(root)) return;
  const release = acquireHostLock(root);
  try {
    const operations = join(root, 'host-operations');
    if (!existsSync(operations)) return;
    for (const operationId of readdirSync(operations).sort()) {
      const path = join(operations, operationId, 'operation.json');
      if (!existsSync(path)) continue;
      const state = readJson(path);
      if (!['running', 'recovery_required'].includes(state.status)) continue;
      if (state.kind === 'update' && switchPhases.has(state.phase)) {
        installHostWriteFence(root, operationId);
        await rollbackInterruptedUpdate(root, state, state.error || 'Host executor was interrupted during the switch');
      } else if (state.kind === 'update' && ['requested', 'fetched', 'prepared'].includes(state.phase)) {
        const previous = join(operationDirectory(root, operationId), 'previous');
        if (existsSync(join(previous, 'files.json'))) restoreProfileSnapshot(root, previous);
        saveOperation(root, state, { status: 'failed', phase: 'failed', error: 'Host executor was interrupted while staging; the active release was preserved' });
      } else if (state.kind === 'rollback' && ['rollback_backing_up', 'rollback_recovering'].includes(state.phase)) {
        installHostWriteFence(root, operationId);
        await recoverFailedRollback(root, state, state.error || 'Host executor was interrupted before rollback completed');
      } else if (state.kind === 'rollback' && state.phase === 'rolling_back') {
        installHostWriteFence(root, operationId);
        try {
          restoreBackup(root, state.backupDir, state.controlPlaneBackupDir);
          await verifyProfileHealth(profile);
          const deployment = readJson(join(root, 'active.json'));
          saveOperation(root, state, { status: 'succeeded', phase: 'succeeded', resultRelease: resultRelease(deployment) });
        } catch (error) {
          await recoverFailedRollback(root, state, `Rollback recovery failed: ${error.message}`);
        }
      }
    }
  } finally { release(); }
}

async function status(root) {
  if (!existsSync(join(root, 'deployment.json'))) {
    console.log('Profile has not been prepared. Run prepare (then build/up), or deploy.');
    return;
  }
  const deployment = readJson(join(root, 'deployment.json'));
  const config = settings[deployment.profile];
  console.log(`${deployment.profile}: http://${networkSettings(deployment).hostname}:${config.webPort}`);
  console.log(`Source: ${deployment.source}\nCommit: ${deployment.ref}\nConfiguration: ${root}`);
  compose(root, 'ps');
  for (const [service, url] of [['api', `http://127.0.0.1:${config.apiPort}/readyz`], ['web', `http://127.0.0.1:${config.webPort}/login`]]) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      console.log(`${service}: HTTP ${response.status}`);
    } catch { console.log(`${service}: unavailable`); }
  }
}

async function main() {
  const [profile, action, ...args] = process.argv.slice(2);
  if (!Object.hasOwn(settings, profile) || !action || action === '--help') {
    console.log('Usage: node scripts/local-profile.mjs <stable|dev> <prepare|build|deploy|up|stop|restart|status|logs|watch|backup|token|host-preflight|host-stage|host-activate|host-recover|host-rollback-stage|host-rollback-activate|host-finalize|host-auth-refresh> [options]');
    console.log('stable deploy: pull verified CI images for a fixed commit, back up data, then update containers.');
    console.log('--image-manifest <path>: use a downloaded stable-images.json; --build-local true: explicitly compile locally.');
    console.log('dev deploy + dev watch: build current source, then sync changes without touching stable.');
    console.log('stable --lan-host: bind Web/API to 0.0.0.0 and persist the advertised LAN address across deploys.');
    return;
  }
  validateProfilesRoot();
  const flags = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!['--ref', '--lan-host', '--operation-id', '--version', '--source-url', '--source-sha256', '--data-schema', '--preserve-data', '--image-manifest', '--build-local'].includes(key) || !value || value.startsWith('--') || Object.hasOwn(flags, key)) {
      throw new Error('Unsupported, missing, or duplicate --ref/--lan-host/host option');
    }
    flags[key] = value;
  }
  const actionOptions = {
    prepare: ['--ref', '--lan-host'], deploy: ['--ref', '--lan-host', '--image-manifest', '--build-local'],
    'host-stage': ['--operation-id', '--ref', '--version', '--source-url', '--source-sha256', '--data-schema', '--image-manifest', '--build-local'],
    'host-activate': ['--operation-id'],
    'host-rollback-stage': ['--operation-id', '--ref', '--preserve-data'],
    'host-rollback-activate': ['--operation-id'],
    'host-finalize': ['--operation-id'],
  };
  const acceptedOptions = actionOptions[action] || [];
  if (flags['--build-local'] && flags['--build-local'] !== 'true') throw new Error('--build-local only accepts true');
  if (flags['--preserve-data'] && flags['--preserve-data'] !== 'true') throw new Error('--preserve-data only accepts true');
  if (flags['--image-manifest'] && (profile !== 'stable' || flags['--build-local'])) throw new Error('--image-manifest is for stable CI deployments only');
  if (Object.keys(flags).some((key) => !acceptedOptions.includes(key))) throw new Error(`--ref and --lan-host or host options are not valid with ${action}`);
  if (profile === 'dev' && flags['--ref'] && flags['--ref'] !== 'HEAD') throw new Error('dev runs the working tree; use stable to deploy a fixed ref');
  if (flags['--lan-host']) {
    if (profile !== 'stable') throw new Error('--lan-host is only valid for stable; dev stays on loopback');
    validateLanHost(flags['--lan-host']);
  }
  const root = join(profilesRoot, profile);
  if (profile === 'stable' && existsSync(join(root, 'compose.internal-updates.yml'))
    && (action.startsWith('host-') || ['prepare', 'deploy', 'build', 'restart', 'backup'].includes(action))) {
    throw new Error('This profile uses internal updates. Use Web settings or remi platform operation create for updates, restart and backups; base-image maintenance requires an explicit migration.');
  }
  if (action === 'host-stage') await hostStage(profile, flags);
  else if (action === 'host-activate') await hostActivate(profile, flags);
  else if (action === 'host-recover') await hostRecover(profile);
  else if (action === 'host-rollback-stage') hostRollbackStage(profile, flags);
  else if (action === 'host-rollback-activate') await hostRollbackActivate(profile, flags);
  else if (action === 'host-finalize') hostFinalize(profile, flags);
  else if (action === 'host-auth-refresh') hostAuthRefresh(profile);
  else if (action === 'host-preflight') {
    if (profile !== 'stable') throw new Error('The host updater only manages stable');
    validateHostCapacity(root);
    withImageIdentities(readJson(join(root, 'active.json')));
    if (capture('docker', ['info', '--format', '{{.OSType}}']).trim() !== 'linux') throw new Error('Linux containers are required');
  }
  else if (action === 'prepare') {
    if (existsSync(join(root, 'active.json'))) throw new Error('An activated profile must be upgraded with deploy');
    prepare(profile, flags['--ref'] || 'HEAD', flags['--lan-host']);
  } else if (action === 'deploy') {
    if (profile === 'stable' && existsSync(join(root, 'compose.application.json'))) throw new Error('This profile uses application bundles. Update through Web settings or remi platform operation create; base-image maintenance requires reconciling the application installation.');
    const oldFiles = new Map();
    for (const name of ['deployment.json', 'compose.env', 'compose.yml', 'compose.dev.yml']) {
      if (existsSync(join(root, name))) oldFiles.set(name, readFileSync(join(root, name)));
    }
    const previous = existsSync(join(root, 'active.json')) ? readJson(join(root, 'active.json')) : null;
    prepare(profile, flags['--ref'] || 'HEAD', flags['--lan-host']);
    try {
      if (profile === 'dev') compose(root, 'build', 'api', 'web');
      else prepareDeploymentImages(root, flags);
    } catch (error) {
      for (const [name, contents] of oldFiles) writeFileSync(join(root, name), contents);
      throw error;
    }
    let saved;
    if (previous) {
      const candidate = new Map([...oldFiles.keys()].map((name) => [name, readFileSync(join(root, name))]));
      // Stop writers using the old project metadata, including after an earlier stop.
      for (const [name, contents] of oldFiles) writeFileSync(join(root, name), contents);
      compose(root, 'stop', 'web', 'api');
      compose(root, 'up', '-d', '--wait', 'postgres');
      try { saved = backup(root); }
      catch (error) {
        compose(root, 'up', '-d', '--wait', '--wait-timeout', '240');
        throw error;
      }
      for (const [name, contents] of candidate) writeFileSync(join(root, name), contents);
    }
    try { compose(root, 'up', '-d', '--wait', '--wait-timeout', '240'); }
    catch (error) {
      console.error(saved ? `Restore the matching data and configuration from ${saved} before rolling code back.` : 'Start failed; data volumes were retained.');
      throw error;
    }
    saveJson(join(root, 'active.json'), readJson(join(root, 'deployment.json')));
    await status(root);
  } else if (action === 'build') compose(root, 'build', 'api', 'web');
  else if (action === 'up') {
    const candidate = readJson(join(root, 'deployment.json'));
    if (existsSync(join(root, 'active.json')) && JSON.stringify(candidate) !== JSON.stringify(readJson(join(root, 'active.json')))) {
      throw new Error('Deployment differs from the active version; use deploy so data is backed up');
    }
    compose(root, 'up', '-d', '--wait', '--wait-timeout', '240');
    saveJson(join(root, 'active.json'), candidate);
  }
  else if (action === 'stop') compose(root, 'stop');
  else if (action === 'restart') {
    compose(root, 'restart', 'api', 'web');
    await verifyProfileHealth(profile);
  }
  else if (action === 'status') await status(root);
  else if (action === 'logs') compose(root, 'logs', '--tail', '80', 'api', 'web');
  else if (action === 'watch') {
    if (profile !== 'dev') throw new Error('Only dev supports source watching');
    // Compose 2.30 lacks initial_sync. Always build before starting a new watch session.
    compose(root, 'up', '-d', '--build', '--wait', '--wait-timeout', '240');
    compose(root, 'watch', '--no-up');
  } else if (action === 'backup') {
    const running = capture('docker', composeArgs(root, 'ps', '--services', '--status', 'running')).split(/\r?\n/u);
    compose(root, 'stop', 'web', 'api');
    compose(root, 'up', '-d', '--wait', 'postgres');
    try { backup(root); }
    finally {
      const writers = ['api', 'web'].filter((name) => running.includes(name));
      if (writers.length) compose(root, 'up', '-d', '--wait', '--wait-timeout', '240', ...writers);
    }
  }
  else if (action === 'token') {
    const { JWT_SECRET: signingSecret } = parseEnv(readFileSync(join(root, 'api.env'), 'utf8'));
    if (!signingSecret) throw new Error('No local profile JWT_SECRET is configured');
    // Existing JWT authentication recognizes the local administrator identity;
    // /api/me mirrors this expiring credential into the attachment auth cookie.
    // Keep the deployment-wide master token and signing secret out of the browser.
    const issuedAt = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ sub: 'local', iat: issuedAt, exp: issuedAt + 24 * 60 * 60 })).toString('base64url');
    const signingInput = `${header}.${claims}`;
    const signature = createHmac('sha256', signingSecret).update(signingInput).digest('base64url');
    console.log(`${signingInput}.${signature}`);
  }
  else throw new Error(`Unknown action: ${action}`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
