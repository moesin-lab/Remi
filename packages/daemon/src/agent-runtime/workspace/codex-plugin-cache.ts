/** Curated marketplace copies are provider cache, even for active/unregistered subjects. */
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { StorageReport } from "@multiremi/contracts/storage.js";
import { listLaneGenerations, removeOwnedPath } from "./env-cleanup.js";
import type { ExecutionTracker } from "./execution-tracker.js";
import { envRoot } from "./layout.js";
import type { IssueWorkspaceLifecycleLocker } from "./lifecycle-lock.js";

export interface CodexPluginCacheOptions {
  root: string;
  mutate: boolean;
  tracker: ExecutionTracker;
  locker: IssueWorkspaceLifecycleLocker;
  assertRootOwner?: () => void;
  errors: StorageReport["errors"];
  /** Pressure rounds stop between individual cache entries once enough space is free. */
  pressureNeeded?: () => Promise<boolean>;
}

/**
 * Sweep only known provider homes, never work trees. The subject lock and running
 * check mirror reclaim, including subjects missing from the registry. A busy
 * subject keeps every execution's cache. No path component is followed through a link.
 */
export async function sweepCodexPluginCaches(options: CodexPluginCacheOptions): Promise<NonNullable<StorageReport["codex_plugin_cache"]>> {
  const result = { planned_homes: 0, cleaned_homes: 0 };
  const fail = (id: string | null, error: unknown) => {
    options.assertRootOwner?.();
    options.errors.push({ subject_id: id, message: `Codex curated cache: ${error instanceof Error ? error.message : String(error)}` });
  };
  let subjects: string[];
  try { subjects = directories(envRoot(options.root)); }
  catch (error) { fail(null, error); return result; }
  for (const id of subjects) {
    if (options.tracker.subjectRunning(id)) continue;
    const release = options.locker.tryAcquire(id);
    if (!release) continue;
    try {
      if (options.tracker.subjectRunning(id)) continue;
      for (const generation of listLaneGenerations(options.root, { kind: "chat", id })) {
        const homes = [join(generation.path, "home")];
        for (const fp of directories(join(generation.path, "executions"))) {
          homes.push(join(generation.path, "executions", fp, "home"));
        }
        for (const home of homes) {
          if (options.pressureNeeded && !(await options.pressureNeeded())) return result;
          try {
            if (!realDirectory(home)) continue;
            const tmp = join(home, ".tmp");
            if (!realDirectory(tmp)) continue;
            const names = readdirSync(tmp).filter(isCuratedCacheEntry);
            if (!names.length) continue;
            result.planned_homes++;
            if (!options.mutate) continue;
            let failed = false;
            for (const name of names) {
              if (options.pressureNeeded && !(await options.pressureNeeded())) return result;
              try {
                options.assertRootOwner?.();
                await removeOwnedPath(options.root, join(tmp, name), options);
              } catch (error) { failed = true; fail(id, error); }
            }
            if (!failed) result.cleaned_homes++;
          } catch (error) { fail(id, error); }
        }
      }
    } catch (error) { fail(id, error); }
    finally { release(); }
  }
  return result;
}

/** Codex 0.163.0 core-plugins/startup_sync.rs:389,533; observed `plugins-clone-wmUzz4` locally. */
function isCuratedCacheEntry(name: string): boolean {
  return name === "plugins" || name === "plugins.sha" || name === "plugins.sync.lock"
    || /^plugins-(clone|backup)-[A-Za-z0-9]+$/.test(name);
}

function realDirectory(path: string): boolean {
  const info = lstatSync(path, { throwIfNoEntry: false });
  return info?.isDirectory() === true && !info.isSymbolicLink();
}

function directories(path: string): string[] {
  if (!realDirectory(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => entry.name);
}
