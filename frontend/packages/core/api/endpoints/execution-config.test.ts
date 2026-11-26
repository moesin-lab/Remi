import { afterEach, expect, it, vi } from "vitest";
import { HttpClient } from "../http";
import { ApiContractError } from "../schema";
import { RuntimesEndpoints } from "./runtimes";

const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
afterEach(() => vi.unstubAllGlobals());
it("inspects a saved endpoint by reference and rejects a malformed success response", async () => {
  const fetch = vi.fn().mockResolvedValue(response({ persisted: true, inspection: { checked_at: "now", location: "server", results: [] } }));
  vi.stubGlobal("fetch", fetch);
  const client = new RuntimesEndpoints(new HttpClient("https://api.test"));
  const input = { endpoint_id: "ep_one", operation: "models", protocol: "anthropic-messages" } as const;
  expect((await client.inspectExecutionEndpoint("ws", input)).persisted).toBe(true);
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ ...input, workspace_id: "ws" });
  fetch.mockResolvedValue(response({ inspection: {} }));
  await expect(client.inspectExecutionEndpoint("ws", input)).rejects.toBeInstanceOf(ApiContractError);
});
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
  const saved = await endpoint.saveExecutionGroup("ws", "g", input);
  expect(saved.group.description).toBe("");
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ ...input, workspace_id: "ws" });
  fetch.mockResolvedValue(response({ group: { id: "g" } }));
  await expect(endpoint.saveExecutionGroup("ws", "g", input)).rejects.toBeInstanceOf(ApiContractError);
});
it("saves inline provider configuration with group metadata and rejects malformed descriptions", async () => {
  const group = { id: "g", workspace_id: "ws", name: "Review", description: "Review services", provider: "codex", runtime_ids: [], online_runtime_count: 0, profile_id: "p", profile_revision: 1 };
  const fetch = vi.fn().mockResolvedValue(response({ group }));
  vi.stubGlobal("fetch", fetch);
  const endpoint = new RuntimesEndpoints(new HttpClient("https://api.test"));
  const input = {
    name: group.name, description: group.description, provider: "codex", profile_id: null, runtime_ids: [],
    connection: { name: "Gateway", profile: { name: "custom", base_url: "https://model.test", model: "fast", env_key: "REMI_CODEX_REVIEW" } },
  };
  expect((await endpoint.saveExecutionGroup("ws", undefined, input)).group.description).toBe(group.description);
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ ...input, workspace_id: "ws" });
  fetch.mockResolvedValue(response({ group: { ...group, description: 42 } }));
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

it("validates endpoint contracts and sends endpoint references independently from engine and model choices", async () => {
  const endpoint = { id: "ep_one", workspace_id: "ws", name: "Shared", revision: 1, created_at: "now", updated_at: "now",
    connection: { base_url: "https://gateway.test", protocols: ["openai-responses", "anthropic-messages"], auth_mode: "api_key", env_key: "", auth_header: "bearer" } };
  const fetch = vi.fn().mockResolvedValue(response({ endpoints: [endpoint] }));
  vi.stubGlobal("fetch", fetch);
  const client = new RuntimesEndpoints(new HttpClient("https://api.test"));
  expect((await client.listExecutionEndpoints("ws")).endpoints[0]?.id).toBe(endpoint.id);
  fetch.mockResolvedValue(response({ endpoints: [{ ...endpoint, connection: { ...endpoint.connection, api_key: "must-not-return" } }] }));
  await expect(client.listExecutionEndpoints("ws")).rejects.toBeInstanceOf(ApiContractError);
  fetch.mockResolvedValue(response({ endpoint }));
  const input = { name: endpoint.name, connection: { ...endpoint.connection,
    protocols: ["openai-responses" as const, "anthropic-messages" as const], auth_mode: "api_key" as const, auth_header: "bearer" as const }, api_key: "test-key" };
  await client.saveExecutionEndpoint("ws", undefined, input);
  expect(JSON.parse(fetch.mock.calls.at(-1)![1].body)).toEqual({ ...input, workspace_id: "ws" });
  fetch.mockResolvedValue(response({ ok: false }));
  await expect(client.deleteExecutionEndpoint("ws", endpoint.id)).rejects.toBeInstanceOf(ApiContractError);
});
