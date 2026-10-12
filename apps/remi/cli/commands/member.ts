import { CliError, ResourceResolver, type CommandInvocation, type CommandSpec } from "../core/index.js";
import { INPUT_OPTIONS, PAGE_OPTIONS, clientFor, commandOptions, encodePath, extractRecords, renderResource, requestBody, requiredWorkspace, stringOption } from "./resource-common.js";

/** Account credentials are separate from the one shared workspace operator. */
export function memberCommandSpecs(): CommandSpec[] {
  const getAccount = accountSpec("get", "GET", "/api/me", "Read the signed-in account");
  const updateAccount = accountSpec("update", "PATCH", "/api/me", "Update the signed-in account");
  return [
    { id: "account", path: ["account"], description: "Manage the platform login account", parse: "passthrough", run: async () => { throw new CliError("usage", "usage: remi account get|update|onboarding ..."); } },
    {
      id: "workspace.operator", path: ["workspace", "operator"], description: "Read the shared workspace operator",
      capability: "workspace.operator", auth: ["human"], mutation: "read", outputs: ["table", "json", "jsonl"],
      aliases: [{ path: ["member", "list"], deprecatedSince: "0.2.90", replacement: "remi workspace operator", hidden: true }],
      options: commandOptions(PAGE_OPTIONS),
      run: async (invocation) => {
        const client = await clientFor(invocation);
        const response = await client.request({ method: "GET", path: `/api/workspaces/${encodePath(requiredWorkspace(invocation))}/members` });
        renderResource(invocation, response.data, ["members"]);
      },
    },
    getAccount,
    updateAccount,
    ...[
      ["update", "PATCH", "/api/me/onboarding"],
      ["complete", "POST", "/api/me/onboarding/complete"],
      ["cloud-waitlist", "POST", "/api/me/onboarding/cloud-waitlist"],
      ["runtime-bootstrap", "POST", "/api/me/onboarding/runtime-bootstrap"],
      ["no-runtime-bootstrap", "POST", "/api/me/onboarding/no-runtime-bootstrap"],
    ].map(([action, method, path]) => accountSpec(`onboarding.${action}`, method as "PATCH" | "POST", path!, `Account onboarding: ${action}`)),
    {
      id: "member.get", path: ["member", "get"], hidden: true,
      description: "Compatibility: read historical attribution; use remi account get or remi workspace operator",
      capability: "member.get", auth: ["human"], mutation: "read", outputs: ["table", "json", "jsonl"],
      options: commandOptions(PAGE_OPTIONS), positionals: [{ name: "member", required: true }],
      run: async (invocation) => {
        const client = await clientFor(invocation);
        const ref = invocation.positionals[0]!;
        if (ref === "me") return getAccount.run(invocation);
        const response = await client.request({ method: "GET", path: `/api/multiremi/members/${encodePath(ref)}` });
        renderResource(invocation, response.data);
      },
    },
    {
      id: "member.update", path: ["member", "update"], hidden: true,
      description: "Compatibility: only the login account can be updated; use remi account update",
      auth: ["human"], mutation: "write", options: updateAccount.options,
      positionals: [{ name: "member", required: true }],
      run: async (invocation) => {
        if (invocation.positionals[0] !== "me") throw new CliError("usage", "Workspace members are no longer editable; use remi workspace operator");
        return updateAccount.run(invocation);
      },
    },
  ];
}

function accountSpec(action: string, method: "GET" | "PATCH" | "POST", path: string, description: string): CommandSpec {
  const segments = action.split(".");
  const accountUpdate = action === "update";
  return {
    id: `account.${action}`, path: ["account", ...segments], description,
    capability: `account.${action}`, auth: ["human"], mutation: method === "GET" ? "read" : "write",
    outputs: ["table", "json", "jsonl"],
    aliases: [{ path: ["member", ...segments, ...(segments[0] === "onboarding" ? [] : ["me"])], deprecatedSince: "0.2.90", replacement: `remi account ${segments.join(" ")}`, hidden: true }],
    options: commandOptions(method === "GET" ? PAGE_OPTIONS : [...INPUT_OPTIONS, ...(accountUpdate ? [
      { name: "name", type: "string" as const, description: "Account display name" },
      { name: "email", type: "string" as const, description: "Account email" },
    ] : [])]),
    run: async (invocation: CommandInvocation) => {
      const client = await clientFor(invocation);
      const body = method === "GET" ? undefined : await requestBody(invocation, accountUpdate ? {
        name: stringOption(invocation, "name") ?? undefined,
        email: stringOption(invocation, "email") ?? undefined,
      } : {});
      const response = await client.request({ method, path, ...(body ? { body } : {}) });
      renderResource(invocation, response.data);
    },
  };
}

export async function resolveMember(
  client: Awaited<ReturnType<typeof clientFor>>,
  workspaceId: string,
  ref: string,
): Promise<Record<string, unknown>> {
  const list = async () => {
    const response = await client.request<unknown>({ method: "GET", path: `/api/workspaces/${encodePath(workspaceId)}/members` });
    return extractRecords(response.data, ["members"]);
  };
  return new ResourceResolver<Record<string, unknown>>({
    kind: "member",
    getById: async (id) => (await list()).find((member) => member.id === id) ?? null,
    search: list,
    id: (member) => String(member.id ?? ""),
    name: (member) => typeof member.name === "string" ? member.name : typeof member.email === "string" ? member.email : null,
  }).resolve(ref);
}
