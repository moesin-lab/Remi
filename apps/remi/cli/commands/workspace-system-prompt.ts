import { randomUUID } from "node:crypto";
import { hashSystemPromptContent } from "@shared/system-prompt-policy-hash.js";
import type { SystemPromptPolicyBinding } from "@multiremi/contracts/system-prompt-policy.js";
import { SYSTEM_PROMPT_SLOTS as SLOTS, normalizeSystemPromptContent, type SystemPromptContent as Content, type SystemPromptState, type SystemPromptVersion, type SystemPromptVersionList, type SystemPromptVersionSummary, type SystemPromptWriteInput, type SystemPromptWriteResult } from "@multiremi/contracts/system-prompt-policy.js";
import { CliError, CliRenderer, type CliOptionSpec, type CommandInvocation, type CommandSpec } from "../core/index.js";
import { clientFor, commandOptions, encodePath, integerOption, outputMode, PAGE_OPTIONS, positional, renderResource, requestBody, stringOption } from "./resource-common.js";
import { resolveWorkspace } from "./workspace.js";

interface DiffLine { type: "context" | "remove" | "add"; text: string }

const CONTENT_OPTIONS: readonly CliOptionSpec[] = [
  { name: "file", type: "string", valueName: "path|-", description: "Read a JSON object with all five text slots; - reads stdin", conflictsWith: ["stdin"] },
  { name: "stdin", type: "boolean", description: "Read the five-slot JSON object from stdin", conflictsWith: ["file"] },
];
const WRITE_OPTIONS: readonly CliOptionSpec[] = [
  { name: "expected-revision", type: "integer", required: true, description: "Revision loaded with get; 0 for an uninitialized document" },
  { name: "request-id", type: "string", description: "Idempotency ID; defaults to one new UUID per invocation" },
  { name: "change-note", type: "string", description: "Optional audit explanation" },
];

export function workspaceSystemPromptCommandSpecs(): CommandSpec[] {
  return [
    spec("get", "Read the workspace System Prompt or a frozen attempt snapshot", "read", [
      { name: "attempt", type: "string", description: "Read this attempt's frozen policy" },
      { name: "content-hash", type: "string", description: "Expected SHA-256 of the attempt policy" },
    ], async (i) => {
      const attempt = stringOption(i, "attempt");
      const contentHash = stringOption(i, "content-hash");
      if (Boolean(attempt) !== Boolean(contentHash) || (contentHash && !/^[a-f0-9]{64}$/.test(contentHash))) throw new CliError("usage", "Supply --attempt with --content-hash SHA256");
      const { client, path } = await scope(i);
      if (attempt && contentHash) {
        const response = await client.request<SystemPromptPolicyBinding>({ method: "GET", path, query: { attempt, contentHash } });
        if (response.data?.format !== 1 || response.data.contentHash !== contentHash || hashSystemPromptContent(response.data.content) !== contentHash) {
          throw new CliError("conflict", "Attempt snapshot does not match the expected content hash");
        }
        if (outputMode(i) === "table") console.log(JSON.stringify(response.data, null, 2));
        else renderResource(i, response.data);
        return;
      }
      const response = await client.request<SystemPromptState>({ method: "GET", path });
      renderState(i, response.data);
    }),
    spec("set", "Save all five System Prompt slots as a new custom version (human only)", "write", [
      ...CONTENT_OPTIONS, ...WRITE_OPTIONS,
      { name: "base-default-revision", type: "string", description: "Default revision originally used as the editing baseline" },
    ], async (invocation) => {
      const { invocation: i, content } = await contentInput(invocation, true);
      const body = { content, ...writeBody(i), ...(stringOption(i, "base-default-revision") ? { baseDefaultRevision: stringOption(i, "base-default-revision") } : {}) };
      await write(i, "PUT", "", body);
    }),
    spec("reset", "Follow the latest platform default and record a new reset version (human only)", "write", WRITE_OPTIONS, async (i) => {
      await write(i, "POST", "/reset", writeBody(i));
    }),
    spec("history", "Read one page of immutable System Prompt version metadata", "read", [], async (i) => {
      const limit = integerOption(i, "limit");
      if (limit !== null && limit < 1) throw new CliError("usage", "--limit must be positive");
      const { client, path } = await scope(i);
      const response = await client.request<SystemPromptVersionList>({
        method: "GET", path: `${path}/versions`, query: { limit, cursor: stringOption(i, "cursor") },
      });
      new CliRenderer().render<SystemPromptVersionSummary>(response.data, {
        mode: outputMode(i), rows: () => response.data.versions,
        columns: [
          { header: "VERSION", value: (v) => v.versionNumber },
          { header: "ID", value: (v) => v.id },
          { header: "MODE", value: (v) => v.mode },
          { header: "OPERATION", value: (v) => v.operation },
          { header: "CURRENT", value: (v) => v.isCurrent },
          { header: "ACTOR", value: (v) => v.actor.displayName ?? v.actor.userId ?? v.actor.operatorId ?? v.actor.type },
          { header: "CREATED", value: (v) => v.createdAt },
          { header: "NOTE", value: (v) => v.changeNote },
        ], emptyMessage: "No System Prompt versions.",
      });
      if (outputMode(i) === "table" && response.data.nextCursor) console.log(`Next cursor: ${response.data.nextCursor}`);
    }),
    spec("version", "Read an exact historical System Prompt snapshot", "read", [], async (i) => {
      const { client, path } = await scope(i);
      const response = await client.request<SystemPromptVersion>({ method: "GET", path: `${path}/versions/${encodePath(positional(i, 1, "version"))}` });
      if (outputMode(i) === "table") console.log(JSON.stringify(response.data, null, 2));
      else renderResource(i, response.data);
    }, [{ name: "version", required: true }]),
    spec("restore", "Copy a historical snapshot into a new custom version, including old defaults (human only)", "write", WRITE_OPTIONS, async (i) => {
      await write(i, "POST", "/restore", { ...writeBody(i), versionId: positional(i, 1, "version") });
    }, [{ name: "version", required: true }]),
    spec("diff", "Compare two historical versions, or current/a version against the latest default", "read", [
      { name: "against-default", type: "boolean", description: "Compare current content (or <from>) with the latest platform default" },
    ], diff, [{ name: "from" }, { name: "to" }]),
    spec("preview", "Preview current or file/stdin behavior with read-only runtime protocols; does not save", "read", CONTENT_OPTIONS, async (invocation) => {
      const { invocation: i, content } = await contentInput(invocation, false);
      const { client, path } = await scope(i);
      const response = await client.request({ method: "POST", path: `${path}/preview`, body: content === undefined ? {} : { content } });
      if (outputMode(i) === "table") console.log(JSON.stringify(response.data, null, 2));
      else renderResource(i, response.data);
    }),
  ];
}

