/** Resolve trusted release metadata; integrity errors must never select another source. */
import { parseDaemonArtifactManifest } from "./daemon-artifact-manifest.js";
import { fetchLatestRelease, releaseAssetName, releaseRepository, type UpdateOptions, type UpdatePlatform } from "./cli-update.js";

export interface CliUpdateArtifact {
  source: "platform" | "github";
  version: string;
  commit?: string;
  assetName: string;
  url: string;
  sha256: string;
  size?: number;
  headers: Record<string, string>;
}
class SourceUnavailable extends Error {}

/** Never surface fetch exceptions: they can contain request headers or credential-bearing URLs. */
export async function fetchUpdateResource(fetchImpl: typeof fetch, url: string, headers: Record<string, string>): Promise<Response> {
  try {
    return await fetchImpl(url, { headers, redirect: "manual", signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new SourceUnavailable("Update source is unreachable");
  }
}

export async function resolveUpdateArtifact(options: UpdateOptions, platform: UpdatePlatform): Promise<CliUpdateArtifact> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  if (options.targetCommit && !/^[a-f0-9]{40}$/.test(options.targetCommit)) throw new Error("Invalid target_commit");
  const sources = options.targetCommit ? ["platform"] : (env.MULTIREMI_UPDATE_SOURCES ?? "platform,github").split(",").map(s => s.trim());
  if (!sources.length || sources.some(s => s !== "platform" && s !== "github")) throw new Error("Invalid MULTIREMI_UPDATE_SOURCES; expected platform and/or github");
  for (const [index, source] of sources.entries()) {
    try {
      if (source === "platform") {
        if (!options.serverUrl) throw new SourceUnavailable("Platform update source is not configured");
        const base = new URL(options.serverUrl);
        if (!/^https?:$/.test(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error("Invalid platform update URL");
        const root = `${base.href.replace(/\/+$/, "")}/api/remi/releases/daemon`;
        const headers: Record<string, string> = options.token ? { Authorization: `Bearer ${options.token}` } : {};
        const response = await fetchUpdateResource(fetchImpl, `${root}/${options.targetCommit ?? "current"}`, headers);
        if (response.status === 404) throw new SourceUnavailable("Platform update artifact not found (404)");
        if (!response.ok) throw new Error(`Platform release lookup failed: HTTP ${response.status}`);
        let manifest;
        try { manifest = parseDaemonArtifactManifest(await response.json()); }
        catch { throw new Error("Invalid platform daemon artifact manifest"); }
        if (options.targetCommit && manifest.commit !== options.targetCommit) throw new Error("Platform release does not match target_commit");
        const artifact = manifest.artifacts.find(a => a.os === platform.os && a.arch === platform.arch);
        if (!artifact) throw new Error(`Platform release has no ${platform.os}-${platform.arch} artifact`);
        return { source: "platform", version: manifest.version, commit: manifest.commit,
          assetName: artifact.file, sha256: `sha256:${artifact.sha256}`, size: artifact.size,
          url: `${root}/${manifest.commit}/${encodeURIComponent(artifact.file)}`, headers };
      }
      const release = await fetchLatestRelease(releaseRepository(env), fetchImpl, options.targetVersion, env);
      const version = release.tag_name.replace(/^v/, "");
      const assetName = releaseAssetName(version, platform);
      const asset = release.assets.find(a => a.name === assetName);
      if (!asset) throw new Error(`Release ${release.tag_name} has no ${platform.os}-${platform.arch} asset (${assetName})`);
      return { source: "github", version, assetName, url: asset.browser_download_url,
        sha256: asset.digest ?? "", size: asset.size, headers: { Accept: "application/octet-stream" } };
    } catch (error) {
      if (!(error instanceof SourceUnavailable) || source !== "platform" || index === sources.length - 1) throw error;
      await options.onProgress?.("Platform update source unavailable; trying GitHub fallback");
    }
  }
  throw new Error("No update source available");
}
