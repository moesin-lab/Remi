/** Native candidate for the isolated update rehearsal; never a production CLI entry. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MultiremiDaemon } from "@multiremi/daemon.js";
import { multiremiVersion } from "@multiremi/version.js";
import { AcpProvider } from "@acp/provider.js";
import { acquireWorkspaceSupervisorLease } from "@daemon/agent-runtime/workspace/process-owner.js";
import { buildMultiremiDaemonLaunchSpec } from "../../apps/remi/cli/multiremi/service.js";
import { restartForegroundDaemonProcess } from "../../apps/remi/cli/multiremi.js";
if (process.env.NODE_ENV !== "test" || process.env.MULTIREMI_UPDATE_REHEARSAL !== "1") throw new Error("Explicit isolated rehearsal required");
if (process.argv.includes("--version")) { console.log(multiremiVersion); process.exit(0); }
const state = process.env.MULTIREMI_STATE_DIR!;
const home = process.env.HOME!;
mkdirSync(join(home, ".codex"), { recursive: true });
writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "fixture", refresh_token: "fixture" } }), { mode: 0o600 });
// The release is served by the isolated API, with real tar bytes, digest and version probes.
const upstreamFetch = globalThis.fetch;
globalThis.fetch = ((input: any, options: any) => {
  const url = String(input);
  return upstreamFetch(url.startsWith("https://api.github.com/repos/") ? `${process.env.REHEARSAL_RELEASE_URL}/metadata` : input, options);
}) as typeof fetch;
const cliOptions = { server: process.env.MULTIREMI_SERVER_URL!, provider: "codex", "daemon-port": "0" };
const workspaces = join(state, "workspaces");
const lease = acquireWorkspaceSupervisorLease(workspaces, { basePort: null });
const spec = buildMultiremiDaemonLaunchSpec(cliOptions, "remi", process.argv, process.execPath, true);
const daemon = new MultiremiDaemon({
  serverUrl: process.env.MULTIREMI_SERVER_URL!, token: process.env.MULTIREMI_TOKEN!,
  daemonId: "mul28-rehearsal", provider: "codex", runtimeName: "MUL-28 candidate", workspaceId: "local",
  daemonPort: 0, workspacesRoot: workspaces, workspaceRootFence: lease.assertOwner,
  repoCacheRoot: join(state, "cache"), pluginCacheRoot: join(state, "plugins"), gcEnabled: false,
  updateRestartSpec: { command: [spec.command, ...spec.args] }, updateVerifyTimeoutSeconds: 5,
  sshMeshManager: { getHeartbeatStatus: () => ({ status: "disabled" }), reconcile: async () => {}, cleanupForRetirement: async () => {} },
  agentPluginProviderPreflight: async () => {},
  providerFactory: options => new AcpProvider({ ...options, agentType: "codex", executable: process.env.REHEARSAL_BUN!,
    args: [process.env.REHEARSAL_FAKE_ACP!], privateTmpDirectory: undefined,
    env: { ...options.env, BUN_BE_BUN: "1", FAKE_STEER_CONFIG: JSON.stringify({ advertise: "codex", prompts: [{ chunks: ["MUL28_TASK_OK"] }] }) },
  }),
});
process.on("SIGTERM", () => daemon.stop());
process.on("SIGINT", () => daemon.stop());
try { await daemon.start(); } finally { lease.release(); }
if (daemon.restartRequested()) restartForegroundDaemonProcess(cliOptions, "remi");
