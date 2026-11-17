/** Interactive entry point for the shared, verified CLI installer. */
import { loadMultiremiConfig } from "@multiremi/config.js";
import { BUILD_COMMIT } from "@shared/version.js";
import { VERSION } from "@shared/version.js";
import { detectUpdatePlatform, performUpdate } from "@shared/cli-update.js";
import * as ui from "./ui.js";
export * from "@shared/cli-update.js";

export async function runUpdate(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log([
      "Usage: remi update",
      "",
      "Download and verify the latest Remi CLI release, then atomically update the local launcher.",
      "The daemon is not restarted. Configured platform first; GitHub fallback for 404/unreachable.\nSet MULTIREMI_UPDATE_SOURCES=platform,github to select sources, MULTIREMI_RELEASE_REPO for GitHub.",
    ].join("\n"));
    return;
  }
  if (args.length > 0) throw new Error(`usage: remi update (unexpected argument: ${args[0]})`);

  ui.banner("Remi Update", VERSION);
  const platform = detectUpdatePlatform();
  ui.info(`Platform: ${platform.os}-${platform.arch}`);
  ui.info(`Current version: v${VERSION}`);
  console.log("");

  try {
    const config = loadMultiremiConfig();
    const result = await performUpdate({
      platform,
      serverUrl: process.env.MULTIREMI_SERVER_URL?.trim() || config.server_url,
      token: process.env.MULTIREMI_TOKEN?.trim() || config.token,
      currentCommit: BUILD_COMMIT,
      onProgress: (message) => console.log(`${message}...`),
    });
    if (result.status === "current") {
      ui.pass(`Already up to date (v${result.version}).`);
      return;
    }
    ui.pass(`Installed v${result.version} at ${result.snapshotDir}`);
    ui.info(`Launcher: ${result.launcherPath}`);
    if (result.launchdUpdated) ui.info("Updated launchd to use the stable launcher.");
    console.log("The running daemon was not restarted. Run `remi restart` during an approved maintenance window.");
  } catch (error) {
    ui.fail(`Update failed: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
