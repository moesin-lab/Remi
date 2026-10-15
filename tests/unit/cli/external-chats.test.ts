import { afterEach, describe, expect, it } from "bun:test";
import { CliError, CommandRegistry } from "../../../apps/remi/cli/core/index.js";
import { externalChatCommandSpecs } from "../../../apps/remi/cli/commands/external-chats.js";
import { cliCommandHelp, cliCommandInventory } from "../../../apps/remi/cli/index.js";

const specs = externalChatCommandSpecs();
const registry = new CommandRegistry();
for (const spec of specs) registry.register(spec);
const realFetch = globalThis.fetch, realLog = console.log, realError = console.error;
let requests: Request[] = [], output: string[] = [], diagnostics: string[] = [];
const fixtureId = "3ed318d8-bf6f-40df-8d9c-6a620ecaf3b7";
const location = ["--runtime", "rt_codex", "--source", "codex:aiden"];
const connection = ["--server", "http://external.test", "--workspace", "ws_test", "--token", "fixture", "--json"];
const base = "/api/runtimes/rt_codex/external-chats/codex%3Aaiden/threads/thread_1";

function setup(handler: (request: Request) => Response | Promise<Response> = () => Response.json({ accepted: true })) {
  requests = []; output = []; diagnostics = [];
  console.log = (...values) => { output.push(values.join(" ")); };
  console.error = (...values) => { diagnostics.push(values.join(" ")); };
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init); requests.push(request);
    if (new URL(request.url).pathname === "/api/cli/capabilities") {
      return Response.json({ commands: specs.map(spec => ({ id: spec.id, allowed: true })) });
    }
    return handler(request);
  }) as typeof fetch;
}

function execute(action: string, args: string[] = [], flags = location) {
  return registry.execute(["chat", "external", action, ...args, ...flags, ...connection]);
}

afterEach(() => { globalThis.fetch = realFetch; console.log = realLog; console.error = realError; });

