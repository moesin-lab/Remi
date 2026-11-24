import { expect, it } from "bun:test";
import { MultiremiDaemon } from "@multiremi/daemon.js";
import { disabledSshMeshRuntime } from "../../helpers/ssh-mesh-isolation.js";
import { discoverRuntimeProfileModels } from "@multiremi/worker/runtime-profile-models.js";
import { endpointRuntimeProfile, parseEndpointConnection } from "@multiremi/contracts/execution-endpoint.js";

it("resolves native and endpoint snapshots without inheriting unrelated workspace routing", async () => {
  const daemon = new MultiremiDaemon({ serverUrl: "http://127.0.0.1:1", provider: "claude", runtimeId: "rt_test",
    sshMeshManager: disabledSshMeshRuntime() });
  const state = daemon as unknown as {
    workspaceRelays: Map<string, unknown>;
    runtimeProfileKey: () => Promise<string>;
    taskConnectionRelay: (task: unknown) => Promise<Record<string, any>>;
  };
  state.workspaceRelays.set("local", { claude: { fragment: "global", auth_token: "wrong-global-key", revision: 1 } });
  state.runtimeProfileKey = async () => "endpoint-test-key";
  const native = await state.taskConnectionRelay({ workspaceId: "local", agent: { provider: "claude" },
    executionConnection: { mode: "native", provider: "claude", endpoint_id: null, endpoint_revision: null, profile: null } });
  expect(native).toMatchObject({ claude: null, codex: null, antigravity: null });
  const relay = await state.taskConnectionRelay({ workspaceId: "local", agent: { provider: "antigravity" },
    executionConnection: { mode: "endpoint", provider: "antigravity", endpoint_id: "ep_test", endpoint_revision: 3,
      profile: { name: "endpoint", base_url: "https://gemini.test", auth_mode: "api_key", env_key: "", model: "test-model", credential_id: "rck_test" } } });
  expect(relay.antigravity).toEqual({ fragment: JSON.stringify({ base_url: "https://gemini.test", default_model: "test-model" }),
    auth_token: "endpoint-test-key", revision: 3 });
  expect(relay.claude).toBeNull();
});

it("adapts one endpoint's protocol paths without selecting a model on the endpoint", () => {
  const connection = parseEndpointConnection({ base_url: "https://gateway.test", protocols: ["openai-responses", "anthropic-messages", "google-generative"],
    auth_mode: "api_key", env_key: "", protocol_paths: { "anthropic-messages": "/anthropic", "google-generative": "/google" } });
  expect(endpointRuntimeProfile("ep_test", connection, "codex").base_url).toBe("https://gateway.test/v1");
  expect(endpointRuntimeProfile("ep_test", connection, "claude").base_url).toBe("https://gateway.test/anthropic");
  expect(endpointRuntimeProfile("ep_test", connection, "antigravity").base_url).toBe("https://gateway.test/google");
  expect(endpointRuntimeProfile("ep_test", connection, "codex").model).toBe("");
  expect(() => parseEndpointConnection({ ...connection, protocol_paths: { "openai-responses": "//other.test" } })).toThrow();
});

it("discovers Google protocol models through the selected endpoint with pagination", async () => {
  const pages: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    pages.push(url.pathname + url.search);
    expect(request.headers.get("x-goog-api-key")).toBe("test-key");
    return Response.json(url.searchParams.has("pageToken")
      ? { models: [{ name: "models/second", displayName: "Second", supportedGenerationMethods: ["generateContent"] }] }
      : { models: [{ name: "models/first", supportedGenerationMethods: ["generateContent"] },
        { name: "models/embedding", supportedGenerationMethods: ["embedContent"] }], nextPageToken: "next" });
  } });
  try {
    const models = await discoverRuntimeProfileModels("antigravity", {
      name: "test", base_url: `http://127.0.0.1:${server.port}/google`, model: "", env_key: "REMI_ENDPOINT_TEST",
    }, "test-key", new AbortController().signal);
    expect(models.map(model => model.id)).toEqual(["first", "second"]);
    expect(pages).toEqual(["/google/v1beta/models", "/google/v1beta/models?pageToken=next"]);
  } finally { server.stop(true); }
});

it("uses the selected system endpoint for summaries without borrowing the task endpoint's key", async () => {
  const daemon = new MultiremiDaemon({ serverUrl: "http://127.0.0.1:1", provider: "codex", runtimeId: "rt_test",
    sshMeshManager: disabledSshMeshRuntime() });
  const state = daemon as unknown as {
    workspaceRelays: Map<string, unknown>;
    createTaskProgressSummarizer(task: unknown, env: Record<string, string>): Promise<any>;
  };
  state.workspaceRelays.set("local", { codex: { endpoint_id: "ep_system", headers: { "X-Project": "summary" }, auth_token: "system-only-key", revision: 1,
    fragment: 'model_provider="endpoint"\n[model_providers.endpoint]\nbase_url="https://summary.test/v1"\nwire_api="responses"' }, claude: null });
  const summary = await state.createTaskProgressSummarizer({
    id: "tsk_summary", workspaceId: "local", prompt: "Test", agent: { provider: "codex" },
    executionConnection: { mode: "endpoint", endpoint_id: "ep_task" },
  }, { OPENAI_API_KEY: "task-key-not-for-summary" });
  expect(summary.options.config.openAi).toMatchObject({ baseUrl: "https://summary.test/v1", apiKey: "system-only-key", headers: { "X-Project": "summary" }, exactBaseUrl: true });
  expect(summary.options.credentials).toBeUndefined();
  await summary.closeWithoutSummary();
});
