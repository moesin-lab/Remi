/** Subprocess regression: exercise the real supervisor's default process.exit. */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { instantiateCoResidentWorkerDaemons } from "../../apps/remi/cli/multiremi.js";
import { disabledSshMeshRuntime } from "../helpers/ssh-mesh-isolation.js";

const root = process.argv[2]!;
const bridges = await Promise.all([0, 1].map(async () => {
  const child = spawn("/bin/sh", ["-c", "sleep 300 & wait"], { detached: true, stdio: "ignore" });
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  return child;
}));
const daemons = instantiateCoResidentWorkerDaemons((["codex", "claude"] as const).map((provider, index) => ({
  serverUrl: "http://127.0.0.1:1", provider, daemonPort: 0,
  workspacesRoot: root, repoCacheRoot: join(root, "cache"), outboxPath: ":memory:",
  sshMeshManager: disabledSshMeshRuntime(), stopTimeoutMs: 50 + index * 100,
})));
for (const [index, daemon] of daemons.entries()) {
  const internals = daemon as any;
  internals.runActive = true;
  internals.liveUpdateProviders.set({ processGroupId: () => bridges[index]!.pid }, "hung-chat");
}
console.log(JSON.stringify(bridges.map(child => child.pid)));
// The timers intentionally are unref'ed in production; simulate hung cleanup keeping the loop live.
setInterval(() => {}, 1000);
for (const daemon of daemons) daemon.stop();
