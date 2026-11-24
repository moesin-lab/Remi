import { execFileSync } from "node:child_process";

/** Build/test inputs require the existing full backend plan; docs and frontend alone do not. */
export function backendRequired(event: string, changed: readonly string[] | null): boolean {
  if (event !== "pull_request" || changed === null) return true;
  return changed.some(path => /^(packages\/|apps\/|tests\/|scripts\/|bin\/|deploy\/|\.github\/workflows\/)/.test(path)
    || /^(package\.json|bun\.lock|bunfig\.toml|tsconfig\.json)$/.test(path));
}

if (import.meta.main) {
  let changed: string[] | null = null;
  const { EVENT_NAME = "", BASE_SHA, HEAD_SHA } = process.env;
  if (EVENT_NAME === "pull_request" && BASE_SHA && HEAD_SHA) {
    try {
      changed = execFileSync("git", ["diff", "--no-renames", "--name-only", "-z", BASE_SHA, HEAD_SHA], { encoding: "utf8" })
        .split("\0").filter(Boolean);
    } catch {
      console.error("Cannot determine PR changes; requiring full backend coverage");
    }
  }
  console.log(`required=${backendRequired(EVENT_NAME, changed)}`);
}
