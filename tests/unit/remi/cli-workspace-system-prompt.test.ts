import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type SystemPromptContent, type SystemPromptState, type SystemPromptVersion } from "@multiremi/contracts/system-prompt-policy.js";
import { CliError, CommandRegistry } from "../../../apps/remi/cli/core/index.js";
import { hashSystemPromptContent } from "@shared/system-prompt-policy-hash.js";
import { workspaceCommandSpecs } from "../../../apps/remi/cli/commands/workspace.js";

const repoRoot = resolve(dirname(import.meta.path), "../../..");
const realLog = console.log;
const savedEnv = { ...process.env };
const content: SystemPromptContent = { common: "Keep first\nold line\nKeep last\n", code_delivery: "", chat_delivery: "Chat", issue_delivery: "Issue", finishing: "Finish" };
const latestContent = { ...content, common: "Keep first\nnew line\nKeep last\n" };
const catalog = { revision: "default-new", contentHash: "hash-new", content: latestContent };
const state: SystemPromptState = {
  document: { id: "doc_1", key: "system-policy", workspaceId: "ws_1", revision: 3, currentVersionId: "ver_3", mode: "custom" },
  content, currentDefault: catalog, baseDefault: { ...catalog, revision: "default-old", content }, defaultUpdated: true, limits: { maxCodePoints: 8000 },
};
const oldVersion: SystemPromptVersion = {
  id: "ver_2", documentId: "doc_1", workspaceId: "ws_1", versionNumber: 2, mode: "default", operation: "reset",
  content, contentHash: "old-hash", baseDefaultRevision: "default-old", baseDefaultSnapshot: content,
  restoredFromVersionId: null, parentVersionId: "ver_1", actor: { type: "human", userId: "usr_1", operatorId: "local", displayName: "Reader" },
  createdAt: "2026-11-24T00:00:00Z", changeNote: "historical default", requestId: "req-old", isCurrent: false,
};
const newVersion: SystemPromptVersion = { ...oldVersion, id: "ver_3", versionNumber: 3, mode: "custom", operation: "edit", content: latestContent, isCurrent: true };

