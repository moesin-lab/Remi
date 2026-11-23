import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AcpProvider } from "@acp/provider.js";
import { buildNativeAntigravityEnv, nativeAntigravityLaunch } from "@acp/access/antigravity-native.js";
import { seedIssueSessionNativeAntigravityHome } from "@daemon/agent-runtime/workspace/session-home.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "native-agy-test-")); roots.push(root);
  const base = join(root, "base"); mkdirSync(join(base, "antigravity-cli"), { recursive: true });
  writeFileSync(join(base, "antigravity-cli", "antigravity-oauth-token"), "fake-native-login");
  writeFileSync(join(base, "antigravity-cli", "settings.json"), '{"untrusted":"settings"}');
  const home = { storageRoot: root, root, home: join(root, "isolated"), provider: "antigravity" as const, agentId: "a", sessionId: "s", generation: 1 };
  return { root, base, home };
}
it("copies only native credentials into private storage and fails closed without login", async () => {
  const { root, base, home } = fixture();
  await seedIssueSessionNativeAntigravityHome(home, base);
  const target = join(home.home, "antigravity-cli", "antigravity-oauth-token");
  expect(readFileSync(target, "utf8")).toBe("fake-native-login");
  expect(statSync(target).mode & 0o777).toBe(0o600);
  expect(() => readFileSync(join(home.home, "antigravity-cli", "settings.json"))).toThrow();
  await expect(seedIssueSessionNativeAntigravityHome(home, join(root, "missing"))).rejects.toThrow("antigravity_login_required");
  rmSync(target); symlinkSync(join(base, "antigravity-cli", "antigravity-oauth-token"), target);
  await expect(seedIssueSessionNativeAntigravityHome(home, base)).rejects.toThrow("regular file");
});
it("keeps gateway credentials out of native execution and uses explicit ACP launch arguments", () => {
  const env = buildNativeAntigravityEnv({ home: "/isolated", shimUrl: "", model: null, daemonEnv: { AGY_LLM_GATEWAY_API_KEY: "secret", GEMINI_API_KEY: "secret", AGY_ACP_CCPA_BASE_URL: "wrong" } });
  expect(JSON.stringify(env)).not.toContain("secret");
  expect(env.AGY_ACP_CCPA_BASE_URL).toBe("");
  expect(env.GEMINI_HOME).toBe("/isolated");
  expect(nativeAntigravityLaunch("/isolated", "bypassPermissions").args).toContain("--dangerously-skip-permissions");
  expect(nativeAntigravityLaunch("/isolated", "plan").args).not.toContain("--dangerously-skip-permissions");
  expect(() => nativeAntigravityLaunch()).toThrow("home_required");
});
it("discovers models and effort, executes and resumes without a gateway", async () => {
  const { root, base, home } = fixture();
  await seedIssueSessionNativeAntigravityHome(home, base);
  const options = { agentType: "antigravity", antigravityNative: true, providerHome: home.home, cwd: root,
    executable: resolve("tests/fixtures/antigravity-native-fake.mjs"), env: { AGY_LLM_GATEWAY_URL: "https://wrong.test", AGY_LLM_GATEWAY_API_KEY: "wrong" } };
  const p = new AcpProvider(options);
  try {
    const models = await p.discoverModelCapabilities();
    expect(models.map(m => m.id)).toEqual(["native-model", "other-model"]);
    expect(models[0]?.effort?.supportedLevels.map(l => l.value)).toEqual(["low", "medium", "high"]);
    for await (const _ of p.sendStream("test", { chatId: "native", model: "other-model", effort: "high" })) {}
    expect(p.getLastResponse()?.text).toContain("other-model:high:native-ok");
  } finally { await p.close(); }
  const resumed = new AcpProvider(options);
  try {
    for await (const _ of resumed.sendStream("again", { chatId: "native", sessionId: "native-session", model: "native-model", effort: "low" })) {}
    expect(resumed.getLastResponse()?.text).toContain("native-model:low:native-ok");
  } finally { await resumed.close(); }
});

