import type { DiskLevel, DiskSpace, StorageDisk, StorageSettings } from "@multiremi/contracts/storage.js";
import { resolveStorageSettings } from "@multiremi/contracts/storage.js";
import type { DaemonHealth } from "@multiremi/contracts/daemon-protocol.js";
import { diskSpace } from "./disk-usage.js";

export const DISK_CHECK_MS = 30_000;
export const PRESSURE_RETRY_MS = 5 * 60_000;
export const DISK_HYSTERESIS_BYTES = 2 * 1024 ** 3;
export const DISK_HYSTERESIS_PERCENT = 1;
export type DiskThresholds = Pick<StorageSettings, "pressure_free_percent" | "pressure_free_bytes" | "critical_free_percent" | "critical_free_bytes">;

/** All workspaces share one filesystem. Each enabled condition uses the strictest policy. */
export function strictestDiskThresholds(policies: readonly StorageSettings[]): DiskThresholds {
  const source = policies.length ? policies : [resolveStorageSettings(undefined)];
  return Object.fromEntries((["pressure_free_percent", "pressure_free_bytes", "critical_free_percent", "critical_free_bytes"] as const)
    .map(key => [key, Math.max(...source.map(policy => policy[key]))])) as DiskThresholds;
}

export function diskThreshold(space: DiskSpace, policy: DiskThresholds, level: "pressure" | "critical"): number {
  return Math.max(policy[`${level}_free_bytes`], policy[`${level}_free_percent`] * space.total_bytes / 100);
}

/** Disabled conditions have no hysteresis. A failed measurement is handled by the caller, preserving state. */
export function classifyDiskSpace(space: DiskSpace, policy: DiskThresholds, previous: DiskLevel = "ok"): DiskLevel {
  const margin = Math.max(DISK_HYSTERESIS_BYTES, space.total_bytes * DISK_HYSTERESIS_PERCENT / 100);
  const critical = diskThreshold(space, policy, "critical");
  const pressure = diskThreshold(space, policy, "pressure");
  if (critical > 0 && (space.free_bytes < critical || (previous === "critical" && space.free_bytes <= critical + margin))) return "critical";
  if (pressure > 0 && (space.free_bytes < pressure || (previous !== "ok" && space.free_bytes <= pressure + margin))) return "pressure";
  return "ok";
}

/** One per daemon, including non-leaders. Never changes other claim pause sources. */
export class DiskPressureMonitor {
  latest: StorageDisk | undefined;
  private inFlight: Promise<void> | null = null;
  private lastPressureAttempt = -Infinity;
  private pressurePending = false;
  constructor(private readonly options: {
    path: string;
    thresholds(): DiskThresholds;
    read?: typeof diskSpace;
    now?: () => number;
    criticalChanged(disk: StorageDisk, wasCritical: boolean): void;
    pressure(): Promise<void>;
    pressureError?(error: unknown): void;
  }) {}
  get critical(): boolean { return this.latest?.level === "critical"; }
  health(): DaemonHealth {
    const disk = this.latest;
    return {
      state: this.critical ? "degraded" : "ok",
      reasons: !disk || disk.level === "ok" ? [] : [{
        code: disk.level === "critical" ? "disk_critical" : "disk_pressure",
        detail: { path: this.options.path, free_bytes: disk.free_bytes, total_bytes: disk.total_bytes },
      }],
    };
  }
  check(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const run = this.measure().finally(() => { if (this.inFlight === run) this.inFlight = null; });
    this.inFlight = run;
    return run;
  }
  private async measure(): Promise<void> {
    const space = await (this.options.read ?? diskSpace)(this.options.path);
    if (!space) return;
    const now = this.options.now?.() ?? Date.now();
    const thresholds = this.options.thresholds();
    const previous = this.latest?.level ?? "ok";
    const level = classifyDiskSpace(space, thresholds, previous);
    this.latest = { ...space, level, measured_at: new Date(now).toISOString(), thresholds };
    if ((previous === "critical") !== (level === "critical")) this.options.criticalChanged(this.latest, previous === "critical");
    if (level === "ok") this.lastPressureAttempt = -Infinity;
    else if (!this.pressurePending && now - this.lastPressureAttempt >= PRESSURE_RETRY_MS) {
      this.lastPressureAttempt = now;
      this.pressurePending = true;
      // Reclaim may take minutes. It must never block the next health measurement.
      void this.options.pressure().catch(error => this.options.pressureError?.(error))
        .finally(() => { this.pressurePending = false; });
    }
  }
}
