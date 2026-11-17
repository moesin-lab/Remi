import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performUpdate, compareVersions, fetchLatestRelease, type UpdateOptions } from "@shared/cli-update.js";
import { parseDaemonArtifactManifest } from "@shared/daemon-artifact-manifest.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const commit = "a".repeat(40);
const version = "0.2.95-stable.ab12cd34";
function fixture(reportedCommit: string | null = commit) {
  const root = mkdtempSync(join(tmpdir(), "platform-cli-update-")); roots.push(root);
  const staged = join(root, "staged"); mkdirSync(staged);
  const binary = join(staged, "remi");
  writeFileSync(binary, `#!/bin/sh\nif [ "$1" = "--build-info" ]; then echo '${JSON.stringify({ version, commit: reportedCommit })}'; else echo '${version}'; fi\n`);
  chmodSync(binary, 0o755);
  const archivePath = join(root, "archive.tar.gz");
  execFileSync("tar", ["-czf", archivePath, "-C", staged, "remi"]);
  const archive = readFileSync(archivePath);
  const file = `remi-${version}-linux-x64.tar.gz`;
  const manifest = { schema: 1, version, commit, artifacts: [{ os: "linux", arch: "x64", file,
    sha256: createHash("sha256").update(archive).digest("hex"), size: archive.length }] };
  const requests: Array<{ url: string; headers: Headers }> = [];
  const logs: string[] = [];
  let metadataStatus = 200;
  let downloadStatus = 200;
  let unreachable = false;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); requests.push({ url, headers: new Headers(init?.headers) });
    if (url.startsWith("https://platform.test")) {
      if (unreachable) throw new Error("contains secret-token");
      if (url.endsWith(".tar.gz")) return new Response(archive, { status: downloadStatus });
      return metadataStatus === 200 ? Response.json(manifest) : new Response("contains secret-token", { status: metadataStatus });
    }
    if (url.includes("api.github.com")) return Response.json({ tag_name: `v${version}`, assets: [{ name: file,
      browser_download_url: "https://download.test/archive", digest: `sha256:${manifest.artifacts[0]!.sha256}`, size: archive.length }] });
    return new Response(archive);
  }) as typeof fetch;
  const launcherPath = join(root, "remi"); writeFileSync(launcherPath, "#!/bin/sh\necho previous\n");
  const options: UpdateOptions = { serverUrl: "https://platform.test", token: "secret-token", currentVersion: "0.2.94",
    platform: { os: "linux", arch: "x64" }, homeDir: root, installRoot: join(root, "install"), launcherPath,
    launchdPath: join(root, "absent.plist"), env: { PATH: "", GITHUB_TOKEN: "github-secret" }, fetchImpl,
    onProgress: message => { logs.push(message); } };
  return { options, manifest, requests, logs, launcherPath, setStatus: (value: number) => { metadataStatus = value; },
    setDownloadStatus: (value: number) => { downloadStatus = value; }, offline: () => { unreachable = true; } };
}
test("platform installs a verified build, authenticates both requests and journals its identity", async () => {
  const f = fixture(); let attested: unknown;
  const result = await performUpdate({ ...f.options, beforeActivate: value => { attested = value; } });
  expect(result).toMatchObject({ status: "installed", version, source: "platform", commit });
  expect(attested).toMatchObject({ source: "platform", commit });
  expect(f.requests.map(r => r.url)).toEqual(["https://platform.test/api/remi/releases/daemon/current",
    `https://platform.test/api/remi/releases/daemon/${commit}/${f.manifest.artifacts[0]!.file}`]);
  expect(f.requests.every(r => r.headers.get("Authorization") === "Bearer secret-token")).toBe(true);
  expect(f.logs.join("\n")).toContain("Using platform");
  expect(f.logs.join("\n")).not.toContain("secret-token");
});
for (const reason of ["404", "unreachable", "download404"] as const) test(`${reason} falls back to GitHub with daemon GITHUB_TOKEN`, async () => {
  const f = fixture();
  if (reason === "404") f.setStatus(404); else if (reason === "unreachable") f.offline(); else f.setDownloadStatus(404);
  expect(await performUpdate(f.options)).toMatchObject({ status: "installed", source: "github" });
  expect(f.requests.find(r => r.url.includes("api.github.com"))!.headers.get("Authorization")).toBe("Bearer github-secret");
  expect(f.requests.find(r => r.url.includes("download.test"))!.headers.has("Authorization")).toBe(false);
  expect(f.logs.join("\n")).toContain("Using github");
});
for (const failure of ["size", "sha256", "commit", "null-commit", "version", "schema", "manifest-commit"] as const) test(`${failure} integrity failure never falls back or replaces launcher`, async () => {
  const f = fixture(failure === "commit" ? "b".repeat(40) : failure === "null-commit" ? null : commit);
  if (failure === "size") f.manifest.artifacts[0]!.size++;
  if (failure === "sha256") f.manifest.artifacts[0]!.sha256 = "0".repeat(64);
  if (failure === "version") f.manifest.version = "0.2.95-stable.other";
  if (failure === "schema") f.manifest.schema = 2;
  if (failure === "manifest-commit") f.manifest.commit = "bad";
  await expect(performUpdate(f.options)).rejects.toThrow();
  expect(f.requests.some(r => r.url.includes("github"))).toBe(false);
  expect(readFileSync(f.launcherPath, "utf8")).toContain("echo previous");
  expect(existsSync(join(f.options.installRoot!, "versions"))).toBe(false);
});
for (const status of [400, 401, 403, 500]) test(`HTTP ${status} is a hard failure`, async () => {
  const f = fixture(); f.setStatus(status);
  await expect(performUpdate(f.options)).rejects.toThrow(`HTTP ${status}`);
  expect(f.requests).toHaveLength(1);
});
test("explicit commit selects the platform even with github-only preference and never falls back", async () => {
  const f = fixture();
  expect(await performUpdate({ ...f.options, targetCommit: commit, env: { MULTIREMI_UPDATE_SOURCES: "github" } })).toMatchObject({ commit });
  expect(f.requests[0]!.url).toEndWith(`/${commit}`);
  const failed = fixture(); failed.setStatus(404);
  await expect(performUpdate({ ...failed.options, targetCommit: commit })).rejects.toThrow();
  expect(failed.requests).toHaveLength(1);
});
test("explicit commit and version must both match the manifest", async () => {
  const f = fixture();
  await expect(performUpdate({ ...f.options, targetCommit: "b".repeat(40) })).rejects.toThrow("target_commit");
  await expect(performUpdate({ ...f.options, targetVersion: "0.2.95-stable.other" })).rejects.toThrow("target_version");
  expect(f.requests.every(r => !r.url.includes("github"))).toBe(true);
});
for (const source of ["github", "platform"] as const) test(`${source}-only source selection`, async () => {
  const f = fixture();
  expect(await performUpdate({ ...f.options, env: { MULTIREMI_UPDATE_SOURCES: source } })).toMatchObject({ source });
  expect(f.requests.every(r => source === "platform" ? r.url.includes("platform.test") : !r.url.includes("platform.test"))).toBe(true);
  if (source === "platform") {
    f.setStatus(404);
    await expect(performUpdate({ ...f.options, env: { MULTIREMI_UPDATE_SOURCES: source } })).rejects.toThrow();
    expect(f.requests.some(r => r.url.includes("github"))).toBe(false);
  }
});
test("same version with a different commit installs; the identical build skips download", async () => {
  const f = fixture();
  expect(await performUpdate({ ...f.options, currentVersion: version, currentCommit: "b".repeat(40) })).toMatchObject({ status: "installed" });
  const current = fixture();
  expect(await performUpdate({ ...current.options, currentVersion: version, currentCommit: commit })).toMatchObject({ status: "current", source: "platform" });
  expect(current.requests).toHaveLength(1);
  expect(compareVersions(version, "0.2.95-stable.other")).not.toBe(0);
});
test("GitHub fetch errors and status text do not expose credentials", async () => {
  const token = "do-not-print-this";
  const fetchImpl = (async () => { throw new Error(`Authorization: Bearer ${token}`); }) as unknown as typeof fetch;
  await expect(fetchLatestRelease("moesin-lab/Remi", fetchImpl, undefined, { GITHUB_TOKEN: token })).rejects.toThrow("source unreachable");
  const denied = (async () => new Response(null, { status: 401, statusText: token })) as unknown as typeof fetch;
  try { await fetchLatestRelease("moesin-lab/Remi", denied, undefined, { GITHUB_TOKEN: token }); }
  catch (error) { expect(String(error)).not.toContain(token); }
  const f = fixture(); f.offline();
  try { await performUpdate({ ...f.options, env: { MULTIREMI_UPDATE_SOURCES: "platform" } }); }
  catch (error) { expect(String(error)).not.toContain("secret-token"); }
});
for (const [field, value] of [["file", "../remi.tar.gz"], ["file", ".hidden.tar.gz"], ["sha256", "bad"], ["size", 0], ["os", "windows"]] as const) test(`manifest rejects unsafe ${field} with a field path`, () => {
  const f = fixture(); Object.assign(f.manifest.artifacts[0]!, { [field]: value });
  expect(() => parseDaemonArtifactManifest(f.manifest)).toThrow(`artifacts[0].${field}`);
});
test("callback errors are redacted before reaching daemon update output", async () => {
  const f = fixture();
  try {
    await performUpdate({ ...f.options, beforeActivate: () => { throw new Error("secret-token github-secret"); } });
    throw new Error("expected rejection");
  } catch (error) {
    expect(String(error)).toContain("[REDACTED]");
    expect(String(error)).not.toContain("secret-token");
    expect(String(error)).not.toContain("github-secret");
  }
});
