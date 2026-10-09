import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { parseEnv } from 'node:util';
import type { MultiremiPlatformOperation, MultiremiPlatformRelease, MultiremiPlatformService, ReportPlatformOperationInput } from '@multiremi/contracts';
import type { PlatformDrainGate } from './drain.js';
import type { CommandOptions, CommandRunner, PlatformDeploymentDriver, PlatformInspection } from './types.js';
import { atomicJson, checkBackup, createBackup, DATA_SCHEMA_INPUTS, isWithin, migrationFingerprint, preflightResult, readJsonFile, readRecoveryJournal, RecoveryRequiredError, type BackupConfig } from './safety.js';
import { fetchReleaseResponse } from './release-feed.js';
import { API_BASE_INPUTS, assertApplicationCompatible, parseApplicationManifest, type ApplicationManifest } from './application-manifest.js';
// Bun embeds these resources in the standalone Windows/macOS/Linux updater.
// @ts-ignore -- Bun's text loader returns the source, not the JS module exports.
import runtimeSource from './container-runtime.mjs' with { type: 'text' };
// @ts-ignore -- the preload is deliberately embedded rather than executed here.
import fenceSource from '../../../deploy/docker/host-write-fence.ts' with { type: 'text' };

export interface ApplicationDriverConfig {
  kind: 'docker_compose' | 'local_profile';
  composeFile: string;
  envFile: string;
  projectName?: string;
  stateDir: string;
  profileRoot?: string;
  backup?: BackupConfig;
  apiHealthUrl: string;
  webHealthUrl: string;
  coreServices?: readonly string[];
  extraHealthUrls?: readonly string[];
  postgresContainer?: string;
  minimumFreeBytes?: number;
  verificationTimeoutMs?: number;
}
interface Installation {
  project: string;
  volume: string;
  apiImage: string;
  webImage: string;
  postgresImage: string;
  postgresContainer: string;
  architecture: string;
  bun: string;
  nodeMajor: number;
  apiLibc: string;
  webLibc: string;
  apiBase: string;
  bootstrap: string;
  services: string[];
}
interface Selection { id: string; release: MultiremiPlatformRelease }
interface Journal {
  phase: 'prepared' | 'committed' | 'verified' | 'rolled_back';
  installation: Installation;
  previous: Selection;
  target: Selection;
  bootstrap: boolean;
  backup: string;
  operationId: string;
  kind: MultiremiPlatformOperation['kind'];
  error?: string;
}
const CORE = new Set(['api', 'api-runtime', 'web']);
const ROOT = '/opt/remi-application';
const CONTROL = '/remi-application-control';
const BOOTSTRAP = '/remi-application-bootstrap';
const COMMITTED = new Set(['switching', 'restarting', 'verifying', 'rolling_back']);

/** Match local-profile.mjs isolation, including Docker calls made by backups. */
export class LocalProfileCommandRunner implements CommandRunner {
  constructor(private readonly delegate: CommandRunner) {}
  run(command: string, args: string[], options: CommandOptions = {}) {
    if (command !== 'docker') return this.delegate.run(command, args, options);
    const env = { ...process.env, ...options.env };
    for (const key of Object.keys(env)) {
      if (/^(REMI_|MULTIREMI_|POSTGRES_|COMPOSE_)/i.test(key) || /^(DOCKER_HOST|DOCKER_CONTEXT|DOCKER_CONFIG|DOCKER_TLS_VERIFY|DOCKER_CERT_PATH|BUILDX_CONFIG|BUILDX_BUILDER|BUILDKIT_HOST)$/i.test(key)) env[key] = undefined;
    }
    if (process.platform === 'win32') {
      const key = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'Path';
      env[key] = `${join(process.env.ProgramFiles || 'C:/Program Files', 'Docker', 'Docker', 'resources', 'bin')}${delimiter}${env[key] || ''}`;
    }
    return this.delegate.run(command, ['--context', process.platform === 'win32' ? 'desktop-linux' : 'default', ...args], { ...options, env });
  }
}

/** Application code lives in a volume; normal updates never pull or replace images. */
export class ContainerApplicationDriver implements PlatformDeploymentDriver {
  readonly kind: 'docker_compose' | 'local_profile';
  readonly updateMode = 'host_application' as const;
  private readonly services: string[];
  private readonly overlay: string;
  private readonly controlDir: string;
  private readonly runner: CommandRunner;

  constructor(private readonly config: ApplicationDriverConfig, runner: CommandRunner) {
    this.kind = config.kind;
    this.runner = config.kind === 'local_profile' ? new LocalProfileCommandRunner(runner) : runner;
    this.services = [...new Set(config.coreServices ?? ['api', 'web'])];
    if (!this.services.includes('api') || !this.services.includes('web') || this.services.some(service => !CORE.has(service))) throw new Error('Application updates may manage only api, api-runtime and web; api and web are required');
    this.overlay = join(dirname(config.composeFile), 'compose.application.json');
    this.controlDir = join(config.stateDir, 'application-control');
  }

