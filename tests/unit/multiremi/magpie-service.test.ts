import { afterEach, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";
afterEach(resetMultiremiTestEnv);

it("manages Magpie without any daemon and preserves unrelated workspace settings", async () => {
  const store = createLocalStore();
  const current = store.getWorkspace("local")!;
  store.updateWorkspace("local", { settings: { ...current.settings, unrelated: "keep" } });
  const app = createMultiremiApp({ store, authToken: "root-secret" });
  const headers = { Authorization: "Bearer root-secret", "Content-Type": "application/json" };
  const path = "/api/workspaces/local/services/magpie";
  const put = (url: unknown) => app.request(path, { method: "PUT", headers, body: JSON.stringify({ url }) });
  expect(await (await app.request(path, { headers })).json()).toEqual({ url: null });
  expect((await put("http://devbox:3430")).status).toBe(200);
  expect(await (await app.request(path, { headers })).json()).toEqual({ url: "http://devbox:3430/" });
  expect(store.getWorkspace("local")?.settings.unrelated).toBe("keep");
  for (const invalid of ["javascript:alert(1)", "http://user:secret@host/", "http://host/?k=secret", "http://host/#secret", 42, ""]) {
    expect((await put(invalid)).status).toBe(400);
  }
  const token = await store.createAccessToken({ name: "Daemon", type: "daemon", workspaceId: "local", daemonId: "test-daemon" });
  const denied = await app.request(path, { method: "PUT", headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ url: null }) });
  expect(denied.status).toBe(403);
  expect((await put(null)).status).toBe(200);
  expect(await (await app.request(path, { headers })).json()).toEqual({ url: null });
});