type Observed = { method: string; path: string; query: Record<string, string>; body: unknown; workspace: string | null; authorization: string | null };
let server: ReturnType<typeof Bun.serve>;
let registry: CommandRegistry;
let directory: string;
let requests: Observed[];
let capabilities: Observed[];
let writeStatus: number;
let advertiseTaskWrites: boolean;
let versionContents: Map<string, SystemPromptContent>;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "remi-system-prompt-cli-"));
  process.env.MULTIREMI_CONFIG = join(directory, "config.json");
  process.env.MULTIREMI_TOKEN = "human-fixture";
  process.env.MULTIREMI_WORKSPACE_ID = "ws_1";
  delete process.env.MULTIREMI_TASK_TOKEN;
  delete process.env.MULTIREMI_TASK_ID;
  delete process.env.MULTIREMI_TURN_ID;
  writeFileSync(process.env.MULTIREMI_CONFIG, "{}");
  registry = new CommandRegistry();
  for (const spec of workspaceCommandSpecs()) registry.register(spec);
  requests = []; capabilities = []; writeStatus = 200; advertiseTaskWrites = false; versionContents = new Map();
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    const url = new URL(request.url);
    const observed: Observed = { method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams),
      body: request.method === "GET" ? null : await request.json(), workspace: request.headers.get("X-Workspace-ID"), authorization: request.headers.get("Authorization") };
    const task = observed.authorization === "Bearer task-fixture";
    if (url.pathname === "/api/cli/capabilities") {
      capabilities.push(observed);
      return Response.json({ protocol_version: 1, identity: task ? "task" : "human", commands: registry.inventory().map((s) => ({ id: s.id, allowed: task ? advertiseTaskWrites || s.auth.includes("task") : s.auth.includes("human") })) });
    }
    requests.push(observed);
    if (url.pathname === "/api/workspaces/ws_1") return Response.json({ id: "ws_1", name: "Workspace" });
    const base = "/api/workspaces/ws_1/system-prompt";
    if (url.pathname === base && observed.query.attempt === "attempt-A") return Response.json({ format: 1, contentHash: observed.query.contentHash, content });
    if (url.pathname === base && request.method === "GET") return Response.json(state);
    if (url.pathname === `${base}/versions`) {
      const { content: _content, baseDefaultSnapshot: _base, ...summary } = oldVersion;
      return Response.json({ versions: [summary], nextCursor: "cursor+/=next" });
    }
    if (url.pathname.startsWith(`${base}/versions/`)) {
      const id = decodeURIComponent(url.pathname.slice(`${base}/versions/`.length));
      if (id === "foreign-version") return Response.json({ error: "Version not found" }, { status: 404 });
      const version = id === "ver_3" ? newVersion : { ...oldVersion, id };
      return Response.json({ ...version, content: versionContents.get(id) ?? version.content });
    }
    if (url.pathname === `${base}/preview`) return Response.json({ scenario: "synthetic-issue", instructions: "Protected protocol\n" + JSON.stringify(observed.body), input: "Synthetic turn", includesLocalInstructions: false });
    if (url.pathname === base || url.pathname === `${base}/reset` || url.pathname === `${base}/restore`) {
      if (task) return Response.json({ error: "Human workspace administration required" }, { status: 403 });
      if (writeStatus !== 200) return Response.json({ error: "System Prompt revision changed", code: "system_prompt_conflict", currentRevision: 4, currentVersionId: "ver_4" }, { status: writeStatus });
      const body = observed.body as Record<string, unknown>;
      return Response.json({ ...state, document: { ...state.document, revision: 4, currentVersionId: "ver_4" },
        version: { ...newVersion, id: "ver_4", requestId: body.requestId, operation: url.pathname.endsWith("/reset") ? "reset" : url.pathname.endsWith("/restore") ? "rollback" : "edit" }, replayed: body.requestId === "replayed-id" });
    }
    return Response.json({ error: "Unexpected route" }, { status: 404 });
  } });
  process.env.MULTIREMI_SERVER_URL = `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
  console.log = realLog;
  server?.stop(true);
  rmSync(directory, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

async function execute(args: string[], format: string[] = ["--output", "json"]): Promise<string> {
  const lines: string[] = [];
  console.log = (...values) => { lines.push(values.map(String).join(" ")); };
  try { expect(await registry.execute(["workspace", "system-prompt", ...args, ...format])).toBe(true); }
  finally { console.log = realLog; }
  return lines.join("\n");
}
function policyFile(value: unknown = content): string {
  const file = join(directory, "policy.json");
  writeFileSync(file, JSON.stringify(value));
  return file;
}
function resourceRequests() { return requests.filter((r) => r.path !== "/api/workspaces/ws_1"); }
async function shippedCli(args: string[], stdin?: string) {
  const child = Bun.spawn([process.execPath, "apps/remi/main.ts", "workspace", "system-prompt", ...args], {
    cwd: repoRoot, env: { ...process.env }, stdin: stdin === undefined ? "ignore" : Buffer.from(stdin), stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exitCode };
}

describe("workspace System Prompt canonical CLI over real HTTP", () => {
  it("reads the requested attempt, verifies body bytes and rejects a latest-state fallback", async () => {
    const hash = hashSystemPromptContent(content);
    const args = ["get", "ws_1", "--attempt", "attempt-A", "--content-hash"];
    expect(JSON.parse(await execute([...args, hash]))).toMatchObject({ content, contentHash: hash });
    expect(resourceRequests().at(-1)?.query).toEqual({ attempt: "attempt-A", contentHash: hash });
    await expect(execute([...args, "f".repeat(64)])).rejects.toMatchObject({ code: "conflict" });
    await expect(execute(["get", "ws_1", "--attempt", "old-server", "--content-hash", hash])).rejects.toMatchObject({ code: "conflict" });
    await expect(execute(["get", "ws_1", "--attempt", "attempt-A"])).rejects.toMatchObject({ code: "usage" });
  });

  it("registers generated help and excludes all three human writes from task parity", () => {
    expect(registry.renderHelp(["workspace", "system-prompt"])).toContain("workspace system-prompt preview");
    expect(registry.renderHelp(["workspace", "system-prompt", "restore"])).toContain("new custom version");
    for (const entry of registry.inventory().filter((s) => s.id.startsWith("workspace.system-prompt."))) {
      expect(entry.parse).toBe("strict");
      expect(entry.capability).toBe(entry.id);
      expect(entry.auth).toEqual(["set", "reset", "restore"].includes(entry.path.at(-1)!) ? ["human"] : ["human", "task"]);
    }
  });

  it("preserves complete camelCase current/default metadata in JSON and full uncollapsed text by default", async () => {
    expect(JSON.parse(await execute(["get", "ws_1"]))).toEqual(state);
    const text = await execute(["get", "ws_1"], []);
    expect(text).toContain("Mode: custom\nRevision: 3");
    expect(text).toContain(`## common\n${content.common}`);
    expect(text).toContain("## code_delivery\n");
    expect(resourceRequests().map((r) => `${r.method} ${r.path}`)).toEqual(Array(2).fill("GET /api/workspaces/ws_1/system-prompt"));
    expect(capabilities.every((r) => r.authorization === "Bearer human-fixture" && r.workspace === "ws_1")).toBe(true);
  });

  it("maps five-slot file saves to the complete PUT body, preserving empty strings and audit baseline", async () => {
    const output = JSON.parse(await execute(["set", "ws_1", "--file", policyFile(), "--expected-revision", "3", "--request-id", "replayed-id", "--change-note", "Keep my baseline", "--base-default-revision", "default-old"]));
    expect(resourceRequests()).toEqual([expect.objectContaining({ method: "PUT", path: "/api/workspaces/ws_1/system-prompt", body: {
      content, expectedRevision: 3, requestId: "replayed-id", changeNote: "Keep my baseline", baseDefaultRevision: "default-old",
    } })]);
    expect(output.replayed).toBe(true);
    expect(output.version.requestId).toBe("replayed-id");
  });

  it("keeps the full write state and replay flag in JSONL output", async () => {
    const result = JSON.parse(await execute(["reset", "ws_1", "--expected-revision", "3", "--request-id", "replayed-id"], ["--output", "jsonl"]));
    expect(result.document.revision).toBe(4);
    expect(result.version.operation).toBe("reset");
    expect(result.replayed).toBe(true);
    expect(result.currentDefault).toEqual(catalog);
  });

  it("generates a new request UUID per invocation and sends reset CAS without content", async () => {
    await execute(["reset", "ws_1", "--expected-revision", "0"]);
    await execute(["reset", "ws_1", "--expected-revision", "0"]);
    const bodies = resourceRequests().map((r) => r.body as Record<string, unknown>);
    for (const body of bodies) {
      expect(body).toEqual({ expectedRevision: 0, requestId: expect.stringMatching(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/) });
    }
    expect(bodies[0]!.requestId).not.toBe(bodies[1]!.requestId);
    expect(resourceRequests().every((r) => r.method === "POST" && r.path.endsWith("/reset"))).toBe(true);
  });

  it("restores an old default by ID using a new restore POST rather than editing a historical row", async () => {
    const result = JSON.parse(await execute(["restore", "ws_1", "ver_2", "--expected-revision", "3", "--request-id", "restore-id", "--change-note", "Exact old text"]));
    expect(resourceRequests()).toEqual([expect.objectContaining({ method: "POST", path: "/api/workspaces/ws_1/system-prompt/restore", body: { versionId: "ver_2", expectedRevision: 3, requestId: "restore-id", changeNote: "Exact old text" } })]);
    expect(result.version.operation).toBe("rollback");
  });

  it("maps paginated history and keeps its camelCase page envelope and actor fields", async () => {
    const page = JSON.parse(await execute(["history", "ws_1", "--limit", "2", "--cursor", "opaque+/=cursor"]));
    expect(page.nextCursor).toBe("cursor+/=next");
    expect(page.versions[0].actor).toEqual(oldVersion.actor);
    expect(page.versions[0].content).toBeUndefined();
    expect(resourceRequests()[0]).toMatchObject({ method: "GET", query: { limit: "2", cursor: "opaque+/=cursor" } });
    const text = await execute(["history", "ws_1"], []);
    expect(text).toContain("Reader");
    expect(text).toContain("Next cursor: cursor+/=next");
    const jsonl = await execute(["history", "ws_1"], ["--output", "jsonl"]);
    expect(JSON.parse(jsonl).id).toBe("ver_2");
  });

  it("URL-encodes historical IDs and returns the exact complete detail snapshot", async () => {
    const output = JSON.parse(await execute(["version", "ws_1", "version/opaque +"]));
    expect(output).toEqual({ ...oldVersion, id: "version/opaque +" });
    expect(resourceRequests()[0]!.path).toBe("/api/workspaces/ws_1/system-prompt/versions/version%2Fopaque%20%2B");
  });

  it("diffs any two historical snapshots with line context and no save", async () => {
    const result = JSON.parse(await execute(["diff", "ws_1", "ver_2", "ver_3"]));
    expect(result).toEqual({ from: "ver_2", to: "ver_3", slots: [{ slot: "common", lines: [
      { type: "context", text: "Keep first" }, { type: "remove", text: "old line" }, { type: "add", text: "new line" },
      { type: "context", text: "Keep last" }, { type: "context", text: "" },
    ] }] });
    expect(resourceRequests().map((r) => r.path)).toEqual(["/api/workspaces/ws_1/system-prompt/versions/ver_2", "/api/workspaces/ws_1/system-prompt/versions/ver_3"]);
    const text = await execute(["diff", "ws_1", "ver_2", "ver_3"], []);
    expect(text).toContain("--- ver_2/common\n+++ ver_3/common\n Keep first\n-old line\n+new line\n Keep last");
  });

  it("keeps repeated lines, blank slots, final newlines and large replacements reversible in diff output", async () => {
    for (const [before, after] of [
      ["", "new"], ["old", ""], ["same\nA\nsame\nB", "same\nB\nsame\nA"],
      ["one\n\n", "\none\n"], ["line\n".repeat(1200), "other\n".repeat(1200)],
    ]) {
      versionContents.set("ver_2", { ...content, common: before! });
      versionContents.set("ver_3", { ...content, common: after! });
      const result = JSON.parse(await execute(["diff", "ws_1", "ver_2", "ver_3"])) as { slots: { slot: string; lines: { type: string; text: string }[] }[] };
      expect(result.slots).toHaveLength(1);
      const lines = result.slots[0]!.lines;
      expect(lines.filter((line) => line.type !== "add").map((line) => line.text).join("\n")).toBe(before!);
      expect(lines.filter((line) => line.type !== "remove").map((line) => line.text).join("\n")).toBe(after!);
    }
  });

  it("compares current or historical content with the latest returned default, preserving old default snapshots", async () => {
    const current = JSON.parse(await execute(["diff", "ws_1", "--against-default"]));
    expect(current.from).toBe("current"); expect(current.to).toBe("default:default-new");
    expect(current.slots[0].lines).toContainEqual({ type: "add", text: "new line" });
    const historical = JSON.parse(await execute(["diff", "ws_1", "ver_2", "--against-default"]));
    expect(historical.from).toBe("ver_2"); expect(historical.slots).toEqual(current.slots);
    expect(await execute(["diff", "ws_1", "ver_3", "--against-default"], [])).toBe("No differences.");
  });

  it("previews current or unsaved normalized content using a read-only POST", async () => {
    expect(JSON.parse(await execute(["preview", "ws_1"])).includesLocalInstructions).toBe(false);
    await execute(["preview", "ws_1", "--file", policyFile({ ...content, common: "a\r\nb\rc" })]);
    expect(resourceRequests()).toEqual([
      expect.objectContaining({ method: "POST", path: "/api/workspaces/ws_1/system-prompt/preview", body: {} }),
      expect.objectContaining({ method: "POST", path: "/api/workspaces/ws_1/system-prompt/preview", body: { content: { ...content, common: "a\nb\nc" } } }),
    ]);
  });

  it("uses real stdin once through the shipped CLI for set --stdin and preview --file -", async () => {
    for (const [args, expectedMethod] of [
      [["set", "ws_1", "--stdin", "--expected-revision", "3", "--request-id", "stdin-save", "--output", "json"], "PUT"],
      [["preview", "ws_1", "--file", "-", "--output", "json"], "POST"],
    ] as const) {
      const result = await shippedCli([...args], JSON.stringify(content));
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toBeObject();
      expect(resourceRequests().at(-1)).toMatchObject({ method: expectedMethod, body: { content } });
    }
  });

  it("returns CAS conflict details and a recoverable generated request ID without retrying the write", async () => {
    writeStatus = 409;
    let failure: CliError | undefined;
    try { await execute(["reset", "ws_1", "--expected-revision", "3"]); }
    catch (error) { if (!(error instanceof CliError)) throw error; failure = error; }
    expect(failure).toMatchObject({ code: "conflict", status: 409, details: { currentRevision: 4, currentVersionId: "ver_4" } });
    expect(resourceRequests()).toHaveLength(1);
    const requestId = (resourceRequests()[0]!.body as Record<string, string>).requestId;
    expect(failure?.hint).toContain(`--request-id ${requestId}`);
    expect(failure?.hint).toContain("same revision and content");
  });

  it("does not automatically retry failed writes with an idempotency ID", async () => {
    writeStatus = 503;
    await expect(execute(["reset", "ws_1", "--expected-revision", "3", "--request-id", "same-id"])).rejects.toMatchObject({ status: 503, retryable: true });
    expect(resourceRequests()).toHaveLength(1);
  });

  it("allows task reads/diff/preview and rejects each task write during capability negotiation", async () => {
    process.env.MULTIREMI_TOKEN = "task-fixture";
    for (const args of [["get", "ws_1"], ["history", "ws_1"], ["version", "ws_1", "ver_2"], ["diff", "ws_1", "ver_2", "ver_3"], ["preview", "ws_1"]]) await execute(args);
    const initialRequests = requests.length;
    for (const args of [
      ["set", "ws_1", "--file", policyFile(), "--expected-revision", "3"],
      ["reset", "ws_1", "--expected-revision", "3"],
      ["restore", "ws_1", "ver_2", "--expected-revision", "3"],
    ]) await expect(execute(args)).rejects.toMatchObject({ code: "forbidden" });
    expect(requests).toHaveLength(initialRequests);
  });

  it("surfaces the server's human guard even when capabilities erroneously allow a task write", async () => {
    process.env.MULTIREMI_TOKEN = "task-fixture"; advertiseTaskWrites = true;
    await expect(execute(["reset", "ws_1", "--expected-revision", "3"])).rejects.toMatchObject({ code: "forbidden", status: 403, message: "Human workspace administration required" });
    expect(resourceRequests()).toHaveLength(1);
  });

  it("propagates scope-safe version 404 errors without fetching or reconstructing another snapshot", async () => {
    await expect(execute(["version", "ws_1", "foreign-version"])).rejects.toMatchObject({ code: "not_found", status: 404 });
    expect(resourceRequests()).toHaveLength(1);
  });

  it("validates structure, Unicode budget, CAS and diff arguments before any HTTP request", async () => {
    const invalidContents = [{ common: "partial" }, { ...content, unknown: "slot" }, { ...content, common: null }, { ...content, common: "x".repeat(8001) }, { ...content, common: "\ud800" }, { ...content, common: "\0" }];
    for (const invalid of invalidContents) await expect(execute(["set", "ws_1", "--file", policyFile(invalid), "--expected-revision", "3"])).rejects.toMatchObject({ code: "usage" });
    for (const args of [
      ["set", "ws_1", "--expected-revision", "3"], ["reset", "ws_1"], ["reset", "ws_1", "--expected-revision", "-1"],
      ["reset", "ws_1", "--expected-revision", "3", "--request-id", " "], ["history", "ws_1", "--limit", "0"],
      ["diff", "ws_1", "ver_2"], ["diff", "ws_1", "ver_2", "ver_3", "--against-default"],
      ["set", "ws_1", "--file", "unused", "--stdin", "--expected-revision", "3"],
    ]) await expect(execute(args)).rejects.toMatchObject({ code: "usage" });
    expect(requests).toHaveLength(0); expect(capabilities).toHaveLength(0);
  });

  it("counts astral characters as code points and accepts an entirely empty custom document", async () => {
    const empty = { common: "", code_delivery: "", chat_delivery: "", issue_delivery: "", finishing: "" };
    for (const value of [empty, { ...empty, common: "😀".repeat(8000) }]) {
      await execute(["set", "ws_1", "--file", policyFile(value), "--expected-revision", "0"]);
      expect((resourceRequests().at(-1)!.body as Record<string, unknown>).content).toEqual(value);
    }
  });
});