function writeContinuationFake(root: string, mode: string) {
  const script = join(root, `native-continuation-${mode}.mjs`);
  const logFile = join(root, `native-continuation-${mode}.jsonl`);
  writeFileSync(script, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const mode = ${JSON.stringify(mode)};
const logFile = ${JSON.stringify(logFile)};
const send = obj => process.stdout.write(JSON.stringify(obj) + '\\n');
const update = body => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'native-session', update: body } });
let promptCount = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const r = JSON.parse(line);
  let result = {};
  if (r.method === 'initialize') {
    result = { protocolVersion: 1, agentInfo: { name: 'native-fake', version: '1.5.9' }, agentCapabilities: { loadSession: true }, authMethods: [] };
  } else if (['session/new', 'session/load', 'session/resume'].includes(r.method)) {
    result = { sessionId: 'native-session', configOptions: [], modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] } };
  } else if (r.method === 'session/prompt') {
    promptCount++;
    const text = (r.params.prompt || []).map(b => b.text || '').join('');
    appendFileSync(logFile, JSON.stringify({ promptCount, sessionId: r.params.sessionId, text }) + '\\n');
    if (mode === 'manage-task-done') {
      if (promptCount === 1) {
        update({ sessionUpdate: 'tool_call', toolCallId: 'call_bg_1', title: 'tsc --noEmit', kind: 'execute', status: 'in_progress',
          rawInput: { CommandLine: './node_modules/.bin/tsc --noEmit', WaitMsBeforeAsync: 10000 } });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_bg_1', status: 'in_progress',
          rawOutput: 'Tool is running as a background task with task id: bg_task_1\\nYOU MUST TAKE ONE OF THE FOLLOWING TWO ACTIONS: A) proceed or B) update the user and end the turn.' });
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Waiting for typecheck to complete... ' } });
        result = { stopReason: 'end_turn' };
      } else {
        update({ sessionUpdate: 'tool_call', toolCallId: 'call_mt_1', title: 'Running manage_task', kind: 'other', status: 'in_progress',
          rawInput: { Action: 'status', TaskId: 'bg_task_1' } });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_mt_1', status: 'completed',
          rawOutput: 'Task bg_task_1\\nStatus: DONE\\nExit code: 0' });
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Typecheck passed.' } });
        result = { stopReason: 'end_turn' };
      }
    } else if (mode === 'tool-call-completed') {
      if (promptCount === 1) {
        update({ sessionUpdate: 'tool_call', toolCallId: 'call_bg_2', title: 'bun test', kind: 'execute', status: 'in_progress',
          rawInput: { CommandLine: 'bun test', WaitMsBeforeAsync: 10000 } });
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Running tests... ' } });
        result = { stopReason: 'end_turn' };
      } else {
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_bg_2', status: 'completed', rawOutput: { exitCode: 0, combinedOutput: 'all passed' } });
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'All tests passed.' } });
        result = { stopReason: 'end_turn' };
      }
    } else if (mode === 'manage-task-kill') {
      if (promptCount === 1) {
        update({ sessionUpdate: 'tool_call', toolCallId: 'call_bg_kill', title: 'sleep 60', kind: 'execute', status: 'in_progress',
          rawInput: { CommandLine: 'sleep 60', WaitMsBeforeAsync: 10000 } });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_bg_kill', status: 'in_progress',
          rawOutput: 'Tool is running as a background task with task id: bg_kill_1' });
        result = { stopReason: 'end_turn' };
      } else {
        update({ sessionUpdate: 'tool_call', toolCallId: 'call_mt_kill', title: 'manage_task', kind: 'other', status: 'in_progress',
          rawInput: { Action: 'kill', TaskId: 'bg_kill_1' } });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_mt_kill', status: 'completed', rawOutput: 'Task killed.' });
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Killed stuck command.' } });
        result = { stopReason: 'end_turn' };
      }
    } else if (mode === 'system-message-done') {
      if (promptCount === 1) {
        update({ sessionUpdate: 'tool_call', toolCallId: 'call_bg_sys', title: 'npm run build', kind: 'execute', status: 'in_progress',
          rawInput: { CommandLine: 'npm run build', WaitMsBeforeAsync: 10000 } });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_bg_sys', status: 'in_progress',
          rawOutput: 'Tool is running as a background task with task id: bg_sys_1' });
        result = { stopReason: 'end_turn' };
      } else {
        update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '<SYSTEM_MESSAGE>Background task bg_sys_1 completed with exit code 0.</SYSTEM_MESSAGE>' } });
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Build finished.' } });
        result = { stopReason: 'end_turn' };
      }
    } else if (mode === 'daemon-no-continue') {
      update({ sessionUpdate: 'tool_call', toolCallId: 'call_daemon_1', title: 'bun run dev', kind: 'execute', status: 'in_progress',
        rawInput: { CommandLine: 'bun run dev', IsDaemon: true, WaitMsBeforeAsync: 500 } });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_daemon_1', status: 'in_progress',
        rawOutput: 'Tool is running as a background task with task id: daemon_task_1' });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Dev server running.' } });
      result = { stopReason: 'end_turn' };
    } else if (mode === 'bounded-max-continuations') {
      if (promptCount === 1) {
        update({ sessionUpdate: 'tool_call', toolCallId: 'call_stuck_1', title: 'sleep 999', kind: 'execute', status: 'in_progress',
          rawInput: { CommandLine: 'sleep 999', WaitMsBeforeAsync: 10000 } });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_stuck_1', status: 'in_progress',
          rawOutput: 'Tool is running as a background task with task id: stuck_task_1' });
      }
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Still waiting ' + promptCount + '. ' } });
      result = { stopReason: 'end_turn' };
    }
  }
  if (r.id !== undefined) send({ jsonrpc: '2.0', id: r.id, result });
}
`, { mode: 0o755 });
  chmodSync(script, 0o755);
  const readPrompts = () => existsSync(logFile)
    ? readFileSync(logFile, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as { promptCount: number; sessionId: string; text: string })
    : [];
  return { script, readPrompts };
}

describe("Antigravity background run_command continuation guard", () => {
  it("continues on the same native-session until manage_task confirms Status: DONE", async () => {
    const { root, base, home } = fixture();
    await seedIssueSessionNativeAntigravityHome(home, base);
    const fake = writeContinuationFake(root, "manage-task-done");
    const p = new AcpProvider({ agentType: "antigravity", antigravityNative: true, providerHome: home.home, cwd: root, executable: fake.script });
    try {
      for await (const _ of p.sendStream("run typecheck", { chatId: "bg-done" })) {}
      const prompts = fake.readPrompts();
      expect(prompts).toHaveLength(2);
      expect(prompts[0]).toMatchObject({ promptCount: 1, sessionId: "native-session", text: "run typecheck" });
      expect(prompts[1]?.sessionId).toBe("native-session");
      expect(prompts[1]?.text).toContain('manage_task (Action: "status")');
      expect(prompts[1]?.text).toContain("Status: DONE");
      expect(prompts[1]?.text).toContain("bg_task_1");
      expect(p.getLastResponse()?.text).toContain("Typecheck passed.");
    } finally { await p.close(); }
  });

  it("stops continuing once tool_call_update marks the backgrounded run_command completed", async () => {
    const { root, base, home } = fixture();
    await seedIssueSessionNativeAntigravityHome(home, base);
    const fake = writeContinuationFake(root, "tool-call-completed");
    const p = new AcpProvider({ agentType: "antigravity", antigravityNative: true, providerHome: home.home, cwd: root, executable: fake.script });
    try {
      for await (const _ of p.sendStream("run tests", { chatId: "bg-completed" })) {}
      const prompts = fake.readPrompts();
      expect(prompts).toHaveLength(2);
      expect(prompts.map(item => item.sessionId)).toEqual(["native-session", "native-session"]);
      expect(p.getLastResponse()?.text).toContain("All tests passed.");
    } finally { await p.close(); }
  });

  it("clears pending background commands on manage_task Action: kill and <SYSTEM_MESSAGE> completion receipts", async () => {
    for (const [mode, expectedText] of [["manage-task-kill", "Killed stuck command."], ["system-message-done", "Build finished."]] as const) {
      const { root, base, home } = fixture();
      await seedIssueSessionNativeAntigravityHome(home, base);
      const fake = writeContinuationFake(root, mode);
      const p = new AcpProvider({ agentType: "antigravity", antigravityNative: true, providerHome: home.home, cwd: root, executable: fake.script });
      try {
        for await (const _ of p.sendStream("go", { chatId: mode })) {}
        expect(fake.readPrompts()).toHaveLength(2);
        expect(p.getLastResponse()?.text).toContain(expectedText);
      } finally { await p.close(); }
    }
  });

  it("does not trigger continuation when IsDaemon is true", async () => {
    const { root, base, home } = fixture();
    await seedIssueSessionNativeAntigravityHome(home, base);
    const fake = writeContinuationFake(root, "daemon-no-continue");
    const p = new AcpProvider({ agentType: "antigravity", antigravityNative: true, providerHome: home.home, cwd: root, executable: fake.script });
    try {
      for await (const _ of p.sendStream("start dev server", { chatId: "daemon-ok" })) {}
      expect(fake.readPrompts()).toHaveLength(1);
      expect(p.getLastResponse()?.text).toBe("Dev server running.");
    } finally { await p.close(); }
  });

  it("exits cleanly after at most 3 bounded continuations when the command never finishes", async () => {
    const { root, base, home } = fixture();
    await seedIssueSessionNativeAntigravityHome(home, base);
    const fake = writeContinuationFake(root, "bounded-max-continuations");
    const p = new AcpProvider({ agentType: "antigravity", antigravityNative: true, providerHome: home.home, cwd: root, executable: fake.script });
    try {
      for await (const _ of p.sendStream("run stuck command", { chatId: "bounded" })) {}
      const prompts = fake.readPrompts();
      expect(prompts).toHaveLength(4);
      expect(prompts.every(item => item.sessionId === "native-session")).toBe(true);
      expect(p.getLastResponse()?.text).toContain("Still waiting 4.");
    } finally { await p.close(); }
  });
});
