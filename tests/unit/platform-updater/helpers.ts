import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { migrationFingerprint, type BackupConfig } from "@remi-platform/updater/safety.js";
import type { CommandOptions, CommandResult } from "@remi-platform/updater/types.js";

export const DATA_SCHEMA = migrationFingerprint("test migrations");
export const READY_GATE = { waitUntilDrained: async () => {}, assertReady: async () => {}, release: async () => {} };

export function testBackup(root: string): BackupConfig {
  const data = join(root, "persistent");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "user-data.txt"), "preserve all user data");
  return { directory: join(root, "backups"), databaseDumpCommand: ["test-dump"], databaseVerifyCommand: ["test-verify"], dataPaths: [data] };
}

export function safetyCommand(command: string, args: string[], options?: CommandOptions): CommandResult | null {
  if (args.includes("/app/packages/server/src/store/migrations.ts")) return { exitCode: 0, stdout: "test migrations", stderr: "" };
  if (command === "test-dump") { writeFileSync(options!.stdoutFile!, "database snapshot"); return { exitCode: 0, stdout: "", stderr: "" }; }
  if (args.includes("config") && args.includes("--format")) return { exitCode: 0, stdout: JSON.stringify({ name: "test-project", services: { api: {}, web: {} } }), stderr: "" };
  if (args[0] === "info") return { exitCode: 0, stdout: "linux", stderr: "" };
  return null;
}
