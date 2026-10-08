import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, open, readdir, rename, rm, statfs, symlink } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { MultiremiPlatformOperation, MultiremiPlatformRelease, ReportPlatformOperationInput } from '@multiremi/contracts';
import { assertApplicationCompatible, parseApplicationManifest, type ApplicationManifest } from './application-manifest.js';
import { extractArchive } from './container-runtime.mjs';
import { baseFingerprints, readJson, releaseDirectory, schemaFingerprint, syncDirectory, syncTree, writeJson } from './supervisor.mjs';
import { checkBackup, createBackup, preflightResult, readRecoveryJournal, RecoveryRequiredError, type BackupConfig } from './safety.js';
import { fetchReleaseResponse } from './release-feed.js';
import { BunCommandRunner, type CommandRunner, type PlatformDeploymentDriver } from './types.js';
import type { PlatformDrainGate } from './drain.js';

export interface InternalUpdateConfig {
  root: string;
  control: string;
  state: string;
  seeds: string;
  dataPaths: string[];
  databaseUrl: string;
  apiHealthUrl: string;
  webHealthUrl: string;
  minimumFreeBytes?: number;
  verificationTimeoutMs?: number;
}
interface Selection { id: string; release: ApplicationManifest }
interface Journal {
  operationId: string; kind: string; phase: 'prepared' | 'committed' | 'verified' | 'recovered';
  previous: Selection; target: Selection; backup?: string; error?: string;
}
interface SupervisorStatus {
  protocol: number; role: string; arch: string; version: string; ref: string; runtime: string; libc: string;
  dataSchema?: string; apiBase?: string; nativeTools?: string;
  supervisorPid: number; childPid: number | null; releaseId: string | null; revision: string | null;
  stopped: boolean; heartbeatAt: number; seedReady: boolean; seedError?: string;
  probe?: { id: string; ok: boolean; error?: string };
}
const ROLES = ['api', 'web'] as const;
const COMMITTED = new Set(['switching', 'restarting', 'verifying', 'rolling_back']);
async function entries(path: string) {
  try { return await readdir(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}

/** Runs inside Compose. It can access shared volumes and PostgreSQL, never Docker. */
export class InternalApplicationDriver implements PlatformDeploymentDriver {
  readonly kind = 'docker_compose' as const;
  readonly updateMode = 'internal_application' as const;
  private readonly runner: CommandRunner;
  private readonly backup: BackupConfig;
  constructor(private readonly config: InternalUpdateConfig, runner: CommandRunner = new BunCommandRunner()) {
    const url = new URL(config.databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('PostgreSQL is required for internal updates');
    const pgEnv = { PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGCONNECT_TIMEOUT: '10' };
    this.runner = { run: (command, args, options) => runner.run(command, args, { ...options, env: { ...options?.env, ...pgEnv } }) };
    if (!config.dataPaths.length) throw new Error('Persistent data backup mounts are required');
    this.backup = { directory: join(config.state, 'backups'), dataPaths: [],
      databaseDumpCommand: ['pg_dump', '--format=custom', '--no-owner', '--no-acl'], databaseVerifyCommand: ['pg_restore', '--list'],
      archives: config.dataPaths.map((path, index) => ({ name: 'data-' + index, dumpCommand: ['tar', '-C', path, '-cf', '-', '.'], verifyCommand: ['tar', '-tf', '-'] })),
    };
  }
  private status(role: string) { return readJson<SupervisorStatus>(join(this.config.control, role, 'status.json')); }
  private async selected() {
    const selected = await readJson<Selection>(join(this.config.state, 'current.json'));
    if (selected) this.validateSelection(selected);
    return selected;
  }
  private validateSelection(selection: Selection) {
    if (!selection || typeof selection !== 'object') throw new RecoveryRequiredError('Invalid internal release selection');
    releaseDirectory(this.config.root, selection.id);
    parseApplicationManifest(selection.release, { allowPrerelease: selection.id === 'base-' + selection.release?.ref });
  }
  private journalPath(id: string) {
    if (!/^pop_[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid operation ID');
    return join(this.config.state, 'operations', id + '.json');
  }
  private async journal(id: string): Promise<Journal | null> {
    return readRecoveryJournal<Journal>(this.journalPath(id), value => {
      if (value.operationId !== id || !['restart', 'update', 'rollback'].includes(value.kind) || !['prepared', 'committed', 'verified', 'recovered'].includes(value.phase)) throw new RecoveryRequiredError('Invalid internal update journal');
      for (const selection of [value.previous, value.target]) {
        this.validateSelection(selection);
      }
    });
  }
  private fresh(value: { heartbeatAt: number } | null): boolean { return Boolean(value && Date.now() - value.heartbeatAt < 10_000 && value.heartbeatAt <= Date.now() + 1000); }

  async inspect() {
    const services = await Promise.all(ROLES.map(async role => {
      const state = await this.status(role);
      return { id: role, name: role.toUpperCase(), status: this.fresh(state) && state?.childPid ? 'ready' as const : 'stopped' as const,
        version: state?.version ?? null, checkedAt: new Date().toISOString(),
        detail: 'Container supervisor; application and runtime update in place' };
    }));
    const current = await this.selected();
    const history = await entries(join(this.config.state, 'history'));
    const recent = await Promise.all(history.filter(file => file.endsWith('.json')).map(file => readJson<Selection>(join(this.config.state, 'history', file))));
    let currentRelease: MultiremiPlatformRelease | null = current?.release ?? null;
    if (!currentRelease) { try { currentRelease = (await this.baseSelection()).release; } catch {} }
    return { driver: this.kind, updateMode: this.updateMode, currentRelease, recentReleases: recent.filter((value): value is Selection => Boolean(value)).map(value => value.release), services };
  }
  async preflight() {
    const checks: Array<{ code: string; ok: boolean; message: string }> = [];
    const check = async (code: string, action: () => Promise<void>) => {
      try { await action(); checks.push({ code, ok: true, message: code + ' ready' }); }
      catch (error) { checks.push({ code, ok: false, message: error instanceof Error ? error.message : String(error) }); }
    };
    await check('container_supervisors', async () => {
      if (process.platform !== 'linux') throw new Error('Internal updater must run in a Linux container');
      for (const role of ROLES) {
        const state = await this.status(role);
        if (!this.fresh(state) || state?.protocol !== 1 || !state.seedReady || !state.childPid) throw new Error(`${role} supervisor is not ready: ${state?.seedError || 'missing heartbeat, seed or child'}`);
      }
      await this.baseSelection();
    });
    await check('isolated_rehearsal', async () => {
      const state = await readJson<{ protocol: number; isolated: boolean; heartbeatAt: number }>(join(this.config.control, 'rehearsal', 'status.json'));
      if (!this.fresh(state) || state?.protocol !== 1 || state.isolated !== true) throw new Error('Isolated migration rehearsal service is offline');
    });
    await check('backup', () => checkBackup(this.backup));
    await check('postgresql', async () => {
      const result = await this.runner.run('pg_isready', []);
      if (result.exitCode !== 0) throw new Error('PostgreSQL is unavailable for backup');
    });
    await check('program_storage', async () => {
      await mkdir(this.config.root, { recursive: true });
      const disk = await statfs(this.config.root);
      if (Number(disk.bavail) * Number(disk.bsize) < (this.config.minimumFreeBytes ?? 5 * 1024 ** 3)) throw new Error('Insufficient space for retained application/runtime versions');
    });
    return preflightResult(checks);
  }
  async validateRelease(value: unknown) {
    const manifest = parseApplicationManifest(value);
    const app = manifest.application;
    if (app.supervisor !== 1 || !/^\d+\.\d+\.\d+$/.test(app.node ?? '') || !/^[a-f0-9]{64}$/.test(app.nativeTools ?? '')) throw new Error('Release lacks bundled runtimes or a compatible supervisor contract');
    if (Number(app.node!.split('.')[0]) !== app.nodeMajor) throw new Error('Bundled Node version is inconsistent');
    const current = (await this.selected()) ?? await this.baseSelection();
    assertApplicationCompatible(current.release, manifest);
    for (const role of ROLES) {
      const state = await this.status(role);
      if (!this.fresh(state) || state?.protocol !== 1 || state.arch !== process.arch) throw new Error('Supervisor platform is unavailable or incompatible');
      // Native dependencies are built against the target image libc. Runtime
      // executables can change, but we do not claim to replace the container OS.
      if (state.libc !== (role === 'api' ? app.apiLibc : app.webLibc)) throw new Error(`${role} OS ABI requires base-image maintenance`);
      if (role === 'api' && state.nativeTools !== app.nativeTools) throw new Error('Native API tools require base-image maintenance');
    }
    if (!app.assets[`linux-${process.arch}`]) throw new Error('No bundle for this container architecture');
  }
  private async baseSelection(): Promise<Selection> {
    const api = await readJson<SupervisorStatus>(join(this.config.seeds, 'api', 'complete.json'));
    const web = await readJson<SupervisorStatus>(join(this.config.seeds, 'web', 'complete.json'));
    if (!api || !web || api.version !== web.version || api.ref !== web.ref) throw new Error('API/Web base release identity is missing or differs');
    const release = parseApplicationManifest({ version: api.version, ref: api.ref, dataSchema: api.dataSchema,
      publishedAt: null, releaseUrl: null, manifestUrl: null, apiImage: null, webImage: null,
      application: { format: 1, bun: api.runtime, node: web.runtime, nodeMajor: Number(web.runtime.split('.')[0]), supervisor: 1,
        apiLibc: api.libc, webLibc: web.libc, apiBase: api.apiBase, nativeTools: api.nativeTools, rollbackSafeFrom: [], assets: {} } }, { allowPrerelease: true });
    return { id: 'base-' + api.ref, release };
  }
  private async seed(): Promise<Selection> {
    const selected = await this.selected();
    if (selected) return selected;
    const base = await this.baseSelection();
    const target = releaseDirectory(this.config.root, base.id);
    if (!await readJson(join(target, 'complete.json'))) {
      const stage = releaseDirectory(this.config.root, 'seed-' + randomUUID());
      await mkdir(stage, { recursive: true });
      try {
        for (const role of ROLES) await cp(join(this.config.seeds, role, 'source'), join(stage, role), { recursive: true, verbatimSymlinks: true });
        await mkdir(join(stage, 'runtime'));
        await cp(join(this.config.seeds, 'api', 'bun'), join(stage, 'runtime', 'bun'));
        await cp(join(this.config.seeds, 'web', 'node'), join(stage, 'runtime', 'node'));
        if (await schemaFingerprint(join(stage, 'api')) !== base.release.dataSchema) throw new Error('Base migration fingerprint mismatch');
        await this.webCache(stage);
        await syncTree(stage);
        await writeJson(join(stage, 'complete.json'), base.release);
        await rename(stage, target);
        await syncDirectory(dirname(target));
      } finally { await rm(stage, { recursive: true, force: true }); }
    }
    await this.verifyFiles(target, base.release);
    await this.record(base);
    return base;
  }
  private async webCache(path: string) {
    const cache = join(path, 'web/frontend/apps/web/.next/cache');
    await rm(cache, { recursive: true, force: true });
    await mkdir(dirname(cache), { recursive: true });
    await symlink('/tmp/remi-next-cache', cache);
    await syncDirectory(dirname(cache));
  }
  private async stage(manifest: ApplicationManifest, operationId: string): Promise<Selection> {
    const asset = manifest.application.assets[`linux-${process.arch}`]!;
    const id = 'release-' + asset.sha256.slice(0, 48);
    const target = releaseDirectory(this.config.root, id);
    const previous = await readJson<ApplicationManifest & { archiveSha256?: string }>(join(target, 'complete.json'));
    if (previous) {
      if (previous.archiveSha256 !== asset.sha256) throw new Error('Release storage collision');
      this.verifyBundleIdentity(previous, manifest);
      await this.verifyFiles(target, manifest); return { id, release: manifest };
    }
    await mkdir(join(this.config.state, 'downloads'), { recursive: true });
    const archive = join(this.config.state, 'downloads', operationId + '.tar.gz');
    const stage = releaseDirectory(this.config.root, 'stage-' + randomUUID());
    try {
      const response = await fetchReleaseResponse(asset.url, 30 * 60_000);
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Empty application bundle');
      const hash = createHash('sha256'); let bytes = 0;
      const file = await open(archive, 'w', 0o600);
      try {
        for (;;) {
          const next = await reader.read(); if (next.done) break;
          bytes += next.value.length; if (bytes > 2 * 1024 ** 3) throw new Error('Bundle exceeds 2 GiB');
          hash.update(next.value); await file.writeFile(next.value);
        }
        await file.sync();
      } finally { await file.close(); await reader.cancel(); }
      if (hash.digest('hex') !== asset.sha256) throw new Error('Bundle checksum mismatch');
      await extractArchive(archive, stage);
      const embedded = await readJson<ApplicationManifest & { arch: string }>(join(stage, 'application.json'));
      if (!embedded || embedded.arch !== process.arch) throw new Error('Bundle architecture mismatch');
      this.verifyBundleIdentity(embedded, manifest);
      await this.verifyFiles(stage, manifest);
      await this.webCache(stage);
      await writeJson(join(stage, 'complete.json'), { ...manifest, archiveSha256: asset.sha256 });
      await rename(stage, target);
      await syncDirectory(dirname(target));
      return { id, release: manifest };
    } finally { await rm(archive, { force: true }); await rm(stage, { recursive: true, force: true }); }
  }
  private verifyBundleIdentity(embedded: ApplicationManifest, manifest: ApplicationManifest) {
    if (embedded.version !== manifest.version || embedded.ref !== manifest.ref || embedded.dataSchema !== manifest.dataSchema) throw new Error('Bundle identity mismatch');
    if (JSON.stringify(embedded.application?.rollbackSafeFrom) !== JSON.stringify(manifest.application.rollbackSafeFrom)) throw new Error('Bundle migration policy mismatch');
    for (const key of ['bun', 'node', 'apiLibc', 'webLibc', 'apiBase', 'nativeTools', 'supervisor', 'nodeMajor'] as const) {
      if (embedded.application?.[key] !== manifest.application[key]) throw new Error('Bundle runtime contract mismatch');
    }
  }
  private async verifyFiles(path: string, manifest: ApplicationManifest) {
    if (await schemaFingerprint(join(path, 'api')) !== manifest.dataSchema) throw new Error('Bundle migration fingerprint mismatch');
    const base = await baseFingerprints(join(path, 'api'));
    if (base.apiBase !== manifest.application.apiBase || base.nativeTools !== manifest.application.nativeTools) throw new Error('Bundle native tool contract mismatch');
    for (const file of ['runtime/bun', 'runtime/node', 'api/apps/server/main.ts', 'web/frontend/apps/web/server.js']) await open(join(path, file), 'r').then(handle => handle.close());
  }
  private async probe(selection: Selection) {
    for (const role of ROLES) {
      const id = randomUUID();
      await writeJson(join(this.config.control, role, 'probe.json'), { id, releaseId: selection.id });
      await this.until(async () => {
        const state = await this.status(role);
        if (state?.probe?.id !== id || !this.fresh(state)) return false;
        if (!state.probe.ok) throw new Error(`${role}: ${state.probe.error}`);
        return true;
      }, 30_000, 'Bundled runtime probe timed out');
    }
  }
  private async command(mode: 'run' | 'stop', selection: Selection) {
    const revision = randomUUID();
    for (const role of ROLES) await writeJson(join(this.config.control, role, 'desired.json'), { revision, mode, releaseId: selection.id });
    await this.until(async () => (await Promise.all(ROLES.map(async role => {
      const state = await this.status(role);
      return this.fresh(state) && state?.revision === revision && (mode === 'stop' ? state.stopped : state.releaseId === selection.id && Boolean(state.childPid));
    }))).every(Boolean), 65_000, 'Supervisor did not acknowledge the application switch');
  }
  private async verify(selection: Selection) {
    await this.until(async () => {
      for (const role of ROLES) {
        const state = await this.status(role);
        if (!this.fresh(state) || state?.releaseId !== selection.id || !state.childPid) return false;
      }
      for (const url of [this.config.apiHealthUrl, this.config.webHealthUrl]) {
        try { if (!(await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) return false; } catch { return false; }
      }
      return true;
    }, this.config.verificationTimeoutMs ?? 60_000, 'Updated API/Web failed verification');
  }
  private async until(check: () => Promise<boolean>, timeout: number, error: string) {
    const deadline = Date.now() + timeout;
    do { if (await check()) return; await Bun.sleep(200); } while (Date.now() < deadline);
    throw new Error(error);
  }
  private async rehearse(journal: Journal) {
    const id = randomUUID();
    await writeJson(join(this.config.control, 'rehearsal', 'job.json'), { id, backup: relative(this.config.state, journal.backup!), previous: journal.previous.id, target: journal.target.id });
    await this.until(async () => {
      const status = await readJson<{ id: string; ok: boolean; error?: string }>(join(this.config.control, 'rehearsal', 'result.json'));
      if (status?.id !== id) return false;
      if (!status.ok) throw new Error(status.error || 'Isolated migration rehearsal failed');
      return true;
    }, 12 * 60_000, 'Isolated migration rehearsal timed out');
  }
  async execute(operation: MultiremiPlatformOperation, report: (value: ReportPlatformOperationInput) => Promise<void>, drain?: PlatformDrainGate): Promise<MultiremiPlatformRelease | null> {
    if (operation.kind === 'check_updates') return (await this.inspect()).currentRelease;
    if (!drain) throw new Error('Drain is required');
    const previousJournal = await this.journal(operation.id);
    if (previousJournal?.phase === 'verified') return previousJournal.target.release;
    if (previousJournal?.phase === 'recovered') throw new Error(previousJournal.error || 'Application update recovered');
    if (COMMITTED.has(operation.status)) {
      if (previousJournal?.phase === 'prepared') throw new Error('Update was interrupted before the container commit; application children were not changed');
      throw new RecoveryRequiredError('Committed operation requires internal journal recovery');
    }
    const preflight = await this.preflight();
    if (!preflight.ready) throw new Error(preflight.checks.filter(value => !value.ok).map(value => value.message).join('; '));
    const previous = await this.seed();
    let target = previous;
    if (operation.kind === 'update') {
      const manifest = parseApplicationManifest(operation.targetManifest);
      if (operation.targetVersion && operation.targetVersion.replace(/^v/, '') !== manifest.version.replace(/^v/, '')) throw new Error('Requested version differs from the application bundle');
      await this.validateRelease(manifest);
      await report({ status: 'pulling', previousRelease: previous.release, progress: { message: 'Downloading application and bundled runtimes inside Compose' } });
      target = await this.stage(manifest, operation.id);
    } else if (operation.kind === 'rollback') {
      const files = await readdir(join(this.config.state, 'history'));
      const retained = await Promise.all(files.map(file => readJson<Selection>(join(this.config.state, 'history', file))));
      const match = retained.find(value => value && (value.release.version === operation.targetVersion || value.release.ref === operation.targetRef));
      if (!match) throw new Error('Retained release not found');
      this.validateSelection(match);
      if (previous.release.dataSchema !== match.release.dataSchema && !previous.release.application.rollbackSafeFrom.includes(match.release.dataSchema)) throw new Error('Rollback migration compatibility was not reviewed');
      target = match;
    }
    await this.verifyFiles(releaseDirectory(this.config.root, target.id), target.release);
    await this.probe(target);
    await drain.waitUntilDrained(report);
    await drain.assertReady();
    const journal: Journal = { operationId: operation.id, kind: operation.kind, phase: 'prepared', previous, target };
    await writeJson(this.journalPath(operation.id), journal);
    await report({ status: operation.kind === 'restart' ? 'restarting' : 'switching', previousRelease: previous.release,
      progress: { message: 'Quiescing application children; containers and agents keep running' } });
    journal.phase = 'committed'; await writeJson(this.journalPath(operation.id), journal);
    try {
      await writeJson(join(this.config.control, 'write-fence.json'), { operationId: operation.id });
      await this.command('stop', previous);
      journal.backup = await createBackup(this.backup, this.runner, operation.id);
      await syncDirectory(journal.backup);
      await syncDirectory(dirname(journal.backup));
      await writeJson(this.journalPath(operation.id), journal);
      await this.rehearse(journal);
      await this.command('run', target);
      await this.verify(target);
      await this.record(target);
      journal.phase = 'verified'; await writeJson(this.journalPath(operation.id), journal);
      return target.release;
    } catch (error) {
      journal.error = error instanceof Error ? error.message : String(error);
      await this.recover(journal);
      throw error;
    }
  }
  private async record(selection: Selection) {
    await writeJson(join(this.config.state, 'history', selection.id + '.json'), selection);
    await writeJson(join(this.config.state, 'current.json'), selection);
  }
  private async recover(journal: Journal) {
    try {
      await writeJson(join(this.config.control, 'write-fence.json'), { operationId: journal.operationId });
      await this.verifyFiles(releaseDirectory(this.config.root, journal.previous.id), journal.previous.release);
      await this.command('stop', journal.previous);
      await this.command('run', journal.previous);
      await this.verify(journal.previous);
      await this.record(journal.previous);
      journal.phase = 'recovered'; await writeJson(this.journalPath(journal.operationId), journal);
    } catch { throw new RecoveryRequiredError('Internal recovery failed; application writes remain fenced and backups retained'); }
  }
  async recoverInterrupted() {
    const names = await entries(join(this.config.state, 'operations'));
    for (const file of names.filter(name => name.endsWith('.json'))) {
      const journal = await this.journal(file.slice(0, -5));
      if (journal?.phase === 'committed') await this.recover(journal);
    }
  }
  async pendingFinalization() {
    const fence = await readJson<{ operationId: string }>(join(this.config.control, 'write-fence.json'));
    if (!fence) return null;
    const journal = await this.journal(fence.operationId);
    if (!journal || !['verified', 'recovered'].includes(journal.phase)) throw new RecoveryRequiredError('Internal update still requires recovery');
    return { operationId: journal.operationId, report: {
      status: journal.phase === 'recovered' ? 'failed' as const : journal.kind === 'rollback' ? 'rolled_back' as const : 'succeeded' as const,
      resultRelease: (journal.phase === 'recovered' ? journal.previous : journal.target).release, error: journal.error ?? null,
    } };
  }
  async finalize(id: string) {
    const fence = await readJson<{ operationId: string }>(join(this.config.control, 'write-fence.json'));
    if (!fence) return;
    if (fence.operationId !== id) throw new RecoveryRequiredError('Another internal operation owns the write fence');
    const journal = await this.journal(id);
    if (!journal || !['verified', 'recovered'].includes(journal.phase)) throw new RecoveryRequiredError('Refusing to release an unverified update');
    await rm(join(this.config.control, 'write-fence.json'));
    await syncDirectory(this.config.control);
  }
}
