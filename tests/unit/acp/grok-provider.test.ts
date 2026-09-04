/**
 * Grok Build's native ACP dialect differs from the Claude/Codex bridges:
 * it needs an explicit authenticate request, restores with session/load, and
 * may fall back to session/set_model when standard config options are absent.
 */
import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AcpProvider, GrokAdapter } from "@acp/index.js";

interface LoggedEntry {
  kind: "args" | "request";
  args?: string[];
  method?: string;
  params?: Record<string, any>;
}

function fakeGrok(options: { configOptions?: boolean } = {}): { executable: string; entries(): LoggedEntry[] } {
  const dir = mkdtempSync(join(tmpdir(), "remi-grok-acp-"));
  const logPath = join(dir, "requests.jsonl");
  const executable = join(dir, "grok");
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const LOG = ${JSON.stringify(logPath)};
const USE_CONFIG_OPTIONS = ${options.configOptions !== false};
const log = (entry) => fs.appendFileSync(LOG, JSON.stringify(entry) + "\\n");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let currentModel = "grok-4.5";
let currentEffort = "high";
const configOptions = () => [
  {
    id: "model", name: "Model", category: "model", type: "select",
    currentValue: currentModel,
    options: [
      { value: "grok-4.5", name: "Grok 4.5" },
      { value: "grok-4.6", name: "Grok 4.6" },
    ],
  },
  {
    id: "reasoning_effort", name: "Reasoning effort", category: "thought_level", type: "select",
    currentValue: currentEffort,
    options: currentModel === "grok-4.6"
      ? [{ value: "high", name: "High" }, { value: "xhigh", name: "Extra high" }]
      : [{ value: "low", name: "Low" }, { value: "high", name: "High" }],
  },
];
log({ kind: "args", args: process.argv.slice(2) });
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  log({ kind: "request", method: msg.method, params: msg.params });
  if (msg.id == null) return;
  const ok = (result) => send({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      return ok({
        protocolVersion: 1,
        _meta: { defaultAuthMethodId: process.env.XAI_API_KEY ? "xai.api_key" : "cached_token" },
        authMethods: process.env.XAI_API_KEY
          ? [{ id: "cached_token", name: "Cached login" }, { id: "xai.api_key", name: "API key" }]
          : [{ id: "cached_token", name: "Cached login" }],
        agentCapabilities: { loadSession: true },
      });
    case "authenticate": return ok({});
    case "session/new":
      return ok({
        sessionId: "grok-session-1",
        ...(USE_CONFIG_OPTIONS ? { configOptions: configOptions() } : {}),
        models: {
          currentModelId: "grok-4.5",
          availableModels: [
            {
              modelId: "grok-4.5",
              name: "Grok 4.5",
              _meta: {
                supportsReasoningEffort: true,
                reasoningEfforts: [
                  { value: "low", label: "Low", default: false },
                  { value: "high", label: "High", default: true },
                ],
              },
            },
            {
              modelId: "grok-4.6",
              name: "Grok 4.6",
              _meta: {
                supportsReasoningEffort: true,
                reasoningEfforts: [
                  { value: "high", label: "High", default: true },
                  { value: "xhigh", label: "Extra high", default: false },
                ],
              },
            },
          ],
        },
      });
    case "session/load": return ok({ sessionId: msg.params.sessionId });
    case "session/set_config_option": {
      if (msg.params.configId === "model") currentModel = msg.params.value;
      if (msg.params.configId === "reasoning_effort") currentEffort = msg.params.value;
      return ok({ configOptions: configOptions() });
    }
    case "session/set_model": {
      currentModel = msg.params.modelId;
      currentEffort = msg.params._meta?.reasoningEffort ?? currentEffort;
      return ok({});
    }
    case "session/prompt": {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: msg.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: [{ type: "text", text: "pong" }],
          },
        },
      });
      return ok({
        stopReason: "end_turn",
        _meta: {
          modelId: "grok-4.6",
          usage: {
            inputTokens: 120,
            outputTokens: 30,
            cachedReadTokens: 20,
            cachedWriteTokens: 5,
            totalTokens: 150,
            costUsdTicks: 98_765,
          },
        },
      });
    }
    case "session/close": return ok({});
    default:
      return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "missing: " + msg.method } });
  }
});
`);
  chmodSync(executable, 0o755);
  return {
    executable,
    entries: () => existsSync(logPath)
      ? readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
      : [],
  };
}

function requests(entries: LoggedEntry[], method: string): LoggedEntry[] {
  return entries.filter((entry) => entry.kind === "request" && entry.method === method);
}

async function drain(stream: AsyncGenerator<unknown>): Promise<void> {
  for await (const _ of stream) { /* consume */ }
}

describe("Grok ACP provider", () => {
  it("runs Grok's native ACP handshake and preserves its metering", async () => {
    const agent = fakeGrok();
    const provider = new AcpProvider({
      agentType: "grok",
      executable: agent.executable,
      args: ["--no-leader"],
      cwd: mkdtempSync(join(tmpdir(), "remi-grok-cwd-")),
      env: { XAI_API_KEY: "xai-test" },
      getMcpServers: () => [],
    });

    await drain(provider.sendStream("ping", {
      chatId: "chat-1",
      systemPrompt: "Follow the Remi task contract.",
      permissionMode: "bypassPermissions",
      model: "grok-4.6",
      effort: "xhigh",
    }));
    const response = provider.getLastResponse();
    await provider.close();

    const entries = agent.entries();
    expect(entries.find((entry) => entry.kind === "args")?.args).toEqual([
      "--no-auto-update", "agent", "--no-leader", "stdio",
    ]);
    expect(requests(entries, "initialize")[0]?.params?._meta).toMatchObject({
      rules: "Follow the Remi task contract.",
      startupHints: { nonInteractive: true, skipGitStatus: true, skipProjectLayout: true },
    });
    expect(requests(entries, "authenticate")[0]?.params).toEqual({
      methodId: "xai.api_key",
      _meta: { headless: true },
    });
    expect(requests(entries, "session/new")[0]?.params?._meta).toEqual({ yoloMode: true });
    expect(requests(entries, "session/set_mode")).toHaveLength(0);
    expect(requests(entries, "session/set_config_option").map((entry) => entry.params)).toEqual([
      { sessionId: "grok-session-1", configId: "model", value: "grok-4.6" },
      { sessionId: "grok-session-1", configId: "reasoning_effort", value: "xhigh" },
    ]);
    expect(requests(entries, "session/set_model")).toHaveLength(0);
    expect(response).toMatchObject({
      text: "pong",
      sessionId: "grok-session-1",
      model: "grok-4.6",
      inputTokens: 100,
      outputTokens: 30,
      cacheReadInputTokens: 20,
      cacheCreateInputTokens: 5,
      totalTokens: 150,
      costUsd: 0.0000098765,
    });
  });

  it("authenticates with the cached login and restores through session/load", async () => {
    const agent = fakeGrok();
    const provider = new AcpProvider({
      agentType: "grok",
      executable: agent.executable,
      cwd: mkdtempSync(join(tmpdir(), "remi-grok-cwd-")),
      env: { XAI_API_KEY: "" },
      getMcpServers: () => [],
    });

    await drain(provider.sendStream("continue", {
      chatId: "chat-2",
      sessionId: "saved-grok-session",
      permissionMode: "default",
    }));
    await provider.close();

    const entries = agent.entries();
    expect(requests(entries, "authenticate")[0]?.params?.methodId).toBe("cached_token");
    expect(requests(entries, "session/load")[0]?.params).toMatchObject({
      sessionId: "saved-grok-session",
    });
    expect(requests(entries, "session/resume")).toHaveLength(0);
  });

  it("discovers Grok models and their model-specific reasoning levels", async () => {
    const agent = fakeGrok();
    const provider = new AcpProvider({
      agentType: "grok",
      executable: agent.executable,
      cwd: mkdtempSync(join(tmpdir(), "remi-grok-cwd-")),
      env: { XAI_API_KEY: "xai-test" },
      getMcpServers: () => [],
    });

    const models = await provider.discoverModelCapabilities();
    await provider.close();

    expect(models).toEqual([
      {
        id: "grok-4.5",
        label: "Grok 4.5",
        default: true,
        effort: { supportedLevels: [{ value: "low", label: "Low" }, { value: "high", label: "High" }] },
      },
      {
        id: "grok-4.6",
        label: "Grok 4.6",
        default: false,
        effort: { supportedLevels: [{ value: "high", label: "High" }, { value: "xhigh", label: "Extra high" }] },
      },
    ]);
  });

  it("falls back to Grok's set_model extension when config options are absent", async () => {
    const agent = fakeGrok({ configOptions: false });
    const provider = new AcpProvider({
      agentType: "grok",
      executable: agent.executable,
      cwd: mkdtempSync(join(tmpdir(), "remi-grok-cwd-")),
      env: { XAI_API_KEY: "xai-test" },
      getMcpServers: () => [],
    });

    await drain(provider.sendStream("ping", {
      chatId: "chat-fallback",
      model: "grok-4.6",
      effort: "xhigh",
    }));
    await provider.close();

    expect(requests(agent.entries(), "session/set_model")[0]?.params).toEqual({
      sessionId: "grok-session-1",
      modelId: "grok-4.6",
      _meta: { reasoningEffort: "xhigh" },
    });
  });
});

describe("Grok adapter", () => {
  it("honors Grok's resolved headless authentication precedence", () => {
    const adapter = new GrokAdapter();
    expect(adapter.selectAuthentication({
      protocolVersion: 1,
      authMethods: [
        { id: "cached_token", name: "Cached login" },
        { id: "xai.api_key", name: "API key" },
      ],
      _meta: { defaultAuthMethodId: "cached_token" },
    }, { XAI_API_KEY: "xai-test" })).toEqual({
      methodId: "cached_token",
      meta: { headless: true },
    });
  });

  it("normalizes legacy Grok tool fields", () => {
    const adapter = new GrokAdapter();
    const update = {
      sessionUpdate: "tool_call_update" as const,
      toolCallId: "tool-1",
      name: "Shell",
      parameters: { command: "git status" },
      output: "clean",
      status: "completed" as const,
    };

    expect(adapter.resolveToolName(update as never)).toBe("Bash");
    expect(adapter.extractToolInput(update as never)).toEqual({ command: "git status" });
    expect(adapter.extractResultPreview(update as never)).toBe("clean");
  });
});
