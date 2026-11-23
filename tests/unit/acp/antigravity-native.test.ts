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

const REAL_CONV_ID = "462ce2d8-4e13-4e87-a53b-f7d18f3aec1e";
const TASK_1 = `${REAL_CONV_ID}/task-1`;
const TASK_10 = `${REAL_CONV_ID}/task-10`;
const TASK_26 = `${REAL_CONV_ID}/task-26`;

function writeContinuationFake(root: string, mode: string) {
  const script = join(root, `native-continuation-${mode}.mjs`);
  const logFile = join(root, `native-continuation-${mode}.jsonl`);
  writeFileSync(script, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const mode = ${JSON.stringify(mode)};
const logFile = ${JSON.stringify(logFile)};
const TASK_1 = ${JSON.stringify(TASK_1)};
const TASK_10 = ${JSON.stringify(TASK_10)};
const TASK_26 = ${JSON.stringify(TASK_26)};
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
          rawOutput: 'Tool is running as a background task with task id: ' + TASK_26 + '\\nYOU MUST TAKE ONE OF THE FOLLOWING TWO ACTIONS: A) proceed or B) update the user and end the turn.' });
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Waiting for typecheck to complete... ' } });
        result = { stopReason: 'end_turn' };
      } else {
        update({ sessionUpdate: 'tool_call', toolCallId: 'call_mt_1', title: 'Running manage_task', kind: 'other', status: 'in_progress',
          rawInput: { Action: 'status', TaskId: TASK_26 } });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_mt_1', status: 'completed',
          rawOutput: 'Task ' + TASK_26 + '\\nStatus: DONE\\nExit code: 0' });
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
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_bg_2', status: 'completed', rawOutput: { output: 'Command exited with code 0\\nall passed' } });
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'All tests passed.' } });
        result = { stopReason: 'end_turn' };
      }
    } else if (mode === 'manage-task-kill') {
      if (promptCount === 1) {
        update({ sessionUpdate: 'tool_call', toolCallId: 'call_bg_kill', title: 'sleep 60', kind: 'execute', status: 'in_progress',
          rawInput: { CommandLine: 'sleep 60', WaitMsBeforeAsync: 10000 } });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_bg_kill', status: 'in_progress',
          rawOutput: 'Tool is running as a background task with task id: ' + TASK_1 });
        result = { stopReason: 'end_turn' };
      } else {
        update({ sessionUpdate: 'tool_call', toolCallId: 'call_mt_kill', title: 'manage_task', kind: 'other', status: 'in_progress',
          rawInput: { Action: 'kill', TaskId: TASK_1 } });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_mt_kill', status: 'completed', rawOutput: 'Task killed.' });
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Killed stuck command.' } });
        result = { stopReason: 'end_turn' };
      }
    } else if (mode === 'system-message-done') {
      if (promptCount === 1) {
        update({ sessionUpdate: 'tool_call', toolCallId: 'call_bg_sys', title: 'npm run build', kind: 'execute', status: 'in_progress',
          rawInput: { CommandLine: 'npm run build', WaitMsBeforeAsync: 10000 } });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_bg_sys', status: 'in_progress',
          rawOutput: 'Tool is running as a background task with task id: ' + TASK_26 });
        result = { stopReason: 'end_turn' };
      } else {
        update({ sessionUpdate: 'user_message_chunk', content: { type: 'text',
          text: '<SYSTEM_MESSAGE>[Message] timestamp=2026-11-23T06:00:00Z sender=' + TASK_26 + ' priority=MESSAGE_PRIORITY_HIGH content=Task id "' + TASK_26 + '" finished with result: ok</SYSTEM_MESSAGE>' } });
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Build finished.' } });
        result = { stopReason: 'end_turn' };
      }
    } else if (mode === 'concurrent-slash-manage-task-and-late-exit') {
      if (promptCount === 1) {
        update({ sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'tsc --noEmit', kind: 'execute', status: 'in_progress',
          rawInput: { CommandLine: 'tsc --noEmit', WaitMsBeforeAsync: 10000 } });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'in_progress',
          rawOutput: 'Tool is running as a background task with task id: ' + TASK_1 });
        update({ sessionUpdate: 'tool_call', toolCallId: 'call_10', title: 'bun test', kind: 'execute', status: 'in_progress',
          rawInput: { CommandLine: 'bun test', WaitMsBeforeAsync: 10000 } });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_10', status: 'in_progress',
          rawOutput: 'Tool is running as a background task with task id: ' + TASK_10 });
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Waiting on both... ' } });
        result = { stopReason: 'end_turn' };
      } else if (promptCount === 2) {
        // task-1 completes via manage_task(list) and manage_task(status); task-10 stays RUNNING.
        update({ sessionUpdate: 'tool_call', toolCallId: 'call_mt_list', title: 'manage_task', kind: 'other', status: 'in_progress',
          rawInput: { Action: 'list' } });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_mt_list', status: 'completed',
          rawOutput: 'Task ' + TASK_1 + '\\nStatus: DONE\\n\\nTask ' + TASK_10 + '\\nStatus: RUNNING' });
        update({ sessionUpdate: 'tool_call', toolCallId: 'call_mt_empty', title: 'manage_task', kind: 'other', status: 'in_progress',
          rawInput: { Action: 'status', TaskId: TASK_10 } });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_mt_empty', status: 'completed' });
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Task 1 done, waiting on task 10... ' } });
        result = { stopReason: 'end_turn' };
      } else {
        // Late run_command completed update with Command exited with code 0 clears task-10.
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_10', status: 'completed',
          rawOutput: { output: 'Command exited with code 0\\n100 passed' } });
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Both tasks done.' } });
        result = { stopReason: 'end_turn' };
      }
    } else if (mode === 'concurrent-system-message-task1-then-task10') {
      if (promptCount === 1) {
        update({ sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'job1', kind: 'execute', status: 'in_progress',
          rawInput: { CommandLine: 'job1', WaitMsBeforeAsync: 10000 } });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'in_progress',
          rawOutput: 'Tool is running as a background task with task id: ' + TASK_1 });
        update({ sessionUpdate: 'tool_call', toolCallId: 'call_10', title: 'job10', kind: 'execute', status: 'in_progress',
          rawInput: { CommandLine: 'job10', WaitMsBeforeAsync: 10000 } });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_10', status: 'in_progress',
          rawOutput: 'Tool is running as a background task with task id: ' + TASK_10 });
        result = { stopReason: 'end_turn' };
      } else if (promptCount === 2) {
        // Real agy acp <SYSTEM_MESSAGE> for task-1 must NOT clear task-10.
        update({ sessionUpdate: 'user_message_chunk', content: { type: 'text',
          text: '<SYSTEM_MESSAGE>[Message] timestamp=2026-11-23T06:00:00Z sender=' + TASK_1 + ' priority=MESSAGE_PRIORITY_HIGH content=Task id "' + TASK_1 + '" finished with result: ok</SYSTEM_MESSAGE>' } });
        result = { stopReason: 'end_turn' };
      } else {
        update({ sessionUpdate: 'user_message_chunk', content: { type: 'text',
          text: '<SYSTEM_MESSAGE>[Message] timestamp=2026-11-23T06:00:01Z sender=' + TASK_10 + ' priority=MESSAGE_PRIORITY_HIGH content=Task id "' + TASK_10 + '" finished with result: ok</SYSTEM_MESSAGE>' } });
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Task 1 then task 10 finished.' } });
        result = { stopReason: 'end_turn' };
      }
    } else if (mode === 'concurrent-system-message-task10-then-task1') {
      if (promptCount === 1) {
        update({ sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'job1', kind: 'execute', status: 'in_progress',
          rawInput: { CommandLine: 'job1', WaitMsBeforeAsync: 10000 } });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'in_progress',
          rawOutput: 'Tool is running as a background task with task id: ' + TASK_1 });
        update({ sessionUpdate: 'tool_call', toolCallId: 'call_10', title: 'job10', kind: 'execute', status: 'in_progress',
          rawInput: { CommandLine: 'job10', WaitMsBeforeAsync: 10000 } });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_10', status: 'in_progress',
          rawOutput: 'Tool is running as a background task with task id: ' + TASK_10 });
        result = { stopReason: 'end_turn' };
      } else if (promptCount === 2) {
        // Real agy acp <SYSTEM_MESSAGE> for task-10 must NOT prefix-match and clear task-1!
        update({ sessionUpdate: 'user_message_chunk', content: { type: 'text',
          text: '<SYSTEM_MESSAGE>[Message] timestamp=2026-11-23T06:00:00Z sender=' + TASK_10 + ' priority=MESSAGE_PRIORITY_HIGH content=Task id "' + TASK_10 + '" finished with result: ok</SYSTEM_MESSAGE>' } });
        result = { stopReason: 'end_turn' };
      } else {
        update({ sessionUpdate: 'user_message_chunk', content: { type: 'text',
          text: '<SYSTEM_MESSAGE>[Message] timestamp=2026-11-23T06:00:01Z sender=' + TASK_1 + ' priority=MESSAGE_PRIORITY_HIGH content=Task id "' + TASK_1 + '" finished with result: ok</SYSTEM_MESSAGE>' } });
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Task 10 then task 1 finished.' } });
        result = { stopReason: 'end_turn' };
      }
    } else if (mode === 'in-progress-then-completed-handoff') {
      if (promptCount === 1) {
        update({ sessionUpdate: 'tool_call', toolCallId: 'call_handoff', title: 'tsc --noEmit', kind: 'execute', status: 'in_progress',
          rawInput: { CommandLine: './node_modules/.bin/tsc --noEmit', WaitMsBeforeAsync: 10000 } });
        // First in_progress reports background task id...
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_handoff', status: 'in_progress',
          rawOutput: 'Tool is running as a background task with task id: ' + TASK_26 });
        // ...then agy acp hands control back to the model with a completed frame carrying the same handoff notice and no exit code.
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_handoff', status: 'completed',
          rawOutput: 'Tool is running as a background task with task id: ' + TASK_26 + '\\nYOU MUST TAKE ONE OF THE FOLLOWING TWO ACTIONS: A) proceed or B) update the user and end the turn.' });
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Waiting after handoff... ' } });
        result = { stopReason: 'end_turn' };
      } else if (promptCount === 2) {
        // Empty manage_task frame does not falsely clear pending task.
        update({ sessionUpdate: 'tool_call', toolCallId: 'call_mt_26', title: 'manage_task', kind: 'other', status: 'in_progress',
          rawInput: { Action: 'status', TaskId: TASK_26 } });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_mt_26', status: 'completed' });
        result = { stopReason: 'end_turn' };
      } else {
        // Late real completion with Command exited with code 0 clears pending task.
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_handoff', status: 'completed',
          rawOutput: { output: 'Command exited with code 0\\nTypecheck ok' } });
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Handoff command finished.' } });
        result = { stopReason: 'end_turn' };
      }
    } else if (mode === 'completed-with-terminal-exit-meta') {
      update({ sessionUpdate: 'tool_call', toolCallId: 'call_meta_exit', title: 'echo ok', kind: 'execute', status: 'in_progress',
        rawInput: { CommandLine: 'echo ok', WaitMsBeforeAsync: 10000 } });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_meta_exit', status: 'completed',
        rawOutput: 'Tool is running as a background task with task id: ' + TASK_26,
        _meta: { terminal_exit: { terminal_id: 'call_meta_exit', exit_code: 0, signal: null } } });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Exited via meta.' } });
      result = { stopReason: 'end_turn' };
    } else if (mode === 'daemon-no-continue') {
      update({ sessionUpdate: 'tool_call', toolCallId: 'call_daemon_1', title: 'bun run dev', kind: 'execute', status: 'in_progress',
        rawInput: { CommandLine: 'bun run dev', IsDaemon: true, WaitMsBeforeAsync: 500 } });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_daemon_1', status: 'in_progress',
        rawOutput: 'Tool is running as a background task with task id: ' + TASK_1 });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Dev server running.' } });
      result = { stopReason: 'end_turn' };
    } else if (mode === 'bounded-max-continuations') {
      if (promptCount === 1) {
        update({ sessionUpdate: 'tool_call', toolCallId: 'call_stuck_1', title: 'sleep 999', kind: 'execute', status: 'in_progress',
          rawInput: { CommandLine: 'sleep 999', WaitMsBeforeAsync: 10000 } });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_stuck_1', status: 'in_progress',
          rawOutput: 'Tool is running as a background task with task id: ' + TASK_26 });
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
  it("continues on the same native-session until manage_task confirms Status: DONE for <uuid>/task-<n>", async () => {
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
      expect(prompts[1]?.text).toContain(TASK_26);
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

  it("clears pending background commands on manage_task Action: kill and <SYSTEM_MESSAGE> completion receipts with <uuid>/task-<n>", async () => {
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

  it("keeps full <uuid>/task-<n> ids distinct across concurrent tasks for manage_task and late run_command completed updates", async () => {
    const { root, base, home } = fixture();
    await seedIssueSessionNativeAntigravityHome(home, base);
    const fake = writeContinuationFake(root, "concurrent-slash-manage-task-and-late-exit");
    const p = new AcpProvider({ agentType: "antigravity", antigravityNative: true, providerHome: home.home, cwd: root, executable: fake.script });
    try {
      for await (const _ of p.sendStream("run both", { chatId: "concurrent-mt" })) {}
      const prompts = fake.readPrompts();
      expect(prompts).toHaveLength(3);
      expect(prompts[1]?.text).toContain(TASK_1);
      expect(prompts[1]?.text).toContain(TASK_10);
      expect(prompts[2]?.text).toContain(TASK_10);
      expect(prompts[2]?.text).not.toContain(`${TASK_1},`);
      expect(prompts[2]?.text).not.toContain(`${TASK_1}.`);
      expect(p.getLastResponse()?.text).toContain("Both tasks done.");
    } finally { await p.close(); }
  });

  it("uses exact task-id boundaries in <SYSTEM_MESSAGE> so .../task-1 and .../task-10 never clear each other", async () => {
    for (const [mode, remainingAfterFirst, clearedAfterFirst, expectedText] of [
      ["concurrent-system-message-task1-then-task10", TASK_10, TASK_1, "Task 1 then task 10 finished."],
      ["concurrent-system-message-task10-then-task1", TASK_1, TASK_10, "Task 10 then task 1 finished."],
    ] as const) {
      const { root, base, home } = fixture();
      await seedIssueSessionNativeAntigravityHome(home, base);
      const fake = writeContinuationFake(root, mode);
      const p = new AcpProvider({ agentType: "antigravity", antigravityNative: true, providerHome: home.home, cwd: root, executable: fake.script });
      try {
        for await (const _ of p.sendStream("run pair", { chatId: mode })) {}
        const prompts = fake.readPrompts();
        expect(prompts).toHaveLength(3);
        expect(prompts[1]?.text).toContain(TASK_1);
        expect(prompts[1]?.text).toContain(TASK_10);
        expect(prompts[2]?.text).toContain(`Pending task id(s): ${remainingAfterFirst}.`);
        expect(prompts[2]?.text).not.toContain(`Pending task id(s): ${clearedAfterFirst}.`);
        expect(p.getLastResponse()?.text).toContain(expectedText);
      } finally { await p.close(); }
    }
  });

  it("keeps pending task when in_progress announces bgTaskId and a follow-up completed handoff frame has no exit code", async () => {
    const { root, base, home } = fixture();
    await seedIssueSessionNativeAntigravityHome(home, base);
    const fake = writeContinuationFake(root, "in-progress-then-completed-handoff");
    const p = new AcpProvider({ agentType: "antigravity", antigravityNative: true, providerHome: home.home, cwd: root, executable: fake.script });
    try {
      for await (const _ of p.sendStream("run handoff", { chatId: "handoff" })) {}
      const prompts = fake.readPrompts();
      expect(prompts).toHaveLength(3);
      expect(prompts[1]?.text).toContain(`Pending task id(s): ${TASK_26}.`);
      expect(prompts[2]?.text).toContain(`Pending task id(s): ${TASK_26}.`);
      expect(p.getLastResponse()?.text).toContain("Handoff command finished.");
    } finally { await p.close(); }
  });

  it("clears pending task when a completed frame carries _meta.terminal_exit", async () => {
    const { root, base, home } = fixture();
    await seedIssueSessionNativeAntigravityHome(home, base);
    const fake = writeContinuationFake(root, "completed-with-terminal-exit-meta");
    const p = new AcpProvider({ agentType: "antigravity", antigravityNative: true, providerHome: home.home, cwd: root, executable: fake.script });
    try {
      for await (const _ of p.sendStream("run quick", { chatId: "meta-exit" })) {}
      expect(fake.readPrompts()).toHaveLength(1);
      expect(p.getLastResponse()?.text).toBe("Exited via meta.");
    } finally { await p.close(); }
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
