import { expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { MultiremiStore } from "@multiremi/store.js";
import { startMultiremiServer, TestMultiremiDaemon } from "../fixtures/daemon-protocol.js";
import { disabledSshMeshRuntime } from "../helpers/ssh-mesh-isolation.js";

it("saves a native Antigravity group, discovers models, and executes with isolated login", async () => {
  const root = mkdtempSync(join(tmpdir(), "native-agy-daemon-"));
  const originalHome = process.env.GEMINI_HOME;
  const originalPath = process.env.PATH;
  process.env.GEMINI_HOME = join(root, "login");
  mkdirSync(join(root, "login", "antigravity-cli"), { recursive: true });
  writeFileSync(join(root, "login", "antigravity-cli", "antigravity-oauth-token"), "fake-native-login");
  mkdirSync(join(root, "bin"));
  symlinkSync(resolve("tests/fixtures/antigravity-native-fake.mjs"), join(root, "bin", "agy"));
  process.env.PATH = `${join(root, "bin")}:${originalPath}`;
  const db = openSqliteDatabase(":memory:");
  const store = new MultiremiStore(db); store.ensureLocalWorkspace();
  const token = await store.createAccessToken({ name: "Native daemon", type: "daemon", workspaceId: "local", daemonId: "native-agy", userId: "local" });
  const server = startMultiremiServer({ store, scheduler: null, authToken: "native-root", hostname: "127.0.0.1", port: 0 });
  const observed: string[] = [];
  const daemon = new TestMultiremiDaemon({
    serverUrl: `http://127.0.0.1:${server.port}`, token: token.token, daemonId: "native-agy", runtimeName: "Native AGY",
    provider: "antigravity", workspaceId: "local", daemonPort: 0, pollIntervalMs: 20, gcEnabled: false,
    workspacesRoot: join(root, "workspaces"), repoCacheRoot: join(root, "cache"), pluginCacheRoot: join(root, "plugins"),
    sshMeshManager: disabledSshMeshRuntime(), inProcessRuntimeModelDiscoveryEnabled: true,
    providerFactory: options => ({
      async discoverModelCapabilities() {
        expect(options.agentType).toBe("antigravity");
        expect(options.antigravityNative).toBe(true);
        expect(options.gatewayShim).toBeUndefined();
        expect(readFileSync(join(options.providerHome!, "antigravity-cli", "antigravity-oauth-token"), "utf8")).toBe("fake-native-login");
        return [{ id: "native-model", label: "Native", default: true, effort: { supportedLevels: [{ value: "high", label: "High" }] } }];
      },
      async *sendStream() {
        expect(options.antigravityNative).toBe(true);
        expect(options.gatewayShim).toBeUndefined();
        expect(options.model).toBe("native-model");
        expect(readFileSync(join(options.providerHome!, "antigravity-cli", "antigravity-oauth-token"), "utf8")).toBe("fake-native-login");
        observed.push(options.providerHome!);
        yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "Native done" }] } as any;
      },
      getLastResponse: () => ({ text: "Native done", sessionId: "native-session" }),
      async close() {},
    }),
  });
  const run = daemon.start();
  try {
    await waitUntil(() => store.listRuntimes().length === 1);
    const runtime = store.listRuntimes()[0]!;
    expect(runtime.metadata.antigravity_native).toBe(1);
    const group = store.saveExecutionGroup("local", { name: "Native", provider: "antigravity", endpoint_id: null, runtime_ids: [runtime.id] });
    await waitUntil(() => store.getRuntimeBindingModelCatalog(group.id, runtime.id)?.status === "ready");
    expect(store.getRuntimeBindingModelCatalog(group.id, runtime.id)?.models[0]).toMatchObject({ id: "native-model", provider: "antigravity" });
    const agent = store.createAgent({ name: "Native", provider: "antigravity", executionGroupId: group.id, model: "native-model" });
    const chat = store.createChatSession({ agentId: agent.id });
    const task = store.sendChatMessage(chat.id, { body: "Native test" }).task;
    await waitUntil(() => ["completed", "failed"].includes(store.getTask(task.id)?.status ?? ""));
    expect(store.getTask(task.id)?.error).toBeNull();
    expect(store.getTask(task.id)?.status).toBe("completed");
    expect(observed).toHaveLength(1);
    expect(observed[0]).not.toBe(process.env.GEMINI_HOME);
  } finally {
    await daemon.stopAndDrainTestWork(); await run;
    server.stop(true); db.close();
    if (originalHome === undefined) delete process.env.GEMINI_HOME; else process.env.GEMINI_HOME = originalHome;
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
async function waitUntil(check: () => boolean) {
  const end = Date.now() + 15_000;
  while (!check()) { if (Date.now() > end) throw new Error("Native Antigravity test timed out"); await Bun.sleep(30); }
}