describe("external native Chat CLI", () => {
  it("registers eight human-only capabilities and generated help in the real dispatcher", () => {
    const inventory = cliCommandInventory().filter(spec => spec.capability?.startsWith("chat.external."));
    expect(inventory.map(spec => spec.id).sort()).toEqual(specs.filter(spec => spec.capability).map(spec => spec.id).sort());
    expect(inventory).toHaveLength(8);
    for (const entry of inventory) {
      expect(entry.auth).toEqual(["human"]);
      expect(entry.capability).toBe(entry.id);
      expect(entry.parse).toBe("strict");
      expect(entry.mutation).toBe(["send", "interrupt", "respond"].includes(entry.path[2]!) ? "write" : "read");
      expect(cliCommandHelp(entry.path)).toContain("--runtime");
    }
    expect(cliCommandHelp(["chat", "external"])).toContain("sources");
    expect(cliCommandHelp(["chat", "external", "send"])).toContain("--request-id");
    expect(cliCommandHelp(["chat", "external", "send"])).toContain("--model");
    expect(cliCommandHelp(["chat", "external", "models"])).toContain("--cursor");
    expect(cliCommandHelp(["chat", "external", "models"])).toContain("--limit");
  });

  const reads: Array<{ action: string; args: string[]; flags: string[]; path: string; query: Record<string, string>; response: unknown }> = [
    { action: "sources", args: [], flags: ["--runtime", "rt_codex"], path: "/api/runtimes/rt_codex/external-chats", query: {}, response: { sources: [], warnings: [] } },
    { action: "models", args: ["--cursor", "models:+/=", "--limit", "3"], flags: location,
      path: "/api/runtimes/rt_codex/external-chats/codex%3Aaiden/models", query: { cursor: "models:+/=", limit: "3" },
      response: { source_id: "codex:aiden", models: [{ id: "provider/model", name: "Model", description: "Native catalog model" }], next_cursor: "next" } },
    { action: "list", args: ["--project", "native:p1", "--cursor", "cursor:+/=", "--limit", "5"], flags: location, path: base.slice(0, -"/thread_1".length), query: { project_id: "native:p1", cursor: "cursor:+/=", limit: "5" }, response: { chats: [], projects: [], next_cursor: "next" } },
    { action: "get", args: ["thread_1", "--cursor", "turn:2", "--limit", "3"], flags: location, path: base, query: { cursor: "turn:2", limit: "3" }, response: { chat: { id: "thread_1" }, turns: [], requests: [], next_cursor: "next" } },
    { action: "receipt", args: ["thread_1", "--request-id", fixtureId], flags: location, path: `${base}/receipts/${fixtureId}`, query: {}, response: { request_id: fixtureId, thread_id: "thread_1", turn_id: null, outcome: "unknown" } },
  ];
  for (const sample of reads) it(`routes ${sample.action} with encoded IDs and one bounded page`, async () => {
    setup(() => Response.json(sample.response));
    await execute(sample.action, sample.args, sample.flags);
    expect(requests).toHaveLength(2);
    const request = requests[1]!, url = new URL(request.url);
    expect(request.method).toBe("GET");
    expect(url.pathname).toBe(sample.path);
    expect(Object.fromEntries(url.searchParams)).toEqual(sample.query);
    expect(request.headers.get("Authorization")).toBe("Bearer fixture");
    expect(request.headers.get("X-Workspace-ID")).toBe("ws_test");
    expect(JSON.parse(output.join("\n"))).toEqual(sample.response);
    expect(diagnostics).toEqual([]);
  });

  it("shows source homes and live connection state in table output", async () => {
    setup(() => Response.json({ sources: [{ id: "codex:aiden", name: "Aiden Codex", home: "/home/operator/.codex-aiden", connection: "live", projects: [] }], warnings: [] }));
    await registry.execute(["chat", "external", "sources", "--runtime", "rt_codex", ...connection.filter(value => value !== "--json")]);
    const table = output.join("\n");
    expect(table).toContain("HOME"); expect(table).toContain("CONNECTION");
    expect(table).toContain("codex:aiden"); expect(table).toContain("Aiden Codex");
    expect(table).toContain("/home/operator/.codex-aiden"); expect(table).toContain("live");
    expect(diagnostics).toEqual([]);
  });

  it("shows the original Chat title, Project, cwd, state and model with a page cursor", async () => {
    setup(() => Response.json({ chats: [{ id: "thread_1", title: "继续开发 CLI", project_id: "cwd:p1", cwd: "/home/operator/dev/aiden-cli", status: "active", model: "aiden-gpt-6.1-sol" }], projects: [], next_cursor: "chat:next" }));
    await registry.execute(["chat", "external", "list", ...location, ...connection.filter(value => value !== "--json")]);
    const table = output.join("\n");
    for (const column of ["TITLE", "PROJECT", "CWD", "STATE", "MODEL"]) expect(table).toContain(column);
    for (const value of ["继续开发 CLI", "cwd:p1", "/home/operator/dev/aiden-cli", "active", "aiden-gpt-6.1-sol"]) expect(table).toContain(value);
    expect(diagnostics).toEqual(["next_cursor: chat:next"]);
    expect(requests.filter(request => new URL(request.url).pathname.endsWith("/threads"))).toHaveLength(1);
  });

  it("shows complete native model IDs, names and descriptions with the next page cursor", async () => {
    const model = { id: "provider/model", name: "Native model", description: "Available from this source" };
    setup(() => Response.json({ source_id: "codex:aiden", models: [model], next_cursor: "models:next" }));
    await registry.execute(["chat", "external", "models", ...location, ...connection.filter(value => value !== "--json")]);
    for (const value of ["ID", "NAME", "DESCRIPTION", model.id, model.name, model.description]) expect(output.join("\n")).toContain(value);
    expect(diagnostics).toEqual(["next_cursor: models:next"]);
    expect(requests.filter(request => new URL(request.url).pathname.endsWith("/models"))).toHaveLength(1);
  });

  it("marks clipped history items and exposes the next page only in table mode", async () => {
    const history = { chat: { id: "thread_1" }, turns: [{ id: "turn_1", status: "completed", items: [{ id: "item_1", type: "agentMessage", role: "assistant", text: "截断正文", truncated: true }] }], requests: [], next_cursor: "history:next" };
    setup(() => Response.json(history));
    await registry.execute(["chat", "external", "get", "thread_1", ...location, ...connection.filter(value => value !== "--json")]);
    expect(output.join("\n")).toContain("TRUNCATED");
    expect(output.join("\n")).toContain("截断正文");
    expect(output.join("\n")).toContain("yes");
    expect(diagnostics).toEqual(["next_cursor: history:next"]);
    setup(() => Response.json(history));
    await execute("get", ["thread_1"]);
    expect(JSON.parse(output.join("\n"))).toEqual(history);
    expect(diagnostics).toEqual([]);
  });

  it("sends literal text with an explicit UUID once and no HTTP idempotency retry header", async () => {
    const text = "  原始文本\n继续实现  ";
    setup(async request => {
      expect(new URL(request.url).pathname).toBe(`${base}/messages`);
      expect(await request.json()).toEqual({ text, request_id: fixtureId });
      expect(request.headers.has("Idempotency-Key")).toBe(false);
      return Response.json({ request_id: fixtureId, thread_id: "thread_1", turn_id: "turn_1", outcome: "accepted" }, { status: 202 });
    });
    await execute("send", ["thread_1", "--text", text, "--request-id", fixtureId]);
    expect(requests.filter(request => request.method === "POST")).toHaveLength(1);
    expect(JSON.parse(output.join("\n"))).toMatchObject({ request_id: fixtureId, outcome: "accepted" });
  });

  it("sends an explicit native model with slashes or Unicode unchanged and without retry authorization", async () => {
    const models = ["provider/model", "provider/" + "界".repeat(247)];
    setup(async request => {
      const body = await request.json() as { text: string; request_id: string; model: string };
      expect(body).toEqual({ text: "Continue native thread", request_id: fixtureId, model: models.shift()! });
      expect(request.headers.has("Idempotency-Key")).toBe(false);
      return Response.json({ request_id: fixtureId, thread_id: "thread_1", turn_id: "turn_1", outcome: "accepted" }, { status: 202 });
    });
    for (const model of [...models]) await execute("send", ["thread_1", "--text", "Continue native thread", "--request-id", fixtureId, "--model", model]);
    expect(models).toHaveLength(0);
    expect(requests.filter(request => request.method === "POST")).toHaveLength(2);
  });

  it("preserves an actionable upgrade error when an old daemon refuses model selection", async () => {
    setup(() => Response.json({ error: "Upgrade the owning Codex Runtime", code: "external_chat_models_unsupported" }, { status: 503 }));
    const error = await execute("send", ["thread_1", "--text", "continue", "--request-id", fixtureId, "--model", "provider/model"]).catch(error => error);
    expect(error).toBeInstanceOf(CliError);
    expect(error.message).toBe("Upgrade the owning Codex Runtime");
    expect(error.retryable).toBe(false);
    expect(error.details).toMatchObject({ code: "external_chat_models_unsupported" });
    expect(error.details).not.toHaveProperty("receipt");
    expect(requests.filter(request => request.method === "POST")).toHaveLength(1);
  });

  it("generates a fresh UUID per send and returns it in the receipt", async () => {
    const ids: string[] = [];
    setup(async request => {
      const body = await request.json() as { request_id: string };
      ids.push(body.request_id);
      expect(body.request_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      return Response.json({ request_id: body.request_id, thread_id: "thread_1", turn_id: null, outcome: "unknown" }, { status: 202 });
    });
    await execute("send", ["thread_1", "--text", "one"]);
    await execute("send", ["thread_1", "--text", "two"]);
    expect(ids[0]).not.toBe(ids[1]);
    expect(output.map(value => JSON.parse(value).request_id)).toEqual(ids);
  });

  it("shows a complete unknown receipt UUID in default table output", async () => {
    setup(() => Response.json({ request_id: fixtureId, thread_id: "thread_1", turn_id: null, outcome: "unknown" }, { status: 202 }));
    await registry.execute(["chat", "external", "send", "thread_1", ...location, "--text", "continue", "--request-id", fixtureId, ...connection.filter(value => value !== "--json")]);
    expect(output.join("\n")).toContain(fixtureId);
    expect(output.join("\n")).toContain("unknown");
    expect(requests.filter(request => request.method === "POST")).toHaveLength(1);
  });

  for (const failure of ["network", "upstream", "timeout"] as const) it(`keeps the send UUID on ${failure} uncertainty without retry`, async () => {
    setup(request => {
      if (failure === "network") throw new TypeError("lost acknowledgement");
      if (failure === "timeout") return new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(new Error("timed out")), { once: true }));
      return Response.json({ error: "native acknowledgement lost", code: "external_unknown", outcome: "unknown" }, { status: 503 });
    });
    const error = await execute("send", ["thread_1", "--text", "continue", "--request-id", fixtureId, "--model", "provider/model", "--timeout", "5"]).catch(error => error);
    expect(error).toBeInstanceOf(CliError);
    expect(error.retryable).toBe(false);
    expect(error.details).toEqual({ receipt: { request_id: fixtureId, thread_id: "thread_1", turn_id: null, outcome: "unknown" } });
    expect(error.hint).toContain(`--request-id ${fixtureId}`);
    if (failure === "timeout") expect(error.code).toBe("timeout");
    expect(requests.filter(request => request.method === "POST")).toHaveLength(1);
  });

  it("rejects an unrelated success receipt as an unknown acknowledgement", async () => {
    setup(() => Response.json({ request_id: fixtureId, thread_id: "other_thread", turn_id: "turn_1", outcome: "accepted" }, { status: 202 }));
    const error = await execute("send", ["thread_1", "--text", "continue", "--request-id", fixtureId]).catch(error => error);
    expect(error.details.receipt).toMatchObject({ thread_id: "thread_1", request_id: fixtureId, outcome: "unknown" });
    expect(requests.filter(request => request.method === "POST")).toHaveLength(1);
  });

  const writes = [
    { action: "interrupt", args: ["--turn", "turn:3"], path: `${base}/interrupt`, body: { turn_id: "turn:3" } },
    { action: "respond", args: ["--request-id", "native:request:7", "--decision", "decline"], path: `${base}/requests/native%3Arequest%3A7`, body: { decision: "decline" } },
    { action: "respond", args: ["--request-id", "native:input:8", "--answers-json", '{"q1":["实现并验证"]}'], path: `${base}/requests/native%3Ainput%3A8`, body: { answers: { q1: ["实现并验证"] } } },
  ];
  for (const sample of writes) it(`routes ${sample.action} native control without replay`, async () => {
    setup(async request => {
      expect(new URL(request.url).pathname).toBe(sample.path);
      expect(await request.json()).toEqual(sample.body);
      return Response.json({ accepted: true });
    });
    await execute(sample.action, ["thread_1", ...sample.args]);
    expect(requests.filter(request => request.method === "POST")).toHaveLength(1);
    expect(JSON.parse(output.join("\n"))).toEqual({ accepted: true });
  });

  it("does not advertise an uncertain interrupt as automatically retryable", async () => {
    setup(() => Response.json({ error: "lost native acknowledgement", outcome: "unknown" }, { status: 503 }));
    const error = await execute("interrupt", ["thread_1", "--turn", "turn_1"]).catch(error => error);
    expect(error.retryable).toBe(false);
    expect(requests.filter(request => request.method === "POST")).toHaveLength(1);
  });

  it("rejects incomplete or malformed native writes before any HTTP request", async () => {
    setup(() => { throw new Error("Unexpected HTTP"); });
    const cases = [
      ["send", "thread_1", "--text", " "], ["send", "thread_1", "--text", "x".repeat(32_001)],
      ["send", "thread_1", "--text", "continue", "--request-id", "bad"],
      ["send", "thread_1", "--text", "continue", "--request-id", ""],
      ...["", " ", "x".repeat(257), "provider/\nmodel", "provider/\0model", "provider/\x85model"].map(model => ["send", "thread_1", "--text", "continue", "--model", model]),
      ["receipt", "thread_1", "--request-id", "bad"], ["interrupt", "thread_1"],
      ["respond", "thread_1", "--request-id", "request_1"],
      ["respond", "thread_1", "--request-id", "request_1", "--decision", "unknown"],
      ["respond", "thread_1", "--request-id", "request_1", "--answers-json", '{"q":1}'],
      ["respond", "thread_1", "--request-id", "request_1", "--answers-json", "[]"],
      ["respond", "thread_1", "--request-id", "request_1", "--answers-json", "{"],
      ["respond", "thread_1", "--request-id", "request_1", "--decision", "accept", "--answers-json", "{}"],
      ["list", "--limit", "51"], ["get", "thread_1", "--limit", "0"], ["models", "--limit", "51"], ["models", "--limit", "0"],
    ];
    for (const [action, ...args] of cases) await expect(execute(action!, args)).rejects.toThrow();
    expect(requests).toHaveLength(0);
    await expect(registry.execute(["chat", "external", "sources", ...connection])).rejects.toThrow("--runtime is required");
    await expect(execute("list", [], ["--runtime", "rt_codex"])).rejects.toThrow("--source is required");
    await expect(registry.execute(["chat", "external", "send", "thread_1", ...location, "--text", "continue", "--output", "invalid", ...connection.filter(value => value !== "--json")])).rejects.toThrow("unsupported --output");
    expect(requests).toHaveLength(0);
  });
});
