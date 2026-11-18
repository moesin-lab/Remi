import { expect, it } from "bun:test";
import { createAdapter } from "@acp/index.js";
import { createTraceTranslator, parseTraceTranslatorCheckpoint } from "@multiremi/worker/trace-translator.js";
import { EMPTY_TURN_TRACE, applyTurnTraceEvents } from "@shared/turn-trace.js";
import type { TraceEvent, TraceEventInput } from "@multiremi/contracts/trace.js";

it("closes old work and restores identities without resurrecting activity or autonomous obligations", () => {
  let state = EMPTY_TURN_TRACE, seq = 0;
  const events: TraceEvent[] = [];
  const emit = (batch: TraceEventInput[]) => {
    const stored = batch.map(event => ({ ...event, seq: ++seq, ts: new Date().toISOString() }) as TraceEvent);
    events.push(...stored); state = applyTurnTraceEvents(state, stored);
  };
  const first = createTraceTranslator(createAdapter("claude"), emit);
  first.start({ attemptId: "attempt", turnId: "turn", agentId: "agent", agentName: "Agent", provider: "claude", requestedModel: null, input: [] });
  first.acp({ sessionUpdate: "subagent_spawned", subagentSessionId: "a0000000000000001", name: "Child", prompt: "RAW_PRIVATE_PROMPT",
    _meta: { remi: { backgrounded: true } } } as any);
  first.acp({ sessionUpdate: "tool_call", toolCallId: "child_call", name: "Bash", kind: "execute", status: "in_progress",
    rawInput: { command: "RAW_PRIVATE_COMMAND" }, _meta: { remiSessionId: "a0000000000000001", claudeCode: { toolName: "Bash", parentToolUseId: "agent_alias" } } } as any);
  first.acp({ sessionUpdate: "async_task_spawned", asyncTaskId: "background_1", name: "Long command", taskType: "shell", canStop: true } as any);
  const permission = first.permissionRequested({ decisionId: "Q", toolCallId: "child_call", title: "Allow?", options: [] });
  first.plannedRestart();
  expect(state.items.filter(item => item.type !== "permission" && item.status === "in_progress")).toEqual([]);
  expect(state.items.find(item => item.type === "background_task")).toMatchObject({ status: "stopped", stop_reason: "cancelled" });
  expect(state.items.find(item => item.id === permission)).toMatchObject({ status: "in_progress" });
  const snapshot = JSON.parse(JSON.stringify(first.checkpoint()));
  expect(JSON.stringify(snapshot)).not.toContain("RAW_PRIVATE");
  expect(parseTraceTranslatorCheckpoint(snapshot)).not.toBeNull();
  const activity: any[] = [];
  const resumed = createTraceTranslator(createAdapter("claude"), emit, { resume: { turn: state.turn!, items: state.items, runtime: snapshot }, onActivity: count => activity.push(count) });
  expect(activity.at(-1)).toEqual({ subagentsTop: 0, subagentsNested: 0, backgroundTasks: 0 });
  expect(resumed.runningBackgroundTasks).toEqual([]);
  expect(resumed.owesAutonomousRound).toBe(false);
  resumed.restarted(1); resumed.restarted(1);
  resumed.acp({ sessionUpdate: "tool_call", toolCallId: "after_restart", name: "Bash", kind: "execute", status: "completed",
    rawInput: { command: "echo continued" }, _meta: { claudeCode: { toolName: "Bash", parentToolUseId: "agent_alias" } } } as any);
  expect(state.items.find(item => item.id === "after_restart")?.parent_id).toBe("sa:a0000000000000001");
  expect(state.items.filter(item => item.type === "subagent")).toHaveLength(1);
  expect(state.items.filter(item => item.type === "notice" && item.title === "Remi 已更新")).toHaveLength(1);
  const again = createTraceTranslator(createAdapter("claude"), emit, { resume: { turn: state.turn!, items: state.items, runtime: resumed.checkpoint() } });
  again.restarted(1);
  expect(state.items.filter(item => item.type === "notice" && item.title === "Remi 已更新")).toHaveLength(1);
  expect(events.filter(event => event.type === "turn.started")).toHaveLength(1);
});

it("falls back to canonical native IDs when optional identity state is missing or malformed", () => {
  let state = EMPTY_TURN_TRACE, seq = 0;
  const emit = (batch: TraceEventInput[]) => {
    state = applyTurnTraceEvents(state, batch.map(event => ({ ...event, seq: ++seq, ts: new Date().toISOString() }) as TraceEvent));
  };
  const first = createTraceTranslator(createAdapter("claude"), emit);
  first.start({ attemptId: "attempt", turnId: "turn", agentId: "agent", agentName: null, provider: "claude", requestedModel: null, input: [] });
  first.acp({ sessionUpdate: "subagent_spawned", subagentSessionId: "a0000000000000001", name: "Child" } as any);
  first.plannedRestart();
  for (const runtime of [undefined, { version: 999 } as any]) {
    const warnings: string[] = [];
    const resumed = createTraceTranslator(createAdapter("claude"), emit, { resume: { turn: state.turn!, items: state.items, runtime }, onResumeWarning: warning => warnings.push(warning) });
    expect(resumed.subagentOfSession("a0000000000000001:generation:1")?.item_id).toBe("sa:a0000000000000001");
    expect(resumed.owesAutonomousRound).toBe(false);
    expect(warnings.length).toBe(runtime ? 1 : 0);
  }
});
