import { expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { MultiremiStore } from "@multiremi/store.js";
import {
  startMultiremiServer,
  TestMultiremiDaemon as MultiremiDaemon,
} from "../fixtures/daemon-protocol.js";
import { disabledSshMeshRuntime } from "../helpers/ssh-mesh-isolation.js";

// Real HTTP, WebSocket configuration, credential delivery, worker and isolated
// provider homes. Only the external model implementation is a test double.
for (const provider of ["codex", "claude"] as const) {
  it(`${provider}: executes group defaults and explicit models on one machine without mixing provider connections`, async () => {
    const root = mkdtempSync(join(tmpdir(), "remi-group-execution-"));
    const originalKey = process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY;
    const homeVariable =
      provider === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
    const originalHome = process.env[homeVariable];
    process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = Buffer.alloc(
      32,
      23,
    ).toString("base64");
    process.env[homeVariable] = join(root, "base-home");
    const db = openSqliteDatabase(":memory:");
    const store = new MultiremiStore(db);
    store.ensureLocalWorkspace();
    const token = await store.createAccessToken({
      name: "Group daemon",
      type: "daemon",
      workspaceId: "local",
      daemonId: "group-daemon",
      userId: "local",
    });
    const human = await store.createAccessToken({
      name: "Group administrator",
      type: "pat",
      workspaceId: "local",
      userId: "local",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "isolated-group-test",
      hostname: "127.0.0.1",
      port: 0,
    });
    const observed: {
      model: string;
      url: string;
      key: string | undefined;
      home: string;
    }[] = [];
    const daemon = new MultiremiDaemon({
      sshMeshManager: disabledSshMeshRuntime(),
      serverUrl: `http://127.0.0.1:${server.port}`,
      token: token.token,
      daemonId: "group-daemon",
      runtimeName: "Group worker",
      provider,
      workspaceId: "local",
      daemonPort: 0,
      pollIntervalMs: 20,
      gcEnabled: false,
      workspacesRoot: join(root, "workspaces"),
      repoCacheRoot: join(root, "cache"),
      pluginCacheRoot: join(root, "plugins"),
      providerFactory: (options) => ({
        async *sendStream() {
          const home = options.env![homeVariable]!;
          const text = readFileSync(
            join(home, provider === "codex" ? "config.toml" : "settings.json"),
            "utf8",
          );
          const config = (
            provider === "codex" ? parse(text) : JSON.parse(text)
          ) as any;
          observed.push({
            model: config.model,
            url:
              provider === "codex"
                ? config.model_providers.remi_custom.base_url
                : config.env.ANTHROPIC_BASE_URL,
            key:
              provider === "codex"
                ? options.env?.OPENAI_API_KEY
                : options.env?.ANTHROPIC_AUTH_TOKEN,
            home,
          });
          expect(text).not.toContain("group-secret-");
          yield {
            sessionUpdate: "agent_message_chunk",
            content: [{ type: "text", text: "Group task completed" }],
          } as any;
        },
        getLastResponse: () => ({
          text: "Group task completed",
          sessionId: `group-session-${observed.length}`,
          requestId: `group-request-${observed.length}`,
        }),
      }),
    });
    const run = daemon.start();
    const request = async (path: string, input: unknown, method = "POST") => {
      const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${human.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      });
      const text = await response.text();
      expect(text).not.toContain("group-secret-");
      if (!response.ok) throw new Error(`${response.status}: ${text}`);
      return JSON.parse(text);
    };
    try {
      await waitUntil(
        () => store.listRuntimes().length === 1,
        "runtime registration",
      );
      const runtimeId = store.listRuntimes()[0]!.id;
      for (const index of [1, 2]) {
        const connection = {
          name: `Provider ${index}`,
          profile: {
            name: `group${index}`,
            base_url: `https://group${index}.example/v1`,
            model: `default-${index}`,
            models: [`default-${index}`, `explicit-${index}`],
            auth_mode: "api_key",
            env_key: "",
          },
          api_key: `group-secret-${index}`,
        };
        const group = (
          await request("/api/execution-groups", {
            name: `Group ${index}`,
            provider,
            description: "Execution integration",
            profile_id: null,
            runtime_ids: [runtimeId],
            connection,
          })
        ).group;
        await waitUntil(
          () =>
            store.isRuntimeExecutionBindingReady(
              group.id,
              runtimeId,
              group.profile_id,
              1,
            ),
          "group binding ready",
        );
        const model = index === 1 ? "" : `explicit-${index}`;
        const agent = store.createAgent({
          name: `Agent ${index}`,
          provider,
          executionGroupId: group.id,
          model,
        });
        const chat = store.createChatSession({ agentId: agent.id });
        const task = store.sendChatMessage(chat.id, {
          body: "Verify group configuration",
        }).task;
        await waitUntil(
          () =>
            ["completed", "failed"].includes(
              store.getTask(task.id)?.status ?? "",
            ),
          "group task completion",
        );
        expect(store.getTask(task.id)?.error).toBeNull();
        expect(store.getTask(task.id)?.status).toBe("completed");
        expect(observed[index - 1]).toMatchObject({
          model: model || connection.profile.model,
          url: connection.profile.base_url,
          key: connection.api_key,
        });
      }
      expect(observed).toHaveLength(2);
      expect(observed[0]!.home).not.toBe(observed[1]!.home);
      expect(store.getRuntimeCodexProfile(runtimeId)).toBeNull();
      expect(store.getRuntimeClaudeProfile(runtimeId)).toBeNull();
      expect(store.getRuntimeExecutionBindings(runtimeId)).toHaveLength(2);
      expect(
        await Bun.file(
          join(
            process.env[homeVariable]!,
            provider === "codex" ? "config.toml" : "settings.json",
          ),
        ).exists(),
      ).toBe(false);
    } finally {
      daemon.stop();
      await run.catch(() => {});
      await daemon.daemonProtocolClient().drain();
      server.stop(true);
      db.close();
      if (originalKey === undefined)
        delete process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY;
      else process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = originalKey;
      if (originalHome === undefined) delete process.env[homeVariable];
      else process.env[homeVariable] = originalHome;
      rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    }
  }, 30_000);
}

async function waitUntil(check: () => boolean, label: string) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${label}`);
    await Bun.sleep(20);
  }
}