function spec(action: string, description: string, mutation: "read" | "write", options: readonly CliOptionSpec[], run: CommandSpec["run"], extra: NonNullable<CommandSpec["positionals"]> = []): CommandSpec {
  const id = `workspace.system-prompt.${action}`;
  return { id, path: ["workspace", "system-prompt", action], description, capability: id,
    auth: mutation === "write" ? ["human"] : ["human", "task"], mutation, outputs: ["table", "json", "jsonl"],
    positionals: [{ name: "workspace", required: true }, ...extra],
    options: commandOptions(mutation === "read" ? PAGE_OPTIONS : [], options), run };
}

async function scope(i: CommandInvocation) {
  const client = await clientFor(i);
  const workspace = await resolveWorkspace(client, positional(i, 0, "workspace"));
  return { client, path: `/api/workspaces/${encodePath(String(workspace.id))}/system-prompt` };
}

async function contentInput(invocation: CommandInvocation, required: boolean) {
  // Use the shared per-invocation input cache for both file and stdin, so the
  // capability/context resolution cannot consume a second copy of stdin.
  const i = invocation.options.stdin === true
    ? { ...invocation, options: { ...invocation.options, file: "-" } }
    : invocation;
  if (!stringOption(i, "file")) {
    if (required) throw new CliError("usage", "set requires --file <path> or --stdin with all five JSON text slots");
    return { invocation: i, content: undefined };
  }
  let content: Content;
  try { content = normalizeSystemPromptContent(await requestBody(i)); }
  catch (error) { throw new CliError("usage", error instanceof Error ? error.message : "Invalid System Prompt content"); }
  return { invocation: i, content };
}

function writeBody(i: CommandInvocation): SystemPromptWriteInput {
  const expectedRevision = integerOption(i, "expected-revision");
  if (expectedRevision === null || expectedRevision < 0) throw new CliError("usage", "--expected-revision must be a nonnegative integer");
  const supplied = i.options["request-id"];
  if (typeof supplied === "string" && !supplied.trim()) throw new CliError("usage", "--request-id cannot be empty");
  return { expectedRevision, requestId: stringOption(i, "request-id") ?? randomUUID(),
    ...(typeof i.options["change-note"] === "string" ? { changeNote: i.options["change-note"] } : {}) };
}

async function write(i: CommandInvocation, method: "POST" | "PUT", suffix: string, body: SystemPromptWriteInput & { content?: Content; versionId?: string; baseDefaultRevision?: string | null }) {
  const { client, path } = await scope(i);
  try {
    const response = await client.request<SystemPromptWriteResult>({ method, path: path + suffix, body, retries: false });
    renderState(i, response.data);
  } catch (error) {
    if (error instanceof CliError) {
      throw new CliError(error.code, error.message, { status: error.status, retryable: error.retryable,
        details: error.details, exitCode: error.exitCode, cause: error,
        hint: `Request ID: ${body.requestId}. Retry the same command with --request-id ${body.requestId} and the same revision and content to replay its result. Conflicts require reloading and comparing before a new edit.` });
    }
    throw error;
  }
}

