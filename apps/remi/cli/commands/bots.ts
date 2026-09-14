import { CliError, CliRenderer, type CommandInvocation, type CommandSpec } from "../core/index.js";
import {
  INPUT_OPTIONS,
  PAGE_OPTIONS,
  YES_OPTION,
  clientFor,
  commandOptions,
  encodePath,
  extractRecords,
  outputMode,
  positional,
  renderResource,
  requestBody,
  requireConfirmation,
  requiredWorkspace,
  stringOption,
} from "./resource-common.js";

/** Platforms, targets and routes are saved together as one Bot configuration. */
export function botCommandSpecs(): CommandSpec[] {
  return [
    {
      id: "bot",
      path: ["bot"],
      description: "Manage bots, their platform bindings, routing, and optional sender allowlists",
      parse: "passthrough",
      run: async () => { throw new CliError("usage", "usage: remi bot list|get|create|update|delete|sender|session ..."); },
    },
    readSpec("bot.list", "List bots", [], async (invocation) => {
      const client = await clientFor(invocation);
      const response = await client.request({ method: "GET", path: "/api/bots", query: { workspace_id: requiredWorkspace(invocation) } });
      renderResource(invocation, response.data, ["bots"]);
    }),
    readSpec("bot.get", "Get a bot configuration (credentials redacted)", ["bot"], async (invocation) => {
      const response = await (await clientFor(invocation)).request({ method: "GET", path: botPath(invocation), query: botQuery(invocation) });
      renderResource(invocation, response.data);
    }),
    writeSpec("bot.create", "Create a bot from JSON configuration", [], async (invocation) => {
      const body = await botBody(invocation);
      body.workspace_id ??= requiredWorkspace(invocation);
      const response = await (await clientFor(invocation)).request({ method: "POST", path: "/api/bots", body });
      renderResource(invocation, response.data);
    }),
    writeSpec("bot.update", "Replace bot configuration; retain omitted secrets by platform binding ID", ["bot"], async (invocation) => {
      const body = await botBody(invocation);
      const response = await (await clientFor(invocation)).request({ method: "PUT", path: botPath(invocation), body });
      renderResource(invocation, response.data);
    }),
    {
      ...baseSpec("bot.delete", "Delete a bot while retaining its Chats and Tasks", ["bot"]),
      auth: ["human"],
      mutation: "destructive",
      options: commandOptions([YES_OPTION]),
      run: async (invocation) => {
        requireConfirmation(invocation);
        const response = await (await clientFor(invocation)).request({ method: "DELETE", path: botPath(invocation), query: botQuery(invocation) });
        renderResource(invocation, response.data);
      },
    },
    readSpec("bot.sender.list", "List automatically discovered bot senders", ["bot"], async (invocation) => {
      const response = await (await clientFor(invocation)).request({ method: "GET", path: `${botPath(invocation)}/senders`, query: botQuery(invocation) });
      renderSenders(invocation, response.data);
    }),
    senderSpec("allow", true),
    senderSpec("revoke", false),
    readSpec("bot.session.list", "List bot conversations and their selected Agent and execution settings", ["bot"], async (invocation) => {
      const response = await (await clientFor(invocation)).request({ method: "GET", path: `${botPath(invocation)}/sessions`, query: botQuery(invocation) });
      renderResource(invocation, response.data, ["sessions"]);
    }),
  ];
}

function baseSpec(id: string, description: string, refs: string[]) {
  return {
    id,
    path: id.split("."),
    description,
    capability: id,
    outputs: ["table", "json", "jsonl"] as const,
    positionals: refs.map((name) => ({ name, required: true })),
  };
}

function readSpec(id: string, description: string, refs: string[], run: CommandSpec["run"]): CommandSpec {
  return {
    ...baseSpec(id, description, refs),
    auth: ["human", "task"],
    mutation: "read",
    options: commandOptions(PAGE_OPTIONS),
    run,
  };
}

function writeSpec(id: string, description: string, refs: string[], run: CommandSpec["run"]): CommandSpec {
  return {
    ...baseSpec(id, description, refs),
    auth: ["human"],
    mutation: "write",
    options: commandOptions(INPUT_OPTIONS),
    run,
  };
}

function senderSpec(action: "allow" | "revoke", allowed: boolean): CommandSpec {
  return {
    ...baseSpec(`bot.sender.${action}`, allowed ? "Allow a discovered sender" : "Remove a sender from the bot allowlist", ["bot", "sender"]),
    auth: ["human"],
    mutation: "write",
    options: commandOptions(),
    run: async (invocation) => {
      const response = await (await clientFor(invocation)).request({
        method: "PUT",
        path: `${botPath(invocation)}/senders/${encodePath(positional(invocation, 1, "sender"))}`,
        query: botQuery(invocation),
        body: { allowed },
      });
      renderSenders(invocation, response.data);
    },
  };
}

function renderSenders(invocation: CommandInvocation, value: unknown): void {
  new CliRenderer().render(value, {
    mode: outputMode(invocation),
    rows: (input) => extractRecords(input, ["senders"]),
    columns: [
      { header: "ID", value: (row) => String(row.id ?? "-"), maxWidth: 28 },
      { header: "PLATFORM BINDING", value: (row) => String(row.platform_binding_id ?? "-"), maxWidth: 28 },
      { header: "ACCOUNT", value: (row) => String(row.external_id ?? "-"), maxWidth: 32 },
      { header: "NAME", value: (row) => String(row.display_name ?? "-"), maxWidth: 32 },
      { header: "ALLOWED", value: (row) => row.allowed === true ? "yes" : "no" },
    ],
  });
}

function botPath(invocation: CommandInvocation): string {
  return `/api/bots/${encodePath(positional(invocation, 0, "bot"))}`;
}

function botQuery(invocation: CommandInvocation): { workspace_id: string } {
  return { workspace_id: requiredWorkspace(invocation) };
}

async function botBody(invocation: CommandInvocation): Promise<Record<string, unknown>> {
  if (!stringOption(invocation, "file") && !stringOption(invocation, "data")) {
    throw new CliError("usage", `${invocation.spec.path.join(" ")} requires complete configuration via --file or --data`);
  }
  return requestBody(invocation);
}
