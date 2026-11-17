import { readdirSync, readlinkSync } from "node:fs";
import { sep } from "node:path";

/** Linux unlink succeeds with live SQLite handles; check them before deletion. */
export function assertNoOpenFilesUnder(directories: string[]): void {
  if (process.platform !== "linux") return; // Windows rmSync itself enforces this.
  const openFiles = readdirSync("/proc/self/fd").flatMap(fd => {
    try { return [readlinkSync(`/proc/self/fd/${fd}`)]; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; // fd closed during scan
      throw error;
    }
  }).filter(path => directories.some(dir => path.startsWith(`${dir}${sep}`)));
  if (openFiles.length) throw new Error(`Test resources still open before deletion:\n${openFiles.join("\n")}`);
}
