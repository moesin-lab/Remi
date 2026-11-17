/** Shared wire contract for platform-hosted CLI archives (MUL-74 A/B). */
export const DAEMON_ARTIFACT_MANIFEST_FILE = "daemon-artifacts.json";
export type DaemonArtifactOs = "linux" | "darwin";
export type DaemonArtifactArch = "x64" | "arm64";
export interface DaemonArtifact {
  os: DaemonArtifactOs; arch: DaemonArtifactArch;
  file: string; sha256: string; size: number;
}
export interface DaemonArtifactManifest {
  schema: 1;
  version: string;
  commit: string;
  artifacts: readonly DaemonArtifact[];
}
export function isBuildCommit(value: string): boolean { return /^[0-9a-f]{40}$/.test(value); }
export function parseDaemonArtifactManifest(input: unknown): DaemonArtifactManifest {
  const invalid = (path: string): never => { throw new Error(`Invalid daemon artifact manifest: ${path}`); };
  if (!input || typeof input !== "object") return invalid("manifest");
  const m = input as DaemonArtifactManifest;
  if (m.schema !== 1) return invalid("schema");
  if (typeof m.version !== "string" || !m.version.trim() || m.version.startsWith("v")) return invalid("version");
  if (typeof m.commit !== "string" || !isBuildCommit(m.commit)) return invalid("commit");
  if (!Array.isArray(m.artifacts) || !m.artifacts.length) return invalid("artifacts");
  const platforms = new Set<string>();
  for (const [index, a] of m.artifacts.entries()) {
    const path = `artifacts[${index}]`;
    if (!a || typeof a !== "object") return invalid(path);
    if (!["linux", "darwin"].includes(a.os)) return invalid(`${path}.os`);
    if (!["x64", "arm64"].includes(a.arch)) return invalid(`${path}.arch`);
    if (typeof a.file !== "string" || !/^[A-Za-z0-9._-]+\.tar\.gz$/.test(a.file) || a.file.startsWith(".")) return invalid(`${path}.file`);
    if (typeof a.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(a.sha256)) return invalid(`${path}.sha256`);
    if (!Number.isSafeInteger(a.size) || a.size <= 0) return invalid(`${path}.size`);
    if (platforms.has(`${a.os}-${a.arch}`)) return invalid(`${path}.os/arch duplicate`);
    platforms.add(`${a.os}-${a.arch}`);
  }
  return m;
}
