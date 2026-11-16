import type { MultiremiScmRepositoryBinding } from "@multiremi/contracts/types.js";

/** Resolve only within the caller's authorized, enabled workspace bindings. */
export function matchScmRepositoryBindings(
  bindings: readonly MultiremiScmRepositoryBinding[],
  reference: string,
): MultiremiScmRepositoryBinding[] {
  const byId = bindings.filter(binding => binding.repositoryId === reference);
  if (byId.length) return byId;
  const fullName = /^[^\s/:@]+\/[^\s/:@]+$/.test(reference)
    ? reference.replace(/\.git$/i, "").toLowerCase() : null;
  const remote = remoteKey(reference);
  return bindings.filter(binding => fullName
    ? `${binding.owner}/${binding.name}`.toLowerCase() === fullName
    : remote !== null && remoteKey(binding.repositoryUrl) === remote);
}

function remoteKey(value: string): string | null {
  const scp = value.match(/^(?:[^@/:\s]+@)?([^/:\s]+):(.+)$/);
  try {
    const url = new URL(scp && !value.includes("://") ? `ssh://${scp[1]}/${scp[2]}` : value);
    if (!["https:", "http:", "ssh:", "git:", "git+ssh:"].includes(url.protocol)
      || !url.hostname || url.password || url.search || url.hash) return null;
    const path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    if (!path || /\s/.test(path)) return null;
    return `${url.hostname}${url.port ? `:${url.port}` : ""}/${path}`.toLowerCase();
  } catch { return null; }
}
