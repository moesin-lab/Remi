import type { ScmStoreFacade } from "./store.js";
import { matchScmRepositoryBindings } from "./repository-reference.js";

/** Server-only, read-request credentials. Never serialize or inject into task environments. */
export function createGitHubReadHeaders(store: Pick<ScmStoreFacade,
  "listScmConnections" | "listScmRepositoryBindings" | "getScmConnectionCredential">, workspaceId: string) {
  return (url: URL): HeadersInit => {
    if (url.protocol !== "https:" || url.port || url.username || url.password
      || !["github.com", "api.github.com", "raw.githubusercontent.com"].includes(url.hostname)) return {};
    const segments = url.pathname.split("/").filter(Boolean);
    if (url.hostname === "api.github.com" && segments.shift() !== "repos") return {};
    const [owner, repo] = segments;
    if (!owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return {};
    const reference = `https://github.com/${owner}/${repo}`;
    const bindings = matchScmRepositoryBindings(
      store.listScmRepositoryBindings({ workspaceId, enabled: true }), reference,
    );
    const connections = store.listScmConnections({ workspaceId, provider: "github", enabled: true })
      .filter(connection => connection.workspaceId === workspaceId && connection.enabled
        && connection.provider === "github" && connection.baseUrl === "https://github.com");
    // Explicit repository assignments precede the workspace's all-repositories connection.
    const candidates = connections.filter(connection => bindings.some(binding => binding.connectionId === connection.id))
      .sort((a, b) => a.id.localeCompare(b.id));
    candidates.push(...connections.filter(connection => connection.repositoryScope === "all"
      && connection.isDefault && !candidates.includes(connection)).sort((a, b) => a.id.localeCompare(b.id)));
    for (const connection of candidates) {
      try {
        const token = store.getScmConnectionCredential(connection.id)?.accessToken?.trim();
        if (token) return { Authorization: `Bearer ${token}` };
      } catch {
        // Disabled/unavailable encryption keys must not expose errors or credential material.
      }
    }
    const token = process.env.GITHUB_TOKEN?.trim();
    return token ? { Authorization: `Bearer ${token}` } : {};
  };
}
