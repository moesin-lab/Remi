import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, chmod, copyFile, lstat, mkdir, open, readdir, readFile, realpath, rename, stat, statfs } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { MultiremiPlatformPreflight, MultiremiPlatformRelease } from "@multiremi/contracts";
import type { CommandRunner } from "./types.js";
import migrationInputs from "./data-schema-inputs.json";

/** Include data migrations and the local helpers that change their behavior. */
export const DATA_SCHEMA_INPUTS: readonly string[] = migrationInputs;

export async function readMigrationSource(root: string): Promise<string> {
  return (await Promise.all(DATA_SCHEMA_INPUTS.map((path) => readFile(join(root, path), "utf8")))).join("");
}

export interface BackupConfig {
  directory: string;
  /** argv only: writes a transactionally consistent database dump to stdout. */
  databaseDumpCommand: string[];
  /** argv only: verifies a restore from stdin in scratch storage, never the live DB. */
  databaseVerifyCommand: string[];
  /** All durable API state, uploads, configuration and secrets; outside releases. */
  dataPaths: string[];
  /** Named volumes may be archived by a host-configured, read-only container command. */
  archives?: Array<{ name: string; dumpCommand: string[]; verifyCommand: string[] }>;
}

export class RecoveryRequiredError extends Error {}

export function migrationFingerprint(source: string): string {
  return createHash("sha256").update(source.replace(/\r\n/g, "\n")).digest("hex");
}

export function preflightResult(checks: MultiremiPlatformPreflight["checks"]): MultiremiPlatformPreflight {
  return { ready: checks.every((check) => check.ok), checkedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, checks };
}

export async function checkBackup(config: BackupConfig | undefined): Promise<void> {
  if (!config || !isAbsolute(config.directory) || !config.databaseDumpCommand?.length || !config.databaseVerifyCommand?.length || (!config.dataPaths?.length && !config.archives?.length)) {
    throw new Error("Configure a database dump, restore verification command and all persistent data paths before updating");
  }
  for (const command of [config.databaseDumpCommand, config.databaseVerifyCommand, ...(config.archives ?? []).flatMap((archive) => [archive.dumpCommand, archive.verifyCommand])]) {
    if (!Array.isArray(command) || !command.length || command.some((arg) => typeof arg !== "string" || !arg || arg.includes("\0"))) throw new Error("Invalid backup command argv");
  }
  const names = (config.archives ?? []).map((archive) => archive.name);
  if (names.some((name) => !/^[a-zA-Z0-9_-]+$/.test(name)) || new Set(names).size !== names.length) throw new Error("Backup archive names must be unique and contain only letters, numbers, underscores or hyphens");
  await mkdir(config.directory, { recursive: true, mode: 0o700 });
  const root = await realpath(config.directory);
  for (const path of config.dataPaths ?? []) {
    if (!isAbsolute(path)) throw new Error("Backup data paths must be absolute");
    const source = await realpath(path);
    if (isWithin(source, root) || isWithin(root, source)) throw new Error("Backup destination and data paths must not overlap");
    await access(source);
  }
  const probe = join(root, `.write-check-${randomUUID()}`);
  const handle = await open(probe, "wx", 0o600);
  await handle.close();
  const { unlink } = await import("node:fs/promises");
  await unlink(probe);
  const disk = await statfs(root);
  if (Number(disk.bavail) * Number(disk.bsize) < 256 * 1024 * 1024) throw new Error("Insufficient backup disk space (less than 256 MiB free)");
}

export function assertCompatible(previous: MultiremiPlatformRelease | null, next: { dataSchema?: string | null }): void {
  if (!previous?.dataSchema || !/^[a-f0-9]{64}$/i.test(previous.dataSchema) || previous.dataSchema !== next.dataSchema) {
    throw new Error("Data schema compatibility is unknown or changed; use a verified manual migration before automatic updates/rollback");
  }
}

