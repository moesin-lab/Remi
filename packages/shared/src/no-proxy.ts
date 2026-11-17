import { BlockList, isIP } from "node:net";

function unbracket(host: string): string {
  return host.replace(/^\[(.*)\]$/, "$1").toLowerCase();
}

/** Literal IP CIDRs only: never resolve a hostname to decide proxy routing. */
export function matchesNoProxy(url: string | URL, noProxy: string): boolean {
  const target = new URL(url);
  const host = unbracket(target.hostname);
  const port = target.port || (target.protocol === "https:" ? "443" : "80");
  return noProxy.split(",").some((raw) => {
    let entry = raw.trim().toLowerCase();
    if (!entry) return false;
    if (entry === "*") return true;
    // Brackets disambiguate an IPv6 literal with an optional port.
    const qualified = entry.match(/^\[([^\]]+)\](?::(\d+))?$/)
      ?? (entry.split(":").length === 2 ? entry.match(/^([^:]+):(\d+)$/) : null);
    if (qualified) {
      if (qualified[2] && qualified[2] !== port) return false;
      entry = qualified[1]!;
    }
    if (entry.includes("/")) {
      const parts = entry.split("/");
      if (parts.length !== 2 || !/^\d+$/.test(parts[1]!)) return false;
      const network = unbracket(parts[0]!);
      const family = isIP(network);
      const prefix = Number(parts[1]);
      if (!family || family !== isIP(host) || prefix > (family === 4 ? 32 : 128)) return false;
      const block = new BlockList();
      block.addSubnet(network, prefix, family === 4 ? "ipv4" : "ipv6");
      return block.check(host, family === 4 ? "ipv4" : "ipv6");
    }
    if (isIP(entry)) {
      if (isIP(host) !== isIP(entry)) return false;
      const block = new BlockList();
      block.addAddress(entry, isIP(entry) === 4 ? "ipv4" : "ipv6");
      return block.check(host, isIP(entry) === 4 ? "ipv4" : "ipv6");
    }
    entry = entry.replace(/^\./, "");
    return host === entry || host.endsWith(`.${entry}`);
  });
}

/** Match curl's lowercase precedence, including an explicitly empty value. */
export function shouldBypassProxy(url: string | URL, env: NodeJS.ProcessEnv = process.env): boolean {
  return matchesNoProxy(url, env.no_proxy ?? env.NO_PROXY ?? "");
}

/** Preserve each casing's existing list and its spawn-time machine fallback. */
export function appendTaskNoProxy(env: NodeJS.ProcessEnv, serverUrl: string): void {
  const hosts = [unbracket(new URL(serverUrl).hostname), "localhost", "127.0.0.1", "::1"];
  for (const key of ["NO_PROXY", "no_proxy"] as const) {
    const other = key === "NO_PROXY" ? "no_proxy" : "NO_PROXY";
    const existing = env[key] ?? process.env[key] ?? env[other] ?? process.env[other] ?? "";
    const entries = existing.split(",").map((entry) => entry.trim()).filter(Boolean);
    env[key] = [...new Set([...entries, ...hosts])].join(",");
  }
}
