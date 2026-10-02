import { expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMultiremiServer, TestMultiremiDaemon as MultiremiDaemon } from "../fixtures/daemon-protocol.js";
import type { MultiremiDaemonClient } from "@multiremi/client.js";

import { MultiremiStore } from "@multiremi/store.js";
import type { RuntimeExecutionBindingAck } from "@multiremi/contracts/runtime-connection.js";

async function waitUntil(check: () => boolean, description: string) {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await Bun.sleep(10);
  }
}

it("syncs multiple centrally configured profiles through real WebSocket daemon configuration frames and rejects delayed revision acknowledgements", async () => {
  const previousKey = process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY;
  const previousMissingEnv = process.env.REMI_CODEX_ISOLATED_TEST_UNCONFIGURED;
  delete process.env.REMI_CODEX_ISOLATED_TEST_UNCONFIGURED;
  process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32, 31).toString("base64");
  const root = mkdtempSync(join(tmpdir(), "remi-central-profile-sync-"));
  const db = openSqliteDatabase(":memory:");
  const store = new MultiremiStore(db);
  store.ensureLocalWorkspace();
  const daemonToken = await store.createAccessToken({ name: "Isolated daemon", type: "daemon", workspaceId: "local", daemonId: "central-profile-test", userId: "local" });
  const humanToken = await store.createAccessToken({ name: "Isolated administrator", type: "pat", workspaceId: "local", userId: "local" });

  const receivedAcks: RuntimeExecutionBindingAck[][] = [];
  const fetchedCredentialIds = new Set<string>();
  let providerCalls = 0;
  let holdHeartbeat = false;
  let heldHeartbeat = false;
  let releaseHeartbeat: (() => void) | undefined;
  const server = startMultiremiServer({ store, authToken: "isolated-test-root", hostname: "127.0.0.1", port: 0 });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const daemon = new MultiremiDaemon({
    serverUrl: baseUrl, token: daemonToken.token, daemonId: "central-profile-test", runtimeName: "Central profile test",
    provider: "codex", workspaceId: "local", daemonPort: 0, pollIntervalMs: 20, requestTimeoutMs: 5_000, gcEnabled: false,
    workspacesRoot: join(root, "workspaces"), repoCacheRoot: join(root, "repos"), pluginCacheRoot: join(root, "plugins"),
    providerFactory: () => ({ async *sendStream() { providerCalls++; }, getLastResponse: () => null }),
    sshMeshManager: { getHeartbeatStatus: () => ({ status: "disabled" }), reconcile: async () => {}, cleanupForRetirement: async () => {} },
  });
  const client = (daemon as unknown as { client: MultiremiDaemonClient }).client;
  const reportAcks = client.reportRuntimeBindingAcks.bind(client);
  client.reportRuntimeBindingAcks = async (rt, acks) => {
    receivedAcks.push(acks);
    if (holdHeartbeat) {
      heldHeartbeat = true;
      await new Promise<void>(resolve => { releaseHeartbeat = resolve; });
    }
    await reportAcks(rt, acks);
  };
  const fetchKey = client.getRuntimeCodexProfileKey.bind(client);
  client.getRuntimeCodexProfileKey = async (rt, id) => { fetchedCredentialIds.add(id); return fetchKey(rt, id); };
  let daemonError: unknown;
  const run = daemon.start().catch((error) => { daemonError = error; });
  const human = async (path: string, body?: unknown, method = body ? "POST" : "GET") => {
    const response = await fetch(`${baseUrl}${path}`, {
      method, headers: { Authorization: `Bearer ${humanToken.token}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json() as any;
    expect(response.ok).toBe(true);
    return result;
  };
  const connection = (model: string) => ({ name: model, base_url: "https://never-contacted.example/v1", model, env_key: "", auth_mode: "api_key" });
  try {
    await waitUntil(() => store.listRuntimes().length === 1 && (daemon as any).runtimeProfileSnapshotReceived === true, "daemon registration and first WebSocket configuration");
    const runtimeId = store.listRuntimes()[0]!.id;
    const first = (await human("/api/execution-profiles", { name: "Profile A", provider: "codex", profile: connection("model-a"), api_key: "isolated-key-a" })).profile;
    const second = (await human("/api/execution-profiles", { name: "Profile B", provider: "codex", profile: connection("model-b"), api_key: "isolated-key-b" })).profile;
    const groupA = (await human("/api/execution-groups", { name: "Group A", provider: "codex", profile_id: first.id, runtime_ids: [runtimeId] })).group;
    const groupB = (await human("/api/execution-groups", { name: "Group B", provider: "codex", profile_id: second.id, runtime_ids: [runtimeId] })).group;
    await waitUntil(() => store.isRuntimeExecutionBindingReady(groupA.id, runtimeId, first.id, 1)
      && store.isRuntimeExecutionBindingReady(groupB.id, runtimeId, second.id, 1), "two independently applied profiles acknowledged by daemon");
    expect(fetchedCredentialIds.has(first.profile.credential_id)).toBe(true);
    expect(fetchedCredentialIds.has(second.profile.credential_id)).toBe(true);
    expect((await human(`/api/execution-groups/${groupA.id}`)).group.members[0].status).toBe("ready");
    expect((await human(`/api/execution-groups/${groupB.id}`)).group.members[0].status).toBe("ready");
    expect(store.getRuntimeCodexProfile(runtimeId)).toBeNull();

    const oldAcks = receivedAcks.findLast((acks) => acks.some((ack) => ack.groupId === groupA.id && ack.status === "ready"))!;
    holdHeartbeat = true;

    const updated = (await human(`/api/execution-profiles/${first.id}`, {
      name: "Profile A", provider: "codex", profile: connection("model-a-v2"), api_key: "isolated-key-a-v2",
    }, "PUT")).profile;
    expect(updated.revision).toBe(2);
    expect((await human(`/api/execution-groups/${groupA.id}`)).group.members[0].status).toBe("pending");
    await waitUntil(() => heldHeartbeat, "new revision application held before its acknowledgement");
    await reportAcks(runtimeId, oldAcks);
    store.recordRuntimeExecutionBindingAcks(runtimeId, oldAcks);
    expect(store.isRuntimeExecutionBindingReady(groupA.id, runtimeId, first.id, 2)).toBe(false);
    expect((await human(`/api/execution-groups/${groupA.id}`)).group.members[0].status).toBe("pending");
    holdHeartbeat = false;
    releaseHeartbeat?.();
    await waitUntil(() => store.isRuntimeExecutionBindingReady(groupA.id, runtimeId, first.id, 2), "updated routing and credential revision applied by daemon");
    expect(fetchedCredentialIds.has(updated.profile.credential_id)).toBe(true);
    expect(store.isRuntimeExecutionBindingReady(groupB.id, runtimeId, second.id, 1)).toBe(true);

    const missing = (await human("/api/execution-profiles", {
      name: "Missing credential", provider: "codex",
      profile: { ...connection("missing-env"), auth_mode: "env", env_key: "REMI_CODEX_ISOLATED_TEST_UNCONFIGURED" },
    })).profile;
    const failingGroup = (await human("/api/execution-groups", { name: "Failed application", provider: "codex", profile_id: missing.id, runtime_ids: [runtimeId] })).group;
    await waitUntil(() => store.getExecutionGroupMembers(failingGroup.id, "local")[0]?.status === "error", "daemon reporting failed configuration without fallback");
    expect((await human(`/api/execution-groups/${failingGroup.id}`)).group.members[0].status).toBe("error");
    expect(store.isRuntimeExecutionBindingReady(failingGroup.id, runtimeId, missing.id, 1)).toBe(false);
    expect(store.isRuntimeExecutionBindingReady(groupA.id, runtimeId, first.id, 2)).toBe(true);
    expect(providerCalls).toBe(0);
    expect(daemonError).toBeUndefined();
  } finally {
    holdHeartbeat = false;
    releaseHeartbeat?.();
    daemon.stop();
    await run;
    server.stop(true);
    db.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    if (previousKey === undefined) delete process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY;
    else process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = previousKey;
    if (previousMissingEnv === undefined) delete process.env.REMI_CODEX_ISOLATED_TEST_UNCONFIGURED;
    else process.env.REMI_CODEX_ISOLATED_TEST_UNCONFIGURED = previousMissingEnv;
  }
}, 15_000);
