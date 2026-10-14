import { createHash } from "node:crypto";
import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export interface LocalSource { id: string; name: string; home: string }
export function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function sourceId(home: string, stat: { dev: bigint; ino: bigint }): string {
  return `codex_${hash(`${home}\0${stat.dev}\0${stat.ino}`).slice(0, 24)}`;
}

/** Directory names are discovered locally; an RPC caller never supplies a filesystem path. */
export function discoverSources(home = homedir(), baseHome = process.env.CODEX_HOME, uid = process.getuid?.()): LocalSource[] {
  if (uid === undefined) return [];
  const candidates = [join(home, ".codex")];
  for (const entry of readdirSync(home, { withFileTypes: true })) {
    if (entry.name.startsWith(".codex-") && (entry.isDirectory() || entry.isSymbolicLink())) candidates.push(join(home, entry.name));
  }
  if (baseHome) candidates.push(resolve(baseHome));
  const sources = new Map<string, LocalSource>();
  for (const candidate of candidates) {
    try {
      const canonical = realpathSync(candidate);
      const stat = statSync(canonical, { bigint: true });
      if (!stat.isDirectory() || stat.uid !== BigInt(uid) || /(?:^|[/\\])(?:\.runtime|\.runtime-probe)(?:[/\\]|$)/.test(canonical)) continue;
      sources.set(canonical, { id: sourceId(canonical, stat), name: basename(candidate), home: canonical });
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  return [...sources.values()];
}

export function assertSourceOwned(source: LocalSource, uid: number | undefined): void {
  const stat = lstatSync(source.home, { bigint: true });
  if (uid === undefined || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(uid)
    || realpathSync(source.home) !== source.home || source.id !== sourceId(source.home, stat)) {
    throw new Error("External source ownership changed");
  }
}