  async inspect(): Promise<PlatformInspection> {
    const currentRelease = await this.currentRelease();
    const recentReleases: MultiremiPlatformRelease[] = currentRelease ? [currentRelease] : [];
    for (const file of (await readdir(join(this.config.stateDir, 'application-history')).catch(() => [])).sort().reverse()) {
      if (!file.endsWith('.json')) continue;
      const selected = await readJsonFile<Selection>(join(this.config.stateDir, 'application-history', file));
      if (selected && !recentReleases.some(item => item.ref === selected.release.ref)) recentReleases.push(selected.release);
      if (recentReleases.length >= 10) break;
    }
    const output = await this.compose(['ps', '--format', 'json']);
    const rows = output.exitCode === 0 ? output.stdout.split('\n').filter(Boolean).flatMap(line => { try { const row = JSON.parse(line); return Array.isArray(row) ? row : [row]; } catch { return []; } }) : [];
    const services = (['api', 'web', 'postgres', 'openviking'] as const).map((id): MultiremiPlatformService => {
      const row = rows.find(item => item.Service === id);
      return { id, name: id, status: row?.State === 'running' ? (row.Health && row.Health !== 'healthy' ? 'degraded' : 'ready') : row ? 'stopped' : 'unknown', detail: row?.Status ?? null, version: id === 'api' || id === 'web' ? currentRelease?.version ?? null : row?.Image ?? null, checkedAt: new Date().toISOString() };
    });
    return { driver: this.kind, updateMode: this.updateMode, currentRelease, recentReleases, services };
  }

  async preflight() {
    const checks: Array<{ code: string; ok: boolean; message: string }> = [];
    for (const [code, run] of [
      ['application_runtime', async () => { await this.discover(); }],
      ['backup', async () => { const installation = await this.discover(); await checkBackup(await this.backupConfig(installation)); }],
      ['current_release', async () => {
        const current = await this.currentRelease();
        if (!current?.dataSchema || !/^[a-f0-9]{40}$/.test(current.ref)) throw new Error('Register the actual current release before updating');
        const selected = await this.selected();
        const sourceRoot = selected ? `${ROOT}/releases/${safeId(selected.id)}/api` : '/app';
        const source = await this.compose(['exec', '-T', 'api', 'cat', ...DATA_SCHEMA_INPUTS.map(path => `${sourceRoot}/${path}`)]);
        if (source.exitCode !== 0 || migrationFingerprint(source.stdout) !== current.dataSchema) throw new Error('Current application schema does not match the running API');
      }],
    ] as const) {
      try { await run(); checks.push({ code, ok: true, message: `${code}: ready` }); }
      catch (error) { checks.push({ code, ok: false, message: message(error) }); }
    }
    return preflightResult(checks);
  }

  async validateRelease(value: unknown): Promise<void> {
    const manifest = parseApplicationManifest(value);
    assertApplicationCompatible(await this.currentRelease(), manifest);
    const installation = await this.discover();
    if (installation.bun !== manifest.application.bun || installation.nodeMajor !== manifest.application.nodeMajor || installation.apiLibc !== manifest.application.apiLibc || installation.webLibc !== manifest.application.webLibc || installation.apiBase !== manifest.application.apiBase) throw new Error('Application requires a different base runtime (Bun/Node/libc, API tools or entrypoint); upgrade the base images explicitly');
    if (!manifest.application.assets[`linux-${installation.architecture}`]) throw new Error('Release has no application bundle for this Docker architecture');
  }

  async recoverInterrupted(): Promise<void> {
    for (const name of await readdir(this.config.stateDir).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
      if (!/^application-operation-[A-Za-z0-9_-]+\.json$/.test(name)) continue;
      const path = join(this.config.stateDir, name);
      const journal = await this.journal(path);
      if (journal?.phase === 'committed') await this.recover(path, journal);
    }
  }

  async finalize(operationId: string): Promise<void> {
    const journal = await this.journal(this.journalPath(operationId));
    const fence = await readJsonFile<{ operationId: string }>(join(this.controlDir, 'write-fence.json'));
    if (!fence) return;
    if (!journal || !['verified', 'rolled_back', 'prepared'].includes(journal.phase)) throw new RecoveryRequiredError('Application operation is not terminal; keeping the write fence');
    if (fence?.operationId === operationId) await rm(join(this.controlDir, 'write-fence.json'));
    else if (fence) throw new RecoveryRequiredError('Another application operation owns the write fence');
  }