function renderState(i: CommandInvocation, state: SystemPromptState | SystemPromptWriteResult) {
  if (outputMode(i) !== "table") { new CliRenderer().render(state, { mode: outputMode(i) }); return; }
  console.log(`Mode: ${state.document.mode}\nRevision: ${state.document.revision}\nCurrent version: ${state.document.currentVersionId ?? "none"}\nLatest default: ${state.currentDefault.revision}\nDefault updated: ${state.defaultUpdated}`);
  if ("version" in state) console.log(`Operation: ${state.version.operation}\nReplayed: ${state.replayed === true}\nSaved for subsequent runs; resident sessions may restart when necessary.`);
  // This is also the runtime's full-text read-back command. Never use table cells
  // here: they collapse whitespace and truncate long prompt bodies.
  for (const slot of SLOTS) console.log(`\n## ${slot}\n${state.content[slot]}`);
}

async function diff(i: CommandInvocation) {
  const from = i.positionals[1];
  const to = i.positionals[2];
  const againstDefault = i.options["against-default"] === true;
  if (againstDefault ? Boolean(to) : !from || !to) {
    throw new CliError("usage", "diff requires <workspace> <from> <to>, or <workspace> [from] --against-default");
  }
  const { client, path } = await scope(i);
  const historical = async (id: string) => (await client.request<SystemPromptVersion>({ method: "GET", path: `${path}/versions/${encodePath(id)}` })).data.content;
  let left: Content;
  let right: Content;
  let rightLabel: string;
  if (againstDefault) {
    const state = (await client.request<SystemPromptState>({ method: "GET", path })).data;
    left = from ? await historical(from) : state.content;
    right = state.currentDefault.content;
    rightLabel = `default:${state.currentDefault.revision}`;
  } else {
    left = await historical(from!);
    right = await historical(to!);
    rightLabel = to!;
  }
  const slots = SLOTS.filter((slot) => left[slot] !== right[slot]).map((slot) => ({ slot, lines: lineDiff(left[slot], right[slot]) }));
  const result = { from: from ?? "current", to: rightLabel, slots };
  if (outputMode(i) !== "table") { renderResource(i, result); return; }
  if (!slots.length) { console.log("No differences."); return; }
  for (const { slot, lines } of slots) {
    console.log(`--- ${result.from}/${slot}\n+++ ${result.to}/${slot}\n${lines.map((line) => `${line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}${line.text}`).join("\n")}`);
  }
}

/** Line LCS with bounded memory; large unrelated blocks remain a valid full replacement. */
function lineDiff(before: string, after: string): DiffLine[] {
  const left = before.split("\n");
  const right = after.split("\n");
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
  let endLeft = left.length;
  let endRight = right.length;
  while (endLeft > prefix && endRight > prefix && left[endLeft - 1] === right[endRight - 1]) { endLeft--; endRight--; }
  const lines: DiffLine[] = left.slice(0, prefix).map((text) => ({ type: "context", text }));
  const n = endLeft - prefix;
  const m = endRight - prefix;
  if ((n + 1) * (m + 1) > 1_000_000) {
    lines.push(...left.slice(prefix, endLeft).map((text): DiffLine => ({ type: "remove", text })),
      ...right.slice(prefix, endRight).map((text): DiffLine => ({ type: "add", text })));
  } else {
    const width = m + 1;
    const lengths = new Uint16Array((n + 1) * width);
    for (let a = n - 1; a >= 0; a--) for (let b = m - 1; b >= 0; b--) {
      lengths[a * width + b] = left[prefix + a] === right[prefix + b]
        ? 1 + lengths[(a + 1) * width + b + 1]!
        : Math.max(lengths[(a + 1) * width + b]!, lengths[a * width + b + 1]!);
    }
    let a = 0;
    let b = 0;
    while (a < n || b < m) {
      if (a < n && b < m && left[prefix + a] === right[prefix + b]) {
        lines.push({ type: "context", text: left[prefix + a++]! }); b++;
      } else if (a < n && (b === m || lengths[(a + 1) * width + b]! >= lengths[a * width + b + 1]!)) {
        lines.push({ type: "remove", text: left[prefix + a++]! });
      } else lines.push({ type: "add", text: right[prefix + b++]! });
    }
  }
  lines.push(...left.slice(endLeft).map((text): DiffLine => ({ type: "context", text })));
  return lines;
}
