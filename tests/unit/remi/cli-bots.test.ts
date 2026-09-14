import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { botCommandSpecs } from "../../../apps/remi/cli/commands/bots.js";
import { CommandRegistry } from "../../../apps/remi/cli/core/index.js";
import { cliCommandHelp, cliCommandInventory } from "../../../apps/remi/cli/index.js";

const realFetch = globalThis.fetch;
const realLog = console.log;
const realError = console.error;
const envKeys = ["MULTIREMI_SERVER_URL", "MULTIREMI_WORKSPACE_ID", "MULTIREMI_TOKEN"] as const;
const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const tempDirectories: string[] = [];

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  console.error = realError;
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Bot CLI", () => {
  it("registers one Bot topic and task-readable configuration alongside the legacy integration", () => {
    const inventory = cliCommandInventory();
    expect(inventory.find((entry) => entry.id === "bot")?.path).toEqual(["bot"]);
    expect(inventory.find((entry) => entry.id === "workspace.feishu-bot.set")).toBeDefined();
    for (const id of ["bot.list", "bot.get", "bot.sender.list", "bot.session.list"]) {
      expect(inventory.find((entry) => entry.id === id)?.auth, id).toEqual(["human", "task"]);
    }
    for (const id of ["bot.create", "bot.update", "bot.delete", "bot.sender.allow", "bot.sender.revoke"]) {
      expect(inventory.find((entry) => entry.id === id)?.auth, id).toEqual(["human"]);
    }
    expect(cliCommandHelp(["bot"])).toContain("bot create");
    expect(cliCommandHelp(["bot", "update"])).toContain("--file");
    expect(cliCommandHelp(["bot", "update"])).toContain("<bot>");
  });

  it("shows sender and session subcommands when help is requested through CLI dispatch", () => {
    const registry = new CommandRegistry();
    for (const spec of botCommandSpecs()) registry.register(spec);
    const senders = registry.renderHelpForArgv(["bot", "sender", "--help"]);
    expect(senders).toContain("Usage: remi bot sender");
    for (const action of ["list", "allow", "revoke"]) expect(senders).toContain(`bot sender ${action}`);
    expect(registry.renderHelpForArgv(["bot", "session", "--help"])).toContain("bot session list");
  });

  it("creates the complete aggregate from a file and prints only the returned redacted configuration", async () => {
    const body = {
      name: "Development assistant",
      platform_bindings: [
        { platform: "feishu", app_id: "cli_a", host_runtime_id: "runtime_mac", app_secret_op: "set", app_secret: "secret-a" },
        { platform: "feishu", app_id: "cli_b", host_runtime_id: "runtime_mac", app_secret_op: "set", app_secret: "secret-b" },
      ],
      default_target: { kind: "agent", agent_id: "agent_general" },
      routes: [{ id: "deploy", name: "Deploy", match: { commands: ["deploy"] }, target: { kind: "agent", agent_id: "agent_ops", runtime_id: "runtime_windows" } }],
      issue_notifications: null,
    };
    const directory = mkdtempSync(join(tmpdir(), "remi-bot-cli-"));
    tempDirectories.push(directory);
    const file = join(directory, "bot.json");
    writeFileSync(file, JSON.stringify(body));
    installFetch(async (request) => {
      expect(request.method).toBe("POST");
      expect(new URL(request.url).pathname).toBe("/api/bots");
      expect(await request.json()).toEqual({ ...body, workspace_id: "ws_test" });
      return Response.json({ id: "bot_a", name: body.name, platform_bindings: [{ id: "binding_a", app_secret_configured: true }] });
    });
    const output = await run(["bot", "create", "--file", file, "--output", "json"]);
    expect(JSON.parse(output)).toMatchObject({ id: "bot_a" });
    expect(output).not.toContain("secret-a");
    expect(output).not.toContain("secret-b");
  });

  it("replaces configuration without changing stable platform IDs or explicit automatic execution settings", async () => {
    const body = {
      workspace_id: "ws_other",
      name: "Updated bot",
      enabled: true,
      platform_bindings: [{ id: "binding_a", platform: "feishu", app_id: "cli_a", host_runtime_id: "runtime_mac" }],
      default_target: { kind: "agent", agent_id: "agent_general", runtime_workspace_id: "rws_a" },
      routes: [{ id: "route_a", name: "Operations", match: { chat_ids: ["chat_a"] }, target: { kind: "agent", agent_id: "agent_ops", runtime_workspace_id: null, runtime_id: null } }],
      allowlist_enabled: false,
    };
    installFetch(async (request) => {
      expect(request.method).toBe("PUT");
      expect(new URL(request.url).pathname).toBe("/api/bots/bot_a");
      expect(await request.json()).toEqual(body);
      return Response.json({ ...body, id: "bot_a" });
    });
    await run(["bot", "update", "bot_a", "--data", JSON.stringify(body), "--output", "json"]);
    await expect(run(["bot", "update", "bot_a"])).rejects.toThrow("requires complete configuration");
  });

  it("scopes lists and reads bot senders and sessions through their aggregate paths", async () => {
    const paths: string[] = [];
    installFetch((request) => {
      const url = new URL(request.url);
      paths.push(url.pathname);
      expect(request.method).toBe("GET");
      if (url.pathname === "/api/bots") {
        expect(url.searchParams.get("workspace_id")).toBe("ws_explicit");
        return Response.json({ bots: [{ id: "bot_a" }] });
      }
      expect(url.searchParams.get("workspace_id")).toBe("ws_test");
      if (url.pathname.endsWith("/senders")) return Response.json({ senders: [{ id: "sender_a", allowed: false }] });
      if (url.pathname.endsWith("/sessions")) return Response.json({ sessions: [{ id: "session_a", chat_session_id: "chat_a" }] });
      return Response.json({ id: "bot_a" });
    });
    expect(JSON.parse(await run(["bot", "list", "--workspace", "ws_explicit", "--output", "json"]))).toEqual({ bots: [{ id: "bot_a" }] });
    await run(["bot", "get", "bot_a", "--output", "json"]);
    expect(await run(["bot", "sender", "list", "bot_a", "--output", "jsonl"])).toBe('{"id":"sender_a","allowed":false}');
    await run(["bot", "session", "list", "bot_a", "--output", "json"]);
    expect(paths).toEqual(["/api/bots", "/api/bots/bot_a", "/api/bots/bot_a/senders", "/api/bots/bot_a/sessions"]);
  });

  it("allows and revokes a specific sender and requires confirmation before deleting a Bot", async () => {
    const writes: { method: string; path: string; body: unknown }[] = [];
    installFetch(async (request) => {
      expect(new URL(request.url).searchParams.get("workspace_id")).toBe("ws_test");
      writes.push({ method: request.method, path: new URL(request.url).pathname, body: request.method === "DELETE" ? null : await request.json() });
      return Response.json({ ok: true });
    });
    await run(["bot", "sender", "allow", "bot/a", "sender/a", "--output", "json"]);
    await run(["bot", "sender", "revoke", "bot/a", "sender/a", "--output", "json"]);
    await expect(run(["bot", "delete", "bot/a"])).rejects.toThrow("requires --yes");
    expect(writes).toHaveLength(2);
    await run(["bot", "delete", "bot/a", "--yes", "--output", "json"]);
    expect(writes).toEqual([
      { method: "PUT", path: "/api/bots/bot%2Fa/senders/sender%2Fa", body: { allowed: true } },
      { method: "PUT", path: "/api/bots/bot%2Fa/senders/sender%2Fa", body: { allowed: false } },
      { method: "DELETE", path: "/api/bots/bot%2Fa", body: null },
    ]);
  });
});

function installFetch(handler: (request: Request) => Response | Promise<Response>): void {
  process.env.MULTIREMI_SERVER_URL = "https://cli.example.test";
  process.env.MULTIREMI_WORKSPACE_ID = "ws_test";
  process.env.MULTIREMI_TOKEN = "test-token";
  globalThis.fetch = (async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (new URL(request.url).pathname === "/api/cli/capabilities") {
      return Response.json({ identity: "human", commands: botCommandSpecs().filter((spec) => spec.capability).map((spec) => ({ id: spec.id, allowed: true })) });
    }
    return handler(request);
  }) as typeof fetch;
}

async function run(argv: string[]): Promise<string> {
  const registry = new CommandRegistry();
  for (const spec of botCommandSpecs()) registry.register(spec);
  const output: string[] = [];
  console.log = (...parts: unknown[]) => { output.push(parts.map(String).join(" ")); };
  console.error = () => {};
  try {
    await registry.execute(argv);
    return output.join("\n");
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}
