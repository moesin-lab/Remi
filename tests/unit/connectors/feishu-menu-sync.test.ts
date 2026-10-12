import { afterEach, describe, expect, it } from "bun:test";
import { MenuSyncer } from "@connectors/feishu/sdk.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Feishu bot menu publisher", () => {
  it("validates a dry run without requesting a token or publishing", async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      throw new Error("dry run must not access the network");
    }) as unknown as typeof globalThis.fetch;

    const result = await new MenuSyncer({ appId: "test-app", appSecret: "test-secret" }).syncAll({
      default: [{ name: "Default", behaviors: [{ type: "send_message" }] }],
      users: [{
        userId: "union-target",
        userIdType: "union_id",
        items: [{ name: "Personal", behaviors: [{ type: "event_key", eventKey: "personal" }] }],
      }],
    }, { dryRun: true });

    expect(result).toEqual({ dryRun: true, defaultPublished: true, userMenuCount: 1 });
    expect(fetchCount).toBe(0);
  });

  it("names the failing endpoint when the gateway answers with a non-JSON body", async () => {
    // A 5xx from the gateway in front of the open API is HTML, not JSON.
    // Parsing it blindly reported "Unexpected token <", which says nothing
    // about which call broke.
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response("<html>504 Gateway Time-out</html>", { status: 504 })) as typeof globalThis.fetch;

    const syncer = new MenuSyncer({ appId: "test-app", appSecret: "test-secret" });
    const publish = syncer.syncAll({ default: [{ name: "Default", behaviors: [{ type: "send_message" }] }] });

    await expect(publish).rejects.toThrow(/Feishu tenant access token returned HTTP 504/);
  });

  it("gives up on a stalled Feishu call instead of hanging the publish", async () => {
    // `fetch` has no default timeout: before this bound, one unanswered call
    // held the publish open until the control plane expired the request.
    const signals: Array<AbortSignal | null | undefined> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal);
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }) as typeof globalThis.fetch;

    const syncer = new MenuSyncer({ appId: "test-app", appSecret: "test-secret" }, { requestTimeoutMs: 25 });
    const publish = syncer.syncAll({ default: [{ name: "Default", behaviors: [{ type: "send_message" }] }] });

    await expect(publish).rejects.toThrow(/Feishu tenant access token timed out after 25ms/);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it("keeps the resolved identifier type when publishing personalized menus", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.includes("tenant_access_token")) {
        return Response.json({ code: 0, tenant_access_token: "test-token", expire: 7200 });
      }
      return Response.json({ code: 0 });
    }) as typeof globalThis.fetch;

    const result = await new MenuSyncer({ appId: "test-app", appSecret: "test-secret" }).syncAll({
      users: [{
        userId: "union-target",
        userIdType: "union_id",
        items: [{ name: "Personal", behaviors: [{ type: "send_message" }] }],
      }],
    });

    expect(result).toEqual({ dryRun: false, defaultPublished: false, userMenuCount: 1 });
    const publish = requests.find((request) => request.url.includes("/bot/v3/bot_menu"));
    expect(publish?.url).toContain("user_id_type=union_id");
    expect(JSON.parse(String(publish?.init?.body))).toEqual({
      user_id: "union-target",
      bot_menu: { bot_menu_items: [{ name: "Personal", i18n_name: { en_us: "Personal" }, behaviors: [{ type: "send_message" }] }] },
    });
  });
  it("clears known personalized menus and publishes an explicitly empty shared menu", async () => {
    const requests: Array<{ method: string; body: unknown; url: string }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ method: init?.method ?? "GET", body: JSON.parse(String(init?.body)), url: String(url) });
      return Response.json(String(url).includes("tenant_access_token")
        ? { code: 0, tenant_access_token: "fixture-token", expire: 7200 } : { code: 0 });
    }) as typeof globalThis.fetch;
    const config = { default: [], clearUsers: [{ userId: "known-union", userIdType: "union_id" as const }], unresolvedLegacyTargetCount: 1 };
    const syncer = new MenuSyncer({ appId: "fixture-app", appSecret: "fixture-secret" });
    await syncer.syncAll(config, { dryRun: true });
    expect(requests).toEqual([]);
    expect(await syncer.syncAll(config)).toEqual({ dryRun: false, defaultPublished: true, userMenuCount: 0, clearedUserMenuCount: 1, unresolvedLegacyTargetCount: 1 });
    expect(requests.filter(request => request.url.includes("/bot/v3/bot_menu"))).toEqual([
      { method: "POST", body: { bot_menu: { bot_menu_items: [] } }, url: expect.stringContaining("user_id_type=open_id") },
      { method: "DELETE", body: { user_id: "known-union" }, url: expect.stringContaining("user_id_type=union_id") },
    ]);
  });

  it("reports a failed legacy cleanup instead of claiming publication succeeded", async () => {
    globalThis.fetch = (async (url: RequestInfo | URL) => Response.json(String(url).includes("tenant_access_token")
      ? { code: 0, tenant_access_token: "fixture-token" } : { code: 999, msg: "permission denied" })) as typeof globalThis.fetch;
    const syncer = new MenuSyncer({ appId: "fixture-app", appSecret: "fixture-secret" });
    await expect(syncer.syncAll({ clearUsers: [{ userId: "known", userIdType: "open_id" }] })).rejects.toThrow("cleanup failed");
  });

});
