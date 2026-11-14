import { expect, test, mock } from "bun:test";
import { inspectEndpoint } from "@multiremi/relay/endpoint-inspection.js";
import { parseEndpointConnection, endpointRuntimeProfile } from "@multiremi/contracts/execution-endpoint.js";
import { parseEndpointOptions } from "@multiremi/contracts/endpoint-options.js";

const connection = () => parseEndpointConnection({ base_url: "https://gateway.invalid", protocols: ["openai-responses"], auth_mode: "api_key", env_key: "", auth_header: "bearer" });
const fetcher = (handler: (url: string, init: RequestInit) => Response | Promise<Response>) => mock((url: any, init: any) => Promise.resolve(handler(String(url), init))) as unknown as typeof fetch;

test("per-protocol URLs reach execution and inspection, with normalized request paths", async () => {
  const endpoint = parseEndpointConnection({ ...connection(), protocol_urls: { "openai-responses": "https://separate.invalid/custom/responses" }, options: { headers: { "X-Project": "demo" } } });
  const profile = endpointRuntimeProfile("ep_demo", endpoint, "codex");
  expect(profile.base_url).toBe("https://separate.invalid/custom");
  expect(profile.endpoint_options?.headers).toEqual({ "X-Project": "demo" });
  const request = fetcher((url, init) => {
    expect(url).toBe("https://separate.invalid/custom/models");
    expect(init.headers).toMatchObject({ "X-Project": "demo", Authorization: "Bearer test" });
    expect(init.redirect).toBe("error");
    return Response.json({ data: [{ id: "model-a", context_length: 128000 }] });
  });
  const result = await inspectEndpoint(endpoint, "test", { operation: "models" }, request);
  expect(result.results[0]).toMatchObject({ state: "ok", models: [{ id: "model-a", context_window: 128000 }] });
});
test("manual-only inventory never calls the endpoint", async () => {
  const endpoint = parseEndpointConnection({ ...connection(), options: { fetch_models: false, manual_models: [{ id: "alias", name: "Alias" }] } });
  const request = fetcher(() => { throw new Error("must not fetch"); });
  const result = await inspectEndpoint(endpoint, "", { operation: "models" }, request);
  expect(result.results[0]).toMatchObject({ state: "manual", models: [{ id: "alias", source: "manual" }] });
  expect(request).not.toHaveBeenCalled();
});
test("Google pagination and independent model URL preserve manual metadata", async () => {
  const endpoint = parseEndpointConnection({ ...connection(), protocols: ["google-generative"], options: {
    models_url: "https://inventory.invalid/list", manual_models: [{ id: "gemini-a", name: "My alias" }],
  } });
  const request = fetcher(url => Response.json(url.includes("pageToken") ? { models: [{ name: "models/gemini-b", inputTokenLimit: 64000 }] }
    : { models: [{ name: "models/gemini-a", displayName: "Remote" }], nextPageToken: "second" }));
  const result = await inspectEndpoint(endpoint, "key", { operation: "models" }, request);
  expect(result.results[0]?.models).toEqual([{ id: "gemini-a", name: "My alias", source: "manual" }, { id: "gemini-b", name: "models/gemini-b", context_window: 64000, source: "discovered" }]);
  expect(request).toHaveBeenCalledTimes(2);
});
test("HTTP failures and invalid lists are never successful or expose remote credentials", async () => {
  for (const [response, code] of [[new Response("secret echoed", { status: 401 }), "authentication_failed"], [Response.json({ data: [] }), "empty_catalog"], [new Response("<html>secret</html>"), "invalid_json"]] as const) {
    const result = await inspectEndpoint(connection(), "secret", { operation: "models" }, fetcher(() => response));
    expect(result.results[0]).toMatchObject({ state: "error", error_code: code });
    expect(JSON.stringify(result)).not.toContain("secret");
  }
});
test("protocol recognition does not claim a model invocation succeeded", async () => {
  const result = await inspectEndpoint(connection(), "key", { operation: "detect" }, fetcher((_url, init) => {
    expect(JSON.parse(String(init.body)).model).toBe("__remi_protocol_probe__");
    return new Response("invalid", { status: 400 });
  }));
  expect(result.results[0]?.state).toBe("recognized");
});
test("model test is explicit, single-model, and rejects empty successful responses", async () => {
  await expect(inspectEndpoint(connection(), "key", { operation: "test" })).rejects.toThrow("requires one");
  const result = await inspectEndpoint(connection(), "key", { operation: "test", protocol: "openai-responses", model: "chosen" }, fetcher((_url, init) => {
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "chosen", max_output_tokens: 16, store: false });
    return Response.json({ output: [] });
  }));
  expect(result.results[0]).toMatchObject({ state: "error", error_code: "invalid_response" });
});
test("custom headers cannot override authentication or inject request framing", () => {
  for (const name of ["Authorization", "x-api-key", "Cookie", "Host", "Content-Length", "X-Secret"])
    expect(() => parseEndpointOptions({ headers: { [name]: "value" } })).toThrow();
  expect(() => parseEndpointOptions({ manual_models: [{ id: "a" }, { id: "a" }] })).toThrow();
});

test("single-model probes require real text in the protocol response", async () => {
  for (const [protocol, body] of [
    ["openai-responses", { output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }] }],
    ["openai-chat-completions", { choices: [{ message: { content: "OK" } }] }],
    ["anthropic-messages", { content: [{ type: "text", text: "OK" }] }],
    ["google-generative", { candidates: [{ content: { parts: [{ text: "OK" }] } }] }],
  ] as const) {
    const endpoint = parseEndpointConnection({ ...connection(), protocols: [protocol] });
    const result = await inspectEndpoint(endpoint, "key", { operation: "test", protocol, model: "demo" }, fetcher(() => Response.json(body)));
    expect(result.results[0]?.state).toBe("ok");
  }
  const result = await inspectEndpoint(connection(), "key", { operation: "test", protocol: "openai-responses", model: "demo" },
    fetcher(() => Response.json({ output: [{ error: "not a response" }] })));
  expect(result.results[0]?.state).toBe("error");
});