export async function createBackup(config: BackupConfig | undefined, runner: CommandRunner, operationId: string): Promise<string> {
  await checkBackup(config);
  const settings = config!;
  if (!/^[a-zA-Z0-9_-]+$/.test(operationId)) throw new Error("Invalid operation ID");
  const directory = join(settings.directory, `${operationId}-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  const dump = join(directory, "database.dump");
  const [command, ...args] = settings.databaseDumpCommand;
  await (await open(dump, "wx", 0o600)).close();
  const result = await runner.run(command!, args, { stdoutFile: dump });
  if (result.exitCode !== 0 || (await stat(dump)).size === 0) throw new Error("Database backup failed; no services were switched");
  const [verify, ...verifyArgs] = settings.databaseVerifyCommand;
  const checked = await runner.run(verify!, verifyArgs, { stdinFile: dump });
  if (checked.exitCode !== 0) throw new Error("Database restore verification failed; no services were switched");
  const files: Array<{ path: string; bytes: number; sha256: string }> = [];
  files.push(await describeFile(directory, dump));
  for (const archive of settings.archives ?? []) {
    const path = join(directory, `volume-${archive.name}.archive`);
    await (await open(path, "wx", 0o600)).close();
    const dumped = await runner.run(archive.dumpCommand[0]!, archive.dumpCommand.slice(1), { stdoutFile: path });
    if (dumped.exitCode !== 0 || (await stat(path)).size === 0) throw new Error(`Persistent volume backup failed: ${archive.name}`);
    const verified = await runner.run(archive.verifyCommand[0]!, archive.verifyCommand.slice(1), { stdinFile: path });
    if (verified.exitCode !== 0) throw new Error(`Persistent volume archive verification failed: ${archive.name}`);
    files.push(await describeFile(directory, path));
  }
  for (let i = 0; i < (settings.dataPaths ?? []).length; i++) {
    await copyTree(settings.dataPaths[i]!, join(directory, `state-${i}`), directory, files);
  }
  // Re-read every copy before committing the backup manifest. No database is
  // ever restored automatically: that could discard writes made after this point.
  for (const file of files) {
    const verified = await describeFile(directory, join(directory, file.path));
    if (verified.bytes !== file.bytes || verified.sha256 !== file.sha256) throw new Error("Backup checksum verification failed");
  }
  await atomicJson(join(directory, "complete.json"), { operationId, createdAt: new Date().toISOString(), sources: settings.dataPaths, files });
  return directory;
}

async function copyTree(source: string, target: string, root: string, files: Array<{ path: string; bytes: number; sha256: string }>): Promise<void> {
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error("Persistent state contains a symlink; configure its resolved path explicitly");
  if (info.isDirectory()) {
    await mkdir(target, { mode: 0o700 });
    for (const entry of await readdir(source)) await copyTree(join(source, entry), join(target, entry), root, files);
  } else if (info.isFile()) {
    await copyFile(source, target);
    await chmod(target, 0o600);
    files.push(await describeFile(root, target));
  } else throw new Error("Unsupported persistent state file type");
}

async function describeFile(root: string, path: string) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += chunk.length; }
  const handle = await open(path, "r+");
  try { await handle.sync(); } finally { await handle.close(); }
  return { path: relative(root, path), bytes, sha256: hash.digest("hex") };
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temp, path);
}

export async function readJsonFile<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

/** Invalid recovery state must never be treated as an ordinary failed update. */
export async function readRecoveryJournal<T>(path: string, validate: (value: T) => void): Promise<T | null> {
  let source: string;
  try { source = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new RecoveryRequiredError("Cannot read recovery journal; inspect deployment before releasing maintenance");
  }
  try {
    const value = JSON.parse(source) as T;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid journal");
    validate(value);
    return value;
  } catch { throw new RecoveryRequiredError("Recovery journal is invalid; inspect deployment before releasing maintenance"); }
}

export function isWithin(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
