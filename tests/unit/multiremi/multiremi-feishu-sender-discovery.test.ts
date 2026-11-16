import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";

const ADMIN = { Authorization: "Bearer MASTER", "Content-Type": "application/json" };
let previousKey: string | undefined;
let fetchMock: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
beforeEach(() => {
  previousKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ code: 99991672 }));
});
afterEach(() => {
  fetchMock.mockRestore();
  if (previousKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousKey;
  resetMultiremiTestEnv();
});

function fixture() {
  const store = createLocalStore();
  const agent = store.createAgent({ name: "Personal bot", provider: "codex", workspaceId: "local" });
  store.registerRuntime({ id: "rt_bot", name: "Bot", provider: "codex", workspaceId: "local", daemonId: "daemon_bot" });
  store.heartbeatRuntime("rt_bot", { supportsFeishuBotConfig: true });
  const config = store.upsertFeishuBotConfig("local", {
    agentId: agent.id, runtimeId: "rt_bot", appId: "cli_personal", domain: "feishu", enabled: true,
    senderAccessPolicy: "allowlist",
    appSecretOp: "set", appSecret: "fixture-app-secret-not-a-real-credential",
  });
  const app = createMultiremiApp({ store, authToken: "MASTER" });
  const submit = (message: string, chat = "oc_one", extra: Record<string, string> = {}) => store.submitFeishuBotMessage("local", "rt_bot", {
    revision: config.revision, externalSessionKey: chat, externalMessageId: message,
    senderOpenId: "ou_alice", senderName: "Alice", text: "Please create an Issue", ...extra,
  });
  // A sender that is not allowlisted is recorded for approval but starts no Task.
  const reject = (...args: Parameters<typeof submit>) => expect(() => submit(...args)).toThrow("allowlist");
  return { store, agent, config, app, submit, reject };
}

const BASE = "/api/workspaces/local/feishu-bot/senders";

describe("Feishu sender discovery and allowlist management", () => {
  it("enriches a rejected sender from the contact profile without changing authorization", async () => {
    const { app, reject } = fixture();
    reject("om_profile", "oc_one", { senderName: "Feishu user" });
    fetchMock.mockImplementation((async (url: string | URL | Request) => String(url).includes("tenant_access_token")
      ? Response.json({ code: 0, tenant_access_token: "test-token" })
      : String(url).includes("/contact/v3/users/basic_batch")
        ? Response.json({ code: 0, data: { users: [{ user_id: "ou_alice", name: "陈测试", i18n_name: { en_us: "Test Chen" } }] } })
        : Response.json({ code: 404 })) as typeof fetch);
    expect((await app.request(BASE)).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    const response = await app.request(BASE, { headers: ADMIN });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ senders: [{
      open_id: "ou_alice", display_name: "陈测试", name_en: "Test Chen", allowed: false,
    }] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]![0])).toContain("/contact/v3/users/basic_batch");
  });

  it("discovers accounts from messages, deduplicates across chats and keeps approval when identity details change", async () => {
    const { app, submit, reject, store } = fixture();
    const initial = await app.request(BASE, { headers: ADMIN });
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ senders: [] });
    reject("om_one");
    reject("om_one");
    reject("om_two", "oc_two", { senderUnionId: "on_alice" });
    const listed = await (await app.request(BASE, { headers: ADMIN })).json();
    expect(listed.senders).toHaveLength(1);
    const sender = listed.senders[0];
    expect(sender).toMatchObject({ app_id: "cli_personal", open_id: "ou_alice", union_id: "on_alice", display_name: "Alice", allowed: false });
    const allowed = await app.request(`${BASE}/${sender.id}`, { method: "PUT", headers: ADMIN, body: JSON.stringify({ allowed: true }) });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ id: sender.id, allowed: true });
    const inbound = submit("om_three", "oc_one", { senderName: "Alice renamed" });
    const refreshed = await (await app.request(BASE, { headers: ADMIN })).json();
    expect(refreshed.senders).toHaveLength(1);
    expect(refreshed.senders[0]).toMatchObject({ id: sender.id, union_id: "on_alice", display_name: "Alice renamed", allowed: true, first_seen_at: sender.first_seen_at });
    expect(store.getTask(inbound.taskId)?.requestingUserProfileDescription).not.toContain("Workspace membership");
    const revoked = await app.request(`${BASE}/${sender.id}`, { method: "PUT", headers: ADMIN, body: JSON.stringify({ allowed: false }) });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({ allowed: false });
    expect(store.listFeishuBotAudit("local").filter((entry) => entry.action === "sender_allowed" || entry.action === "sender_revoked")).toHaveLength(2);
  });

  it("does not grant access from workspace membership or carry approval to another bot application", async () => {
    const { store, app, reject, config, agent } = fixture();
    store.getOrCreateUser({ externalId: "ou_sso", feishuUnionId: "on_owner", email: store.getCurrentUser().email, name: "Owner" });
    reject("om_owner", "oc_one", { senderUnionId: "on_owner" });
    const [sender] = store.listFeishuBotSenders("local");
    expect(sender?.allowed).toBe(false);
    store.setFeishuBotSenderAllowed("local", sender!.id, true, "local");
    const replacement = store.upsertFeishuBotConfig("local", {
      agentId: agent.id, runtimeId: "rt_bot", appId: "cli_other", domain: "feishu", enabled: true,
      appSecretOp: "set", appSecret: "fixture-other-secret-not-a-real-credential",
    });
    expect(replacement.revision).toBeGreaterThan(config.revision);
    expect(await (await app.request(BASE, { headers: ADMIN })).json()).toEqual({ senders: [] });
    expect((await app.request(`${BASE}/${sender!.id}`, { method: "PUT", headers: ADMIN, body: JSON.stringify({ allowed: true }) })).status).toBe(404);
    expect(() => store.submitFeishuBotMessage("local", "rt_bot", { revision: replacement.revision, externalSessionKey: "oc_one",
      externalMessageId: "om_other_app", senderOpenId: "ou_alice", text: "Create Issue" })).toThrow("allowlist");
    expect(store.listFeishuBotSenders("local")).toHaveLength(1);
    expect(store.listFeishuBotSenders("local")[0]?.id).not.toBe(sender!.id);
  });

  it("requires a human manager, validates the decision and refuses fabricated senders", async () => {
    const { store, app, submit, reject } = fixture();
    reject("om_auth");
    const [sender] = store.listFeishuBotSenders("local");
    store.setFeishuBotSenderAllowed("local", sender!.id, true, "local");
    const inbound = submit("om_auth_approved");
    store.setFeishuBotSenderAllowed("local", sender!.id, false, "local");
    const taskToken = await store.createTaskAccessToken(store.getTask(inbound.taskId)!, "local");
    for (const method of ["GET", "PUT"]) {
      const response = await app.request(method === "GET" ? BASE : `${BASE}/${sender!.id}`, {
        method, headers: { ...ADMIN, Authorization: `Bearer ${taskToken.token}` },
        ...(method === "PUT" ? { body: JSON.stringify({ allowed: true }) } : {}),
      });
      expect(response.status).toBe(403);
    }
    for (const body of [{}, { allowed: "true" }, { allowed: 1 }]) {
      expect((await app.request(`${BASE}/${sender!.id}`, { method: "PUT", headers: ADMIN, body: JSON.stringify(body) })).status).toBe(400);
    }
    expect((await app.request(`${BASE}/missing`, { method: "PUT", headers: ADMIN, body: JSON.stringify({ allowed: true }) })).status).toBe(404);
    expect(store.listFeishuBotSenders("local")[0]?.allowed).toBe(false);
  });
});
