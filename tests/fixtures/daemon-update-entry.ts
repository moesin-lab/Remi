/** Native candidate for the isolated update rehearsal; never a production CLI entry. */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MultiremiDaemon } from "@multiremi/daemon.js";
import { multiremiVersion } from "@multiremi/version.js";
import { AcpProvider } from "@acp/provider.js";
import { acquireWorkspaceSupervisorLease } from "@daemon/agent-runtime/workspace/process-owner.js";
import { buildMultiremiDaemonLaunchSpec, planDaemonRestart } from "../../apps/remi/cli/multiremi/service.js";
import { restartForegroundDaemonProcess } from "../../apps/remi/cli/multiremi.js";
if (process.env.NODE_ENV !== "test" || process.env.MULTIREMI_UPDATE_REHEARSAL !== "1") throw new Error("Explicit isolated rehearsal required");
if (process.argv.includes("--version")) { console.log(multiremiVersion); process.exit(0); }
const state = process.env.MULTIREMI_STATE_DIR!;
const home = process.env.HOME!;
mkdirSync(state, { recursive: true });
function lifecycle(event: string, detail: object = {}) {
  appendFileSync(join(state, "fixture-lifecycle.jsonl"), JSON.stringify({ at_ms: Date.now(), pid: process.pid,
    ppid: process.ppid, version: multiremiVersion, event, ...detail }) + "\n");
}
lifecycle("entry");
process.on("exit", code => lifecycle("exit", { code }));
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
const restartPlan = planDaemonRestart({ platform: process.platform, env: process.env,
  cgroup: process.platform === "linux" ? readFileSync("/proc/self/cgroup", "utf8") : null });
if (process.env.REHEARSAL_SYSTEMD === "1" && (restartPlan.kind !== "service-manager" ||
    !restartPlan.args.at(-1)?.startsWith("remi-rehearsal-"))) throw new Error("Rehearsal must restart its own transient unit");
const daemon = new MultiremiDaemon({
  serverUrl: process.env.MULTIREMI_SERVER_URL!, token: process.env.MULTIREMI_TOKEN!,
  daemonId: "mul28-rehearsal", provider: "codex", runtimeName: "MUL-28 candidate", workspaceId: "local",
  daemonPort: 0, workspacesRoot: workspaces, workspaceRootFence: lease.assertOwner,
  repoCacheRoot: join(state, "cache"), pluginCacheRoot: join(state, "plugins"), gcEnabled: false,
  updateRestartSpec: restartPlan.kind === "service-manager"
    ? { command: [restartPlan.command, ...restartPlan.args], manager: "systemd" }
    : { command: [spec.command, ...spec.args] }, updateVerifyTimeoutSeconds: process.env.REHEARSAL_SYSTEMD === "1" ? 60 : 5,
  sshMeshManager: { getHeartbeatStatus: () => ({ status: "disabled" }), reconcile: async () => {}, cleanupForRetirement: async () => {} },
  agentPluginProviderPreflight: async () => {},
  onReadyChange: ready => lifecycle("ready", { ready }),
  providerFactory: options => { lifecycle("provider-created"); return new AcpProvider({ ...options, agentType: "codex", executable: process.env.REHEARSAL_BUN!,
    args: [process.env.REHEARSAL_FAKE_ACP!], privateTmpDirectory: undefined,
    env: { ...options.env, BUN_BE_BUN: "1", FAKE_STEER_CONFIG: JSON.stringify({ advertise: "codex", prompts: [{ chunks: ["MUL28_TASK_OK"] }] }) },
  }); },
});
process.on("SIGTERM", () => { lifecycle("signal", { signal: "SIGTERM" }); void daemon.stop(); });
process.on("SIGINT", () => { lifecycle("signal", { signal: "SIGINT" }); void daemon.stop(); });
try { await daemon.start(); } finally { lease.release(); }
if (daemon.restartRequested()) restartForegroundDaemonProcess(cliOptions, "remi");
