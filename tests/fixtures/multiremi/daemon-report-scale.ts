import { createResponsibleTestIssue } from "../../unit/multiremi/helpers.js";
import { loadedFleet } from "./daemon-report-fleet.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";

export interface ReportScale {
  issues: number;
  sessions: number;
  logsPerSession: number;
  agents: number;
  skillsPerAgent: number;
  runtimes: number;
  historicalAttempts: number;
  outboxRows: number;
  queuedRows: number;
  activeAttempts?: number;
  pendingQuestions?: number;
  pendingOutbound?: number;
}
export const REPORT_SCALES = {
  small: { issues: 2, sessions: 2, logsPerSession: 4, agents: 2, skillsPerAgent: 1,
    runtimes: 4, historicalAttempts: 2, outboxRows: 2, queuedRows: 2, activeAttempts: 2, pendingQuestions: 1, pendingOutbound: 1 },
  stable: { issues: 100, sessions: 40, logsPerSession: 501, agents: 10, skillsPerAgent: 3,
    runtimes: 12, historicalAttempts: 80, outboxRows: 100, queuedRows: 100, activeAttempts: 12, pendingQuestions: 8, pendingOutbound: 20 },
} satisfies Record<string, ReportScale>;

// Use each driver's native JSON expansion, as the usage ledger does. One bound
// array avoids 20,000 synchronous PG round trips and SQLite's bind limit.
function insertRows(db: SqlDatabase, table: string, columns: string[], rows: unknown[][], integers: string[] = []) {
  if (!rows.length) return;
  const fields = columns.map((column, i) => {
    const field = db.dialect === "postgres" ? `batch.value->>${i}` : `json_extract(batch.value,'$[${i}]')`;
    return `CAST(${field} AS ${integers.includes(column) ? "BIGINT" : "TEXT"})`;
  });
  const from = db.dialect === "postgres"
    ? "jsonb_array_elements(CAST(CAST(? AS TEXT) AS JSONB)) AS batch(value)" : "json_each(?) AS batch";
  db.run(`INSERT INTO ${table} (${columns.join(',')}) SELECT ${fields.join(',')} FROM ${from}`, [JSON.stringify(rows)]);
}

/** Seed once per tier in beforeAll; callers reuse the live protocol fleet.
 * No timers, external providers or production connections are needed. Set
 * MULTIREMI_TEST_POSTGRES_URL to run the identical seed and frames on real PG.
 */