  async pendingFinalization() {
    const fence = await readJsonFile<{ operationId: string }>(join(this.controlDir, 'write-fence.json'));
    if (!fence) return null;
    const journal = await this.journal(this.journalPath(fence.operationId));
    if (!journal || !['verified', 'rolled_back'].includes(journal.phase)) throw new RecoveryRequiredError('Application write fence has no verified terminal result');
    return {
      operationId: journal.operationId,
      report: {
        status: journal.phase === 'rolled_back' ? 'failed' : journal.kind === 'rollback' ? 'rolled_back' : 'succeeded',
        resultRelease: journal.phase === 'rolled_back' ? journal.previous.release : journal.target.release,
        ...(journal.error ? { error: journal.error } : {}),
      } as ReportPlatformOperationInput,
    };
  }

  async execute(operation: MultiremiPlatformOperation, report: (input: ReportPlatformOperationInput) => Promise<void>, drain?: PlatformDrainGate): Promise<MultiremiPlatformRelease | null> {
    if (operation.kind === 'check_updates') return this.currentRelease();
    if (!drain) throw new Error('A drain gate is required for application updates');
    const path = this.journalPath(operation.id);
    const existing = await this.journal(path);
    if (existing?.phase === 'verified') return existing.target.release;
    if (existing?.phase === 'rolled_back') throw new Error(existing.error || 'Previous application release recovered');
    if (existing?.phase === 'committed') { await this.recover(path, existing); throw new Error('Interrupted application switch recovered'); }
    if (COMMITTED.has(operation.status)) {
      if (existing) throw new Error('Prepared application update was interrupted before host commit; services were left running');
      throw new RecoveryRequiredError('Committed application operation has no recovery journal');
    }
    const preflight = await this.preflight();
    if (!preflight.ready) throw new Error(preflight.checks.filter(check => !check.ok).map(check => check.message).join('; '));
    const installation = await this.prepareControl(await this.discover());
    const previousRelease = (await this.currentRelease())!;
    const selected = await this.selected();
    const previous = selected ?? { id: `seed-${previousRelease.ref}`, release: previousRelease };
    if (!selected) await this.seed(installation, previous);
    await mkdir(join(this.config.stateDir, 'application-history'), { recursive: true });
    await atomicJson(join(this.config.stateDir, 'application-history', `${safeId(previous.id)}.json`), previous);
    let target = previous;
    if (operation.kind === 'update') {
      const manifest = parseApplicationManifest(operation.targetManifest);
      if (operation.targetVersion && operation.targetVersion.replace(/^v/, '') !== manifest.version.replace(/^v/, '')) throw new Error('Requested version does not match the application manifest');
      await this.validateRelease(manifest);
      await report({ status: 'pulling', previousRelease, progress: { message: `Downloading application ${manifest.version}; reusing installed base images` } });
      target = await this.stage(installation, manifest, operation.id);
    } else if (operation.kind === 'rollback') {
      target = await this.rollbackTarget(operation);
      const currentManifest = await this.controlJson<ApplicationManifest>(installation, ['verify', previous.id]);
      if (target.release.dataSchema !== previous.release.dataSchema && !currentManifest.application?.rollbackSafeFrom.includes(target.release.dataSchema!)) throw new Error('This rollback has no reviewed migration compatibility declaration');
      await this.control(installation, ['verify', target.id]);
    }
    await drain.waitUntilDrained(report);
    await report({ status: 'backing_up', previousRelease, progress: { message: 'Backing up data and rehearsing migrations in an isolated PostgreSQL instance' } });
    await drain.assertReady();
    const journal: Journal = { phase: 'prepared', installation, previous, target, backup: '', bootstrap: !selected, operationId: operation.id, kind: operation.kind };
    await atomicJson(path, journal);
    await report({ status: operation.kind === 'restart' ? 'restarting' : 'switching', previousRelease, progress: { message: 'Switching application code; agent and data services stay running' } });
    // Commit before any fence, pointer or service mutation. Recovery needs no API.
    journal.phase = 'committed';
    await atomicJson(path, journal);
    try {
      await atomicJson(join(this.controlDir, 'write-fence.json'), { operationId: operation.id });
      // Quiesce all API/Web writers, including old APIs without a complete
      // in-process write gate, before copying files. Agents run elsewhere and
      // have already acknowledged drain. No control-API calls follow this stop.
      await this.mustCompose(['stop', ...installation.services]);
      journal.backup = await createBackup(await this.backupConfig(installation), this.runner, operation.id);
      await atomicJson(path, journal);
      await this.rehearse(installation, journal.backup, previous, target, operation.id);
      await this.control(installation, ['select', target.id]);
      await this.activate(installation, journal.bootstrap);
      await this.verify(target, installation);
      await this.record(target, installation);
      await atomicJson(path, { ...journal, phase: 'verified' });
      return target.release;
    } catch (error) {
      await this.recover(path, { ...journal, error: message(error) });
      throw error;
    }
  }

