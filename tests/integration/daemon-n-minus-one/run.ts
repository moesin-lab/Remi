/** Real release source on each side; only the model provider is deterministic. */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const [serverRoot, daemonRoot] = process.argv.slice(2).map(path => resolve(path));
if (!serverRoot || !daemonRoot) throw new Error("usage: run.ts <server checkout> <daemon checkout>");
const root = mkdtempSync(join(tmpdir(), "remi-mixed-"));
const children: ReturnType<typeof Bun.spawn>[] = [];
const entries = new Set<string>();
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(MULTIREMI_|REMI_|CLAUDE_|CODEX_|OPENAI_|XDG_)/.test(key)) delete env[key];
}
// The complete subprocess HOME is disposable; no real provider CLI or credentials.
env.HOME = join(root, "home");
env.CLAUDE_CONFIG_DIR = join(root, "claude");
env.CODEX_HOME = join(root, "codex");
for (const dir of [env.HOME, env.CLAUDE_CONFIG_DIR, env.CODEX_HOME]) mkdirSync(dir, { recursive: true });
async function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 45_000;
  let value: T;
  do {
    for (const child of children) if (child.exitCode !== null) throw new Error(`${label}: endpoint exited ${child.exitCode}`);
    value = await read();
    if (done(value)) return value;
    await Bun.sleep(30);
  } while (Date.now() < deadline);
  throw new Error(`${label}: timed out; last=${JSON.stringify(value)}`);
}
function spawn(checkout: string, mode: string) {
  const entry = join(checkout, `.mul174-endpoint-${process.pid}.ts`);
  copyFileSync(join(import.meta.dir, "endpoint.ts.template"), entry);
  entries.add(entry);
  const child = Bun.spawn([process.execPath, entry, mode, root, join(root, "config.json")],
    { cwd: checkout, env, stdout: "inherit", stderr: "inherit" });
  children.push(child);
}
try {
  spawn(serverRoot, "server");
  await until(() => existsSync(join(root, "config.json")), Boolean, "server startup");
  const config = await Bun.file(join(root, "config.json")).json();
  spawn(daemonRoot, "daemon");
  const call = async (path: string) => {
    const response = await fetch(`${config.control}${path}`);
    if (!response.ok) throw new Error(`control ${path}: ${response.status}`);
    return response.json() as Promise<any>;
  };
  await until(() => call("/runtime"), runtimes => runtimes.length > 0, "runtime registration");
  const task = await call("/enqueue?body=complete");
  const completed = await until(() => call(`/task?id=${task.id}`), task => ["completed", "failed"].includes(task.status), "one round");
  if (completed.status !== "completed" || completed.result !== "mixed-version completed") throw new Error(JSON.stringify(completed));
  const cancel = await call("/enqueue?body=WAIT_FOR_CANCEL");
  await until(() => existsSync(join(root, "provider-running")), Boolean, "cancel round starts in provider");
  await call(`/cancel?id=${cancel.id}`);
  await until(() => existsSync(join(root, "provider-cancelled")), Boolean, "daemon consumes cancellation");
  const cancelled = await call(`/task?id=${cancel.id}`);
  if (cancelled.status !== "cancelled") throw new Error(JSON.stringify(cancelled));
  const revision = (cwd: string) => execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  console.log(JSON.stringify({ server: revision(serverRoot), daemon: revision(daemonRoot), completed: completed.status,
    cancelled: cancelled.status, provider: "deterministic test provider; no model service exercised" }));
} finally {
  for (const child of children.toReversed()) {
    child.kill("SIGTERM");
    await Promise.race([child.exited, Bun.sleep(5_000)]);
    if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
  }
  for (const entry of entries) rmSync(entry, { force: true });
  rmSync(root, { recursive: true, force: true });
}
