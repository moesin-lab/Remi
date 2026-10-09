import { afterEach, describe, expect, it } from "bun:test";
import { dispatch, cliCommandInventory } from "../../../apps/remi/cli/index.js";
import { RETIRED_CLI_COMMANDS } from "../../../apps/remi/cli/core/retired-commands.js";
import { issueTask } from "../../../apps/remi/cli/multiremi/commands/issue.js";

const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalError = console.error;
const envNames = ["MULTIREMI_SERVER_URL", "MULTIREMI_WORKSPACE_ID", "MULTIREMI_TOKEN", "MULTIREMI_ISSUE_SESSION_ID", "MULTIREMI_SESSION_ID", "MULTIREMI_CHAT_ID"] as const;
const originalEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
let requests: Request[] = [];
let output: string[] = [];

function setup(response: unknown = { id: "ises_1" }): void {
  requests = [];
  output = [];
  process.env.MULTIREMI_SERVER_URL = "http://session-owner.test";
  process.env.MULTIREMI_WORKSPACE_ID = "local";
  process.env.MULTIREMI_TOKEN = "fixture";
  for (const name of envNames.slice(3)) delete process.env[name];
  console.log = (...values) => output.push(values.join(" "));
  console.error = () => { throw new Error("Unexpected CLI warning"); };
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    if (new URL(request.url).pathname === "/api/cli/capabilities") {
      return Response.json({ commands: cliCommandInventory().filter(entry => entry.capability).map(entry => ({ id: entry.id, allowed: true })) });
    }
    return Response.json(response);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  console.error = originalError;
  for (const name of envNames) {
    if (originalEnv[name] === undefined) delete process.env[name];
    else process.env[name] = originalEnv[name];
  }
});

describe("Session owner commands through the real dispatcher", () => {
  for (const owner of ["chat", "issue"] as const) {
    const prefix = owner === "chat" ? ["session"] : ["issue", "session"];
    const ownerId = owner === "chat" ? "chat_1" : "MUL-1";
    const base = owner === "chat" ? "/api/multiremi/chats/chat_1/sessions" : "/api/issues/MUL-1/sessions";
    const cases = [
      { action: ["list"], args: [], method: "GET", path: base },
      { action: ["get"], args: ["ises_1"], method: "GET", path: `${base}/ises_1` },
      { action: ["create"], args: ["--title", "Side", "--from", "ises_parent", "--inherit-mode", "follow"], method: "POST", path: base,
        body: { title: "Side", holds_workspace: false, parent_session_id: "ises_parent", inherit_mode: "follow" } },
      { action: ["update"], args: ["ises_1", "--status", "archived"], method: "PATCH", path: `${base}/ises_1`, body: { status: "archived" } },
      { action: ["participant", "list"], args: ["ises_1"], method: "GET", path: `${base}/ises_1/participants` },
    ];
    for (const sample of cases) it(`${owner} ${sample.action.join(" ")} remains executable`, async () => {
      setup({ id: "ises_1", owner_type: owner, owner_id: ownerId });
      await dispatch([...prefix, ...sample.action, ownerId, ...sample.args, "--json"]);
      expect(requests).toHaveLength(2);
      const request = requests[1]!;
      expect(new URL(request.url).pathname).toBe(sample.path);
      expect(request.method).toBe(sample.method);
      if (sample.body) expect(await request.json()).toEqual(sample.body);
      expect(JSON.parse(output.join("\n"))).toMatchObject({ owner_type: owner, owner_id: ownerId });
      const declaration = cliCommandInventory().find(entry => entry.path.join(" ") === [...prefix, ...sample.action].join(" "))!;
      expect(declaration.retired).toBeUndefined();
      expect(declaration.capability).toBe(declaration.id);
      expect(declaration.positionals[0]?.name).toBe(owner);
    });

    it(`${owner} result publishing remains executable`, async () => {
      setup({ id: "sres_1" });
      const sessionArgs = owner === "chat" ? ["ises_1"] : ["--session", "ises_1"];
      await dispatch([...prefix, "result", "publish", ownerId, ...sessionArgs, "--content", "Done", "--json"]);
      expect(requests).toHaveLength(2);
      expect(new URL(requests[1]!.url).pathname).toBe(`${base}/ises_1/results`);
      expect(await requests[1]!.json()).toEqual(owner === "chat"
        ? { body: "Done", metadata: { type: "other", refs: [] } }
        : { title: "", body: "Done" });
      expect(JSON.parse(output.join("\n"))).toEqual({ id: "sres_1" });
    });
  }

  it("keeps Issue result aggregation and Session filtering", async () => {
    setup([{ id: "sres_1", source_session_id: "ises_1" }, { id: "sres_2", source_session_id: "ises_2" }]);
    await dispatch(["issue", "session", "result", "list", "MUL-1", "--session", "ises_1", "--json"]);
    expect(requests).toHaveLength(2);
    expect(new URL(requests[1]!.url).pathname).toBe("/api/issues/MUL-1/session-results");
    expect(JSON.parse(output.join("\n"))).toEqual([{ id: "sres_1", source_session_id: "ises_1" }]);
  });

  for (const sessionId of ["ises_chat_owned", "ises_issue_owned"]) {
    it(`sends and lists unified execution for ${sessionId}`, async () => {
      setup({ message: { id: "msg_1", session_id: sessionId }, wake_applied: "now", wake_reason: "human_sender" });
      await dispatch(["message", "send", sessionId, "--to", "agt_1", "--kind", "request", "--content", "Check", "--json"]);
      expect(new URL(requests[1]!.url).pathname).toBe(`/api/sessions/${sessionId}/messages`);
      expect(await requests[1]!.json()).toEqual({ body_md: "Check", to: { type: "agent", ref: "agt_1" }, message_kind: "request", wake_requested: "now", reply_to_id: null, dedupe_key: null });

      setup({ turns: [] });
      await dispatch(["turn", "list", "--session", sessionId, "--json"]);
      expect(requests).toHaveLength(2);
      const url = new URL(requests[1]!.url);
      expect(url.pathname).toBe("/api/turns");
      expect(url.searchParams.get("session_id")).toBe(sessionId);
    });
  }

  for (const path of ["issue session event list", "issue session message create", "issue session task list", "issue session task create", "issue task steer", "issue task steers"]) {
    it(`retires ${path} before capabilities or writes`, async () => {
      setup();
      await expect(dispatch([...path.split(" "), "MUL-1", "ises_1", "--old-option"])).rejects.toThrow(`已移除：改用 ${RETIRED_CLI_COMMANDS[path]}`);
      expect(requests).toEqual([]);
      expect(output).toEqual([]);
      const declaration = cliCommandInventory().find(entry => entry.path.join(" ") === path)!;
      expect(declaration.retired?.replacement).toBe(RETIRED_CLI_COMMANDS[path]);
      expect(declaration.capability).toBeNull();
    });
  }

  it("rejects direct legacy Issue task helpers before reading content", async () => {
    setup();
    for (const action of ["steer", "steers"]) {
      await expect(issueTask([action, "tsk_old"], { "content-file": "/missing" })).rejects.toThrow(`已移除：改用 ${RETIRED_CLI_COMMANDS[`issue task ${action}`]}`);
    }
    expect(requests).toEqual([]);
  });
});