  private async discover(): Promise<Installation> {
    if ((await this.mustDocker(['info', '--format', '{{.OSType}}'])).trim() !== 'linux') throw new Error('Linux Docker containers are required on Windows, macOS and Linux');
    const config = JSON.parse((await this.mustCompose(['config', '--format', 'json'])));
    const project = String(config.name || this.config.projectName || '');
    if (!/^[a-z0-9][a-z0-9_-]+$/.test(project)) throw new Error('Compose project is invalid');
    const states: Record<string, { Id: string; Image: string; State: { Running: boolean }; Mounts: Array<{ Destination: string; Type: string; Name?: string; RW: boolean }> }> = {};
    for (const service of this.services) {
      if (!config.services?.[service]) throw new Error(`Compose service ${service} is missing`);
      const ids = (await this.mustCompose(['ps', '--all', '--quiet', service])).trim().split(/\s+/).filter(Boolean);
      if (ids.length !== 1) throw new Error(`Expected exactly one ${service} container`);
      const state = JSON.parse(await this.mustDocker(['inspect', '--format', '{{json .}}', ids[0]!])) as typeof states[string];
      if (!state.State.Running || !/^sha256:[a-f0-9]{64}$/.test(state.Image)) throw new Error(`${service} is not running`);
      states[service] = state;
    }
    const running = (await this.mustDocker(['ps', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Label "com.docker.compose.service"}}'])).trim().split('\n');
    if (!this.services.includes('api-runtime') && running.includes('api-runtime')) throw new Error('Include the running api-runtime in MULTIREMI_PLATFORM_CORE_SERVICES before updating');
    if (running.includes('feishu-sidecar')) throw new Error('Retire the obsolete feishu-sidecar before enabling application updates');
    if (states['api-runtime'] && states['api-runtime'].Image !== states.api!.Image) throw new Error('API roles must use the same base image');
    if (this.config.profileRoot && !this.config.backup) {
      const home = states.api!.Mounts.find(mount => mount.Destination === '/srv/multiremi');
      if (home?.Type !== 'volume' || home.Name !== `${project}_api-home`) throw new Error('Local profile API home differs from its default backup volume; configure explicit backups');
      if (Object.values(states).some(state => state.Mounts.some(mount => mount.RW && (mount.Destination !== '/srv/multiremi' || mount.Type !== 'volume' || mount.Name !== `${project}_api-home`)))) throw new Error('Additional writable mounts require explicit backup coverage');
    }
    const installed = await readJsonFile<Installation>(join(this.config.stateDir, 'application-installation.json'));
    if (installed && this.services.some(service => states[service]!.Image !== (service === 'web' ? installed.webImage : installed.apiImage))) throw new Error('Base images changed outside the application updater; reconcile the installation before updating');
    if (!installed && this.services.some(service => states[service]!.Mounts.some(mount => mount.Destination === '/app' || mount.Destination.startsWith('/app/')))) throw new Error('Cannot bootstrap an application from an image when /app is overridden by a mount');
    const architecture = (await this.mustDocker(['exec', states.api!.Id, 'bun', '-p', 'process.arch'])).trim();
    const bun = (await this.mustDocker(['exec', states.api!.Id, 'bun', '--version'])).trim();
    const nodeMajor = Number((await this.mustDocker(['exec', states.web!.Id, 'node', '-p', 'process.versions.node.split(".")[0]'])).trim());
    const apiLibc = (await this.mustDocker(['exec', states.api!.Id, 'getconf', 'GNU_LIBC_VERSION'])).trim();
    const webLibc = (await this.mustDocker(['exec', states.web!.Id, 'getconf', 'GNU_LIBC_VERSION'])).trim();
    const apiBase = migrationFingerprint(await this.mustDocker(['exec', states.api!.Id, 'cat', ...API_BASE_INPUTS.map(path => `/app/${path}`)]));
    if (!['x64', 'arm64'].includes(architecture) || !/^\d+\.\d+\.\d+$/.test(bun) || !Number.isInteger(nodeMajor)) throw new Error('Unsupported application base runtime');
    const pg = this.config.postgresContainer || (await this.mustCompose(['ps', '--all', '--quiet', 'postgres'])).trim();
    if (!pg || pg.includes('\n')) throw new Error('PostgreSQL container is required for isolated migration rehearsal');
    const postgresImage = (await this.mustDocker(['inspect', '--format', '{{.Image}}', pg])).trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(postgresImage)) throw new Error('PostgreSQL image identity is invalid');
    return { project, volume: `${project}_application-releases`, apiImage: states.api!.Image, webImage: states.web!.Image, postgresImage, postgresContainer: pg, architecture, bun, nodeMajor, apiLibc, webLibc, apiBase, bootstrap: installed?.bootstrap ?? '', services: this.services };
  }

