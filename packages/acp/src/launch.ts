import { basename } from "node:path";

/** Windows needs Node for JavaScript bridges and the extensionless wrapper. */
export function resolveAcpProcessLaunch(executable: string, args: string[] = [], platform: NodeJS.Platform = process.platform): { executable: string; args: string[] } {
  if (platform === "win32" && (basename(executable) === "remi-claude-agent-acp" || /\.[cm]?js$/i.test(executable))) {
    return { executable: Bun.which("node") ?? "node", args: [executable, ...args] };
  }
  return { executable, args };
}
