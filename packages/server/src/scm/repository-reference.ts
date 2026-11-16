import type { MultiremiScmRepositoryBinding } from "@multiremi/contracts/types.js";

/** Resolve only within the caller's authorized, enabled workspace bindings. */
export function matchScmRepositoryBindings(
  bindings: readonly MultiremiScmRepositoryBinding[],
  reference: string,
): MultiremiScmRepositoryBinding[] {
  // Reject spellings that WHATWG URL parsing silently normalizes before matching.
  if (reference !== reference.trim() || /[\x00-\x20\x7f\\]/.test(reference)) return [];
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
  if (value !== value.trim() || /[\x00-\x20\x7f\\]/.test(value)) return null;
  // Validate the same raw authority we parse, including empty userinfo and missing //.
  if (/^https?:/i.test(value) && !/^https?:\/\/[^/\\?#@\s]+(?:\/|$)/i.test(value)) return null;
  const scp = value.match(/^(?:[^@/:\s]+@)?([^/:\s]+):(.+)$/);
  try {
    const url = new URL(scp && !value.includes("://") ? `ssh://${scp[1]}/${scp[2]}` : value);
    if (!["https:", "http:", "ssh:", "git:", "git+ssh:"].includes(url.protocol)
      || !url.hostname || url.password || url.search || url.hash) return null;
    // HTTP userinfo can be a token in the username alone; SSH git@ remains valid.
    if (["https:", "http:"].includes(url.protocol)
      && url.username) return null;
    const path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    if (!path || /\s/.test(path)) return null;
    const defaultPort = ({ "ssh:": "22", "git+ssh:": "22", "https:": "443", "http:": "80" } as Record<string, string>)[url.protocol];
    const port = url.port === defaultPort ? "" : url.port;
    return `${url.hostname}${port ? `:${port}` : ""}/${path}`.toLowerCase();
  } catch { return null; }
}
