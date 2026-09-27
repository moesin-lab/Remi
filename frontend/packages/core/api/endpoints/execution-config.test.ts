import { afterEach, expect, it, vi } from "vitest";
import { HttpClient } from "../http";
import { ApiContractError } from "../schema";
import { RuntimesEndpoints } from "./runtimes";

const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
afterEach(() => vi.unstubAllGlobals());
it("rejects invalid profile catalogs and never accepts a secret in profile responses", async () => {
  const fetch = vi.fn().mockResolvedValue(response({ profiles: [{ id: "p" }] }));
  vi.stubGlobal("fetch", fetch);
  const endpoint = new RuntimesEndpoints(new HttpClient("https://api.test"));
  await expect(endpoint.listExecutionProfiles("ws")).rejects.toBeInstanceOf(ApiContractError);
  const profile = { id: "p", workspace_id: "ws", name: "custom", provider: "codex", revision: 1, profile: { name: "custom", base_url: "https://model.test", model: "m", env_key: "", api_key: "must-not-return" }, created_at: "now", updated_at: "now" };
  fetch.mockResolvedValue(response({ profiles: [profile] }));
  await expect(endpoint.listExecutionProfiles("ws")).rejects.toBeInstanceOf(ApiContractError);
});
it("writes an explicit workspace and accepts group members' unknown future states", async () => {
  const group = { id: "g", workspace_id: "ws", name: "Group", provider: "codex", runtime_ids: ["r"], online_runtime_count: 0, profile_id: "p", profile_revision: 3, members: [{ runtime_id: "r", status: "new-status", error: null }] };
  const fetch = vi.fn().mockResolvedValue(response({ group }));
  vi.stubGlobal("fetch", fetch);
  const endpoint = new RuntimesEndpoints(new HttpClient("https://api.test"));
  const input = { name: "Group", provider: "codex", profile_id: "p", runtime_ids: ["r"] };
  await endpoint.saveExecutionGroup("ws", "g", input);
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ ...input, workspace_id: "ws" });
  fetch.mockResolvedValue(response({ group: { id: "g" } }));
  await expect(endpoint.saveExecutionGroup("ws", "g", input)).rejects.toBeInstanceOf(ApiContractError);
});
it("requires an explicit successful delete response", async () => {
  const fetch = vi.fn().mockImplementation(async () => response({ ok: false }));
  vi.stubGlobal("fetch", fetch);
  const endpoint = new RuntimesEndpoints(new HttpClient("https://api.test"));
  await expect(endpoint.deleteExecutionProfile("ws", "p")).rejects.toBeInstanceOf(ApiContractError);
  await expect(endpoint.deleteExecutionGroup("ws", "g")).rejects.toBeInstanceOf(ApiContractError);
  fetch.mockResolvedValue(response({ ok: true }));
  await expect(endpoint.deleteExecutionProfile("ws", "p")).resolves.toBeUndefined();
});