  private async prepareControl(installation: Installation): Promise<Installation> {
    await mkdir(this.controlDir, { recursive: true, mode: 0o755 });
    const digest = createHash('sha256').update(runtimeSource).update(fenceSource).digest('hex').slice(0, 16);
    const bootstrap = join(this.controlDir, digest);
    await mkdir(bootstrap, { recursive: true, mode: 0o755 });
    await writeFile(join(bootstrap, 'runtime.mjs'), runtimeSource, { mode: 0o644 });
    await writeFile(join(bootstrap, 'host-write-fence.ts'), fenceSource, { mode: 0o644 });
    const found = await this.runner.run('docker', ['volume', 'ls', '--format', '{{.Name}}', '--filter', `name=^${installation.volume}$`]);
    if (found.exitCode !== 0) throw new Error('Cannot inspect application volume');
    if (found.stdout.trim()) {
      const owner = (await this.mustDocker(['volume', 'inspect', '--format', '{{index .Labels "io.remi.application.project"}}', installation.volume])).trim();
      if (owner !== installation.project) throw new Error('Application volume is not owned by this project');
    } else await this.mustDocker(['volume', 'create', '--label', `io.remi.application.project=${installation.project}`, installation.volume]);
    const next = { ...installation, bootstrap };
    const info = await this.controlJson<{ freeBytes: number }>(next, ['inspect']);
    if (info.freeBytes < (this.config.minimumFreeBytes ?? 5 * 1024 ** 3)) throw new Error('Insufficient free space in the Docker application volume');
    await atomicJson(join(this.config.stateDir, 'application-installation.json'), next);
    return next;
  }

  private async seed(installation: Installation, previous: Selection): Promise<void> {
    await this.control(installation, ['seed', previous.id, 'api']);
    await this.control(installation, ['seed', previous.id, 'web'], { image: installation.webImage, runtime: 'node' });
    const path = join(this.config.stateDir, 'seed-manifest.json');
    await atomicJson(path, previous.release);
    await this.control(installation, ['finish-seed', previous.id], { input: [path, '/remi-input/manifest.json'] });
  }

  private async stage(installation: Installation, manifest: ApplicationManifest, operationId: string): Promise<Selection> {
    const asset = manifest.application.assets[`linux-${installation.architecture}`]!;
    const path = join(this.config.stateDir, `application-${safeId(operationId)}.tar.gz`);
    const disk = await statfs(this.config.stateDir);
    if (Number(disk.bavail) * Number(disk.bsize) < (this.config.minimumFreeBytes ?? 5 * 1024 ** 3)) throw new Error('Insufficient host staging space');
    try {
      // Bundled Linux dependencies can exceed hundreds of MiB. Metadata keeps
      // its short timeout; the bounded application transfer gets thirty minutes.
      const response = await fetchReleaseResponse(asset.url, 30 * 60_000);
      const handle = await open(path, 'w', 0o600);
      const hash = createHash('sha256');
      let bytes = 0;
      try {
        if (!response.body) throw new Error('Empty application archive');
        for await (const chunk of response.body) {
          bytes += chunk.length;
          if (bytes > 2 * 1024 ** 3) throw new Error('Application download exceeds 2 GiB');
          hash.update(chunk); await handle.writeFile(chunk);
        }
        await handle.sync();
      } finally { await handle.close(); }
      if (hash.digest('hex') !== asset.sha256) throw new Error('Application bundle SHA-256 mismatch');
      const id = `app-${asset.sha256}`;
      await this.control(installation, ['stage', id, asset.sha256, manifest.version, manifest.ref, manifest.dataSchema], { input: [path, '/remi-input/archive.tar.gz'] });
      const actual = await this.controlJson<ApplicationManifest>(installation, ['verify', id]);
      if (JSON.stringify(actual.application) !== JSON.stringify(manifest.application)) {
        // URLs/checksums are added after packaging; compare the runtime and
        // migration contract, which must be inside the checksummed archive.
        if (actual.application?.format !== manifest.application.format || actual.application?.bun !== manifest.application.bun || actual.application?.nodeMajor !== manifest.application.nodeMajor || actual.application?.apiLibc !== manifest.application.apiLibc || actual.application?.webLibc !== manifest.application.webLibc || actual.application?.apiBase !== manifest.application.apiBase || JSON.stringify(actual.application?.rollbackSafeFrom) !== JSON.stringify(manifest.application.rollbackSafeFrom)) throw new Error('Application runtime/migration contract differs from its manifest');
      }
      return { id, release: { ...manifest, apiImage: installation.apiImage, webImage: installation.webImage } };
    } finally { await rm(path, { force: true }); }
  }

