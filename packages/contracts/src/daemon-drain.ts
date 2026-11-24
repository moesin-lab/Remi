/** Default for manual, deployment and CLI-update drains: five minutes. */
export const DEFAULT_DAEMON_DRAIN_MS = 5 * 60_000;
export type DaemonDrainReason = "manual" | "cli_update" | "deploy";
export interface DaemonDrainStatus {
  workspace_id: string;
  daemon_id: string;
  mode: "normal" | "draining";
  status: "normal" | "draining" | "drained" | "drained_forced";
  started_at: string | null;
  deadline: string | null;
  reason: DaemonDrainReason | null;
  forced_at: string | null;
  remaining_tasks: number;
  awaiting_daemon_ack: boolean;
  expiry_action: "planned_restart";
}
export function parseDaemonDrainDuration(value: string): number {
  if (typeof value !== "string") throw new Error("deadline must be a duration string (e.g. 5m)");
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(value);
  const ms = match ? Number(match[1]) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2]!] ?? 0) : NaN;
  if (!Number.isSafeInteger(ms) || ms < 1 || ms > 86_400_000) throw new Error("deadline must be a positive duration up to 24h (e.g. 30s, 5m)");
  return ms;
}