export async function createReportScaleFixture(scale: ReportScale) {
  for (const [dimension, value] of Object.entries(scale))
    if (!Number.isSafeInteger(value) || value < (["activeAttempts", "pendingQuestions", "pendingOutbound"].includes(dimension) ? 0 : 1)) throw new Error(`Invalid scale: ${dimension}`);
  if (scale.issues < scale.sessions - 1 || scale.agents < 2 || scale.sessions < 2 || scale.runtimes < 4 || scale.runtimes % 2)
    throw new Error("Scale requires >=2 agents/sessions, enough issues, and an even runtime count >=4");
  const activeAttempts = scale.activeAttempts ?? 0;
  const pendingQuestions = scale.pendingQuestions ?? 0;
  const pendingOutbound = scale.pendingOutbound ?? 0;
  if (pendingQuestions > activeAttempts) throw new Error("Questions require live source attempts");
  const f = await loadedFleet(2, scale.runtimes, false, true);
  const agents = [f.agent, f.store.getAgent(f.peer.agentId)!];
  for (let i = agents.length; i < scale.agents; i++) agents.push(f.store.createAgent({
    name: `Scale agent ${i}`, provider: i % 2 ? "codex" : "claude", runtimeId: f.runtimeIds[i % f.runtimeIds.length],
  }));
  for (const [i, agent] of agents.entries()) {
    const skills = Array.from({ length: scale.skillsPerAgent }, (_, j) => f.store.createSkill({
      name: `Scale skill ${i}-${j}`, content: "# Fixture skill", files: [{ path: "reference.md", content: "fixture" }],
    }));
    f.store.setAgentSkills(agent.id, skills.map(skill => skill.id!));
  }
  const issues = [f.issue];
  for (let i = 1; i < scale.issues; i++) issues.push(createResponsibleTestIssue(f.store, {
    title: `Scale issue ${i}`, workspaceId: "local", status: "in_progress",
    assigneeType: "agent", assigneeId: agents[i % agents.length]!.id,
  }));
  const sessionIds = [f.issueSession.id, f.peer.chatSessionId!];
  for (let i = 2; i < scale.sessions; i++) sessionIds.push(f.store.getOrCreateDefaultIssueSession(issues[i - 1]!.id).id);
  const now = new Date().toISOString();
  f.database.transaction(() => {
    for (const sessionId of sessionIds) {
      const from = f.store.getConversationLogHead(sessionId)?.headSeq ?? 0;
      insertRows(f.database, 'multiremi_conversation_log',
        ['session_id','seq','id','kind','visibility','sender_type','sender_id','body_md','message_kind','metadata','created_at','updated_at'],
        Array.from({ length: scale.logsPerSession }, (_, i) => [sessionId,from+i+1,`scale-${sessionId}-${i}`,
          'message','shown','agent',f.agent.id,`Scale log ${i}`,'status','{}',now,now]), ['seq']);
      f.database.run(`INSERT INTO multiremi_conversation_heads (head_seq,session_id,log_version,updated_at) VALUES (?,?,1,?) ON CONFLICT(session_id) DO UPDATE SET head_seq=excluded.head_seq,log_version=multiremi_conversation_heads.log_version+1`,
        [from + scale.logsPerSession, sessionId, now]);
    }
  })();
  for (let i = 0; i < scale.historicalAttempts; i++) {
    const task = f.store.createTask({ agentId: f.agent.id, maxAttempts: 1, prompt: `Historical attempt ${i}`,
      runtimeId: f.runtimeIds[0] });
    f.store.claimTask(f.runtimeIds[0]!);
    f.store.startTask(task.id);
    f.store.reportTaskUsage(task.id, [{ provider: 'claude', model: 'fixture', inputTokens: 10, outputTokens: 2 }]);
    f.store.failTask(task.id, { error: 'historical failure' });
  }
  // Seed actual bot binding/outbox rows through the store, then expand terminal
  // history without scheduling external deliveries.
  const inbound = f.store.submitFeishuBotMessage('local', f.runtimeIds[0]!, {
    revision: f.config.revision, externalSessionKey: 'oc_scale', externalMessageId: 'om_scale',
    chatId: 'oc_scale', text: 'scale seed', senderOpenId: 'ou_scale', deliveryMode: 'native_cot_v1',
  });
  const binding = f.database.query('SELECT id FROM multiremi_feishu_bot_chat_bindings WHERE chat_session_id=?').get(inbound.chatSessionId)!;
  insertRows(f.database, 'multiremi_feishu_bot_outbound_deliveries',
    ['id','workspace_id','binding_id','chat_id','body','status','available_at','created_at','updated_at'],
    Array.from({ length: scale.outboxRows }, (_, i) => [`scale-outbox-${i}`,'local',binding.id,'oc_scale','history','sent',now,now,now]));
  insertRows(f.database, 'multiremi_queued_messages',
    ['id','workspace_id','session_id','agent_id','seq','sender_member_id','body_md','client_id','status','created_at','updated_at'],
    Array.from({ length: scale.queuedRows }, (_, i) => [`scale-queue-${i}`,'local',f.peer.chatSessionId,f.peer.agentId,i+1,'local','queued',`scale-client-${i}`,'queued',now,now]), ['seq']);
  for (let i = 0; i < scale.queuedRows; i++) f.store.createRuntimeCommandRequest(f.runtimeIds[i % f.runtimeIds.length]!, { command: 'fixture-no-execution' });
  const activeTasks = [];
  const questionIds: string[] = [];
  // Separate lanes avoid the per-session single-active-turn gate. Keep these
  // on the reporting host so a heartbeat really snapshots concurrent work.
  f.store.updateRuntime(f.runtimeIds[0]!, { maxConcurrency: activeAttempts + 8 });
  for (let i = 0; i < activeAttempts; i++) {
    const agent = f.store.createAgent({ name: `Live scale ${i}`, provider: 'claude', runtimeId: f.runtimeIds[0] });
    const chat = f.store.createChatSession({ agentId: agent.id });
    const task = f.store.sendChatMessage(chat.id, { body: `Concurrent work ${i}` }).task;
    await f.layer.drain();
    for (let claim = 0; claim < 30 && f.store.getTask(task.id)?.status === 'queued'; claim++) {
      if (!f.store.claimTask(f.runtimeIds[0]!)) break;
    }
    if (f.store.getTask(task.id)?.status === 'queued') throw new Error(`Live fixture claim failed ${i}: ${JSON.stringify(f.store.getTask(task.id))}`);
    f.store.startTask(task.id);
    activeTasks.push(task);
    if (i < pendingQuestions) {
      const turn = f.store.getTurnForAttempt(task.id)!;
      const permission = i % 2 === 1;
      const result = f.store.getDaemonTurnBridge().rpc('turn.decision', {
        turn_id: turn.id, attempt_id: task.id, dedupe_key: `scale-question-${i}`, wait_id: `scale-wait-${i}`,
        body_md: permission ? 'Allow scale write?' : 'Choose scale direction',
        options: [{ label: 'Allow', value: 'allow_once' }],
        metadata: permission ? { kind: 'permission', options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow' }] }
          : { kind: 'question', questions: [{ fieldKey: 'direction', question: { question: 'Direction?', options: [{ label: 'A' }] } }] },
      }, { runtimeId: f.runtimeIds[0]!, daemonId: 'dm_cost_0', workspaceId: 'local' });
      if (!result.ok) throw new Error(`Scale question rejected: ${JSON.stringify(result)}`);
      questionIds.push(String(result.message_id));
    }
  }
  insertRows(f.database, 'multiremi_feishu_bot_outbound_deliveries',
    ['id','workspace_id','binding_id','chat_id','body','status','available_at','created_at','updated_at'],
    Array.from({ length: pendingOutbound }, (_, i) => [`scale-pending-${i}`,'local',binding.id,'oc_scale',`pending ${i}`,'pending',now,now,now]));
  await f.layer.drain();
  for (const session of f.sessions) await session.handleMessage(JSON.stringify({ v: 2, t: 'ack', ack: session.lastSentSeq, p: {} }));
  await f.layer.drain();
  console.info('SCALE_ROWS', JSON.stringify(scale), f.database.query('SELECT status,COUNT(*) AS count FROM multiremi_turn_execution_records GROUP BY status').all());
  return { ...f, scale, sessionIds, agents, issues, activeTasks, questionIds };
}