  private async rehearse(installation: Installation, backup: string, previous: Selection, target: Selection, operationId: string): Promise<void> {
    const name = `remi-rehearsal-${safeId(operationId).slice(0, 40)}-${randomUUID().slice(0, 8)}`;
    let created = false;
    try {
      await this.mustDocker(['run', '--detach', '--pull=never', '--name', name, '--label', 'io.remi.application.rehearsal=true', '--label', `io.remi.application.project=${installation.project}`, '--label', `io.remi.application.operation=${operationId}`, '--network', 'none', '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', '--env', 'POSTGRES_USER=remi_rehearsal', '--env', 'POSTGRES_DB=remi_update_rehearsal', installation.postgresImage]);
      created = true;
      for (let attempt = 0; ; attempt++) {
        // The image's temporary socket server accepts connections before the
        // target DB exists. Require the initialized server and database over TCP.
        if ((await this.runner.run('docker', ['exec', name, 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-U', 'remi_rehearsal', '-d', 'remi_update_rehearsal', '-c', 'SELECT 1'])).exitCode === 0) break;
        if (attempt >= 40) throw new Error('Isolated migration database did not become ready');
        await Bun.sleep(500);
      }
      await this.mustDocker(['exec', '-i', name, 'pg_restore', '-U', 'remi_rehearsal', '-d', 'remi_update_rehearsal', '--no-owner', '--no-privileges', '--exit-on-error'], { stdinFile: join(backup, 'database.dump') });
      const before = await this.databaseShape(name);
      for (const id of [target.id, previous.id]) {
        await this.control(installation, ['migrate', id], { network: `container:${name}`, env: ['MULTIREMI_DATABASE_URL=postgresql://remi_rehearsal@127.0.0.1:5432/remi_update_rehearsal'] });
        const after = new Set(await this.databaseShape(name));
        if (before.some(column => !after.has(column))) throw new Error('Migration rehearsal removed or changed an existing column; automatic application update refused');
      }
    } finally {
      // Only this randomly named disposable database is removed, never a
      // production container or volume. No automatic restore touches live data.
      if (created) await this.mustDocker(['rm', '--force', '--volumes', name]);
    }
  }

  private async databaseShape(container: string): Promise<string[]> {
    const query = "SELECT table_schema||'.'||table_name||'.'||column_name||':'||data_type||':'||udt_name||':'||is_nullable FROM information_schema.columns WHERE table_schema='public' ORDER BY 1";
    return (await this.mustDocker(['exec', container, 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'remi_rehearsal', '-d', 'remi_update_rehearsal', '-c', query])).trim().split('\n').filter(Boolean);
  }

  private async activate(installation: Installation, bootstrap: boolean): Promise<void> {
    if (bootstrap) {
      const environment = parseEnv(await readFile(this.config.envFile, 'utf8'));
      const services = Object.fromEntries(installation.services.map(service => [service, {
        image: service === 'web' ? installation.webImage : installation.apiImage,
        pull_policy: 'never',
        command: [service === 'web' ? 'node' : 'bun', `${BOOTSTRAP}/runtime.mjs`, 'launch', service === 'web' ? 'web' : 'api'],
        environment: {
          REMI_APPLICATION_ROOT: ROOT,
          MULTIREMI_HOST_WRITE_FENCE_FILE: `${CONTROL}/write-fence.json`,
          ...(service === 'web' && this.kind === 'local_profile' ? {
            REMI_WEB_LOCAL_PROFILE: 'stable', REMI_WEB_SITE_URL: environment.REMI_PUBLIC_URL ?? '', REMI_WEB_WS_URL: environment.REMI_PUBLIC_WS_URL ?? '',
          } : {}),
        },
        volumes: [
          { type: 'volume', source: 'remi-application-releases', target: ROOT, read_only: true },
          { type: 'bind', source: installation.bootstrap.replaceAll('\\', '/'), target: BOOTSTRAP, read_only: true },
          { type: 'bind', source: this.controlDir.replaceAll('\\', '/'), target: CONTROL, read_only: true },
        ],
      }]));
      await atomicJson(this.overlay, { services, volumes: { 'remi-application-releases': { external: true, name: installation.volume } } });
      await this.mustCompose(['up', '-d', '--no-deps', '--no-build', '--pull', 'never', ...installation.services]);
    } else {
      const before = await this.containerIdentities(installation.services);
      await this.mustCompose(['restart', ...installation.services]);
      const after = await this.containerIdentities(installation.services);
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Application update unexpectedly changed a container or image identity');
    }
  }

  private async containerIdentities(services: string[]): Promise<string[]> {
    const result = [];
    for (const service of services) {
      const id = (await this.mustCompose(['ps', '--all', '--quiet', service])).trim();
      result.push((await this.mustDocker(['inspect', '--format', '{{.Id}} {{.Image}}', id])).trim());
    }
    return result;
  }

  private async recover(path: string, journal: Journal): Promise<void> {
    try {
      await atomicJson(join(this.controlDir, 'write-fence.json'), { operationId: journal.operationId });
      // A host crash can leave the isolated rehearsal database running. Remove
      // only containers bearing this operation's labels and generated name.
      const leftovers = await this.mustDocker(['ps', '--all', '--filter', 'label=io.remi.application.rehearsal=true', '--filter', `label=io.remi.application.project=${journal.installation.project}`, '--filter', `label=io.remi.application.operation=${journal.operationId}`, '--format', '{{.ID}} {{.Names}}']);
      for (const row of leftovers.trim().split('\n').filter(Boolean)) {
        const [id, name] = row.trim().split(/\s+/);
        const prefix = `remi-rehearsal-${safeId(journal.operationId).slice(0, 40)}-`;
        if (!id || !/^[a-f0-9]{12,64}$/.test(id) || !name?.startsWith(prefix) || !/^[a-f0-9]{8}$/.test(name.slice(prefix.length))) throw new Error('Unexpected rehearsal container identity');
        await this.mustDocker(['rm', '--force', '--volumes', id]);
      }
      await this.control(journal.installation, ['select', journal.previous.id]);
      await this.activate(journal.installation, journal.bootstrap);
      await this.verify(journal.previous, journal.installation);
      await this.record(journal.previous, journal.installation);
      await atomicJson(path, { ...journal, phase: 'rolled_back' });
    } catch { throw new RecoveryRequiredError('Application recovery could not be verified; backups and write fence retained, scheduling remains paused'); }
  }

  private async record(selected: Selection, installation: Installation): Promise<void> {
    const history = join(this.config.stateDir, 'application-history');
    await mkdir(history, { recursive: true });
    await atomicJson(join(history, `${safeId(selected.id)}.json`), selected);
    await atomicJson(join(this.config.stateDir, 'application-current.json'), selected);
    if (this.config.profileRoot) {
      const path = join(this.config.profileRoot, 'active.json');
      const old = await readJsonFile<Record<string, unknown>>(path);
      if (!old) throw new Error('Local profile metadata is missing');
      const value = { ...old, ref: selected.release.ref, version: selected.release.version, dataSchema: selected.release.dataSchema, applicationReleaseId: selected.id, apiImageId: installation.apiImage, webImageId: installation.webImage };
      await atomicJson(join(this.config.profileRoot, 'deployment.json'), value);
      await atomicJson(path, value);
    }
  }

  private async backupConfig(installation: Installation): Promise<BackupConfig> {
    if (this.config.backup) return this.config.backup;
    const root = this.config.profileRoot;
    if (!root) throw new Error('Configure all persistent state backup paths before application updates');
    const files = ['api.env', 'credentials.json', 'compose.env', 'compose.yml', 'active.json', 'deployment.json'];
    for (const extra of ['compose.host-control.yml', 'compose.application.json']) if (await exists(join(root, extra))) files.push(extra);
    const dataPaths = files.map(name => join(root, name));
    if (await exists(join(root, 'host-control'))) dataPaths.push(join(root, 'host-control'));
    return {
      directory: join(root, 'application-backups'), dataPaths,
      databaseDumpCommand: ['docker', 'exec', installation.postgresContainer, 'pg_dump', '-U', 'multiremi', '-d', 'multiremi', '-Fc'],
      // Parsing is followed by a full restore + new/old migration rehearsal
      // against a disposable PostgreSQL container before any service switch.
      databaseVerifyCommand: ['docker', 'run', '--rm', '-i', '--pull=never', '--network', 'none', '--entrypoint', 'pg_restore', installation.postgresImage, '--list'],
      archives: [{ name: 'api-home', dumpCommand: ['docker', 'run', '--rm', '--pull=never', '--network', 'none', '--read-only', '--mount', `type=volume,src=${installation.project}_api-home,dst=/backup,readonly`, '--entrypoint', 'tar', installation.apiImage, '-C', '/backup', '-cf', '-', '.'], verifyCommand: ['docker', 'run', '--rm', '-i', '--pull=never', '--network', 'none', '--entrypoint', 'tar', installation.apiImage, '-tf', '-'] }],
    };
  }

  private async rollbackTarget(operation: MultiremiPlatformOperation): Promise<Selection> {
    for (const file of await readdir(join(this.config.stateDir, 'application-history'))) {
      const selected = await readJsonFile<Selection>(join(this.config.stateDir, 'application-history', file));
      if (selected && (selected.release.ref === operation.targetRef || selected.release.version === operation.targetVersion)) return selected;
    }
    throw new Error('Retained application rollback target was not found');
  }

  private selected() { return readJsonFile<Selection>(join(this.config.stateDir, 'application-current.json')); }
  private async currentRelease(): Promise<MultiremiPlatformRelease | null> {
    const selected = await this.selected();
    if (selected) return selected.release;
    if (!this.config.profileRoot) return readJsonFile<MultiremiPlatformRelease>(join(this.config.stateDir, 'current-release.json'));
    const active = await readJsonFile<Record<string, unknown>>(join(this.config.profileRoot, 'active.json'));
    if (!active) return null;
    if (active.profile !== 'stable') throw new Error('Local profile metadata does not match stable');
    let dataSchema = typeof active.dataSchema === 'string' ? active.dataSchema : null;
    if (!dataSchema) {
      const source = await this.compose(['exec', '-T', 'api', 'cat', ...DATA_SCHEMA_INPUTS.map(path => `/app/${path}`)]);
      if (source.exitCode === 0 && source.stdout) dataSchema = migrationFingerprint(source.stdout);
    }
    return { version: String(active.version).split('-stable.')[0]!, ref: String(active.ref), dataSchema, publishedAt: null, releaseUrl: null, manifestUrl: null, apiImage: String(active.apiImage), webImage: String(active.webImage) };
  }

  private journalPath(id: string) { return join(this.config.stateDir, `application-operation-${safeId(id)}.json`); }
  private journal(path: string) {
    return readRecoveryJournal<Journal>(path, value => {
      if (!['prepared', 'committed', 'verified', 'rolled_back'].includes(value.phase) || !value.installation || !value.previous?.release || !value.target?.release || typeof value.bootstrap !== 'boolean') throw new Error('Invalid application journal');
      if (!['update', 'restart', 'rollback'].includes(value.kind)) throw new Error('Invalid application operation kind');
      safeId(value.operationId); safeId(value.previous.id); safeId(value.target.id);
      const install = value.installation;
      if (!Array.isArray(install.services) || [...install.services].sort().join(',') !== [...this.services].sort().join(',') || !/^sha256:[a-f0-9]{64}$/.test(install.apiImage) || !/^sha256:[a-f0-9]{64}$/.test(install.webImage)) throw new Error('Invalid recovery installation');
      if (!/^[a-z0-9][a-z0-9_-]+$/.test(install.project) || install.volume !== `${install.project}_application-releases` || !isWithin(this.controlDir, install.bootstrap)) throw new Error('Invalid recovery volume or bootstrap');
    });
  }
  private async verify(selected: Selection, installation: Installation) {
    await Promise.all([this.config.apiHealthUrl, this.config.webHealthUrl, ...(this.config.extraHealthUrls ?? [])].map(async url => {
      const deadline = Date.now() + (this.config.verificationTimeoutMs ?? 90_000);
      while (Date.now() < deadline) {
        try { if ((await fetch(url, { signal: AbortSignal.timeout(5000) })).ok) return; } catch {}
        await Bun.sleep(500);
      }
      throw new Error('Application readiness verification failed');
    }));
    for (const service of installation.services) {
      const role = service === 'web' ? 'web' : 'api';
      await this.mustCompose(['exec', '-T', service, role === 'web' ? 'node' : 'bun', `${BOOTSTRAP}/runtime.mjs`, 'verify-running', selected.id, role]);
    }
  }
  private async control(installation: Installation, args: string[], options: { image?: string; runtime?: string; input?: [string, string]; network?: string; env?: string[] } = {}) {
    const readOnly = args[0] === 'migrate' || args[0] === 'verify';
    return this.mustDocker(['run', '--rm', '--pull=never', '--read-only', '--user', '0', '--network', options.network ?? 'none', '--tmpfs', '/tmp:rw,nosuid,size=512m', '--mount', `type=volume,src=${installation.volume},dst=${ROOT}${readOnly ? ',readonly' : ''}`,
      '--mount', `type=bind,src=${installation.bootstrap},dst=${BOOTSTRAP},readonly`,
      ...(options.input ? ['--mount', `type=bind,src=${options.input[0]},dst=${options.input[1]},readonly`] : []),
      ...(options.env ?? []).flatMap(value => ['--env', value]), '--entrypoint', options.runtime ?? 'bun', options.image ?? installation.apiImage,
      `${BOOTSTRAP}/runtime.mjs`, ...args]);
  }
  private async controlJson<T>(installation: Installation, args: string[]): Promise<T> { return JSON.parse(await this.control(installation, args)); }
  private async compose(args: string[]) {
    const overlays = [join(dirname(this.config.composeFile), 'compose.host-control.yml'), this.overlay];
    const files = [this.config.composeFile];
    for (const path of overlays) if (await exists(path)) files.push(path);
    return this.runner.run('docker', ['compose', ...(this.config.projectName ? ['-p', this.config.projectName] : []), '--env-file', this.config.envFile, ...files.flatMap(path => ['-f', path]), ...args], { cwd: dirname(this.config.composeFile) });
  }
  private async mustCompose(args: string[]) { const result = await this.compose(args); if (result.exitCode !== 0) throw new Error(`Docker Compose ${args[0]} failed`); return result.stdout; }
  private async mustDocker(args: string[], options?: CommandOptions) { const result = await this.runner.run('docker', args, options); if (result.exitCode !== 0) throw new Error(`Docker application ${args[0]} ${args.includes('migrate') ? 'migration rehearsal' : 'command'} failed`); return result.stdout; }
}
function safeId(value: string): string { if (!/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw new Error('Invalid application ID'); return value; }
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
async function exists(path: string) { try { await stat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
