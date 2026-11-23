import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { MultiremiTask } from "@multiremi/contracts/types.js";
import { createMultiremiApp } from "@multiremi/api.js";
import { CLI_CAPABILITIES_RUNTIME } from "@multiremi/api/cli-capabilities-generated.js";
import { signIssueShareId } from "@multiremi/api/helpers/issue-share-tokens.js";
import { MultiremiStore } from "@multiremi/store.js";
import { ACTIVE_TASK_STATUSES } from "@multiremi/store/helpers.js";
import type { TaskSnapshotAccess } from "@multiremi/store/repos/tasks-repo.js";
import type { SqlDatabase, SqlStatement } from "@multiremi/store/db/postgres.js";
import { multiremiVersion } from "@multiremi/version.js";
import { openHotspotDatabase, useMigratedHotspotDatabases } from "../../fixtures/multiremi/first-screen-hotspots-database.js";

useMigratedHotspotDatabases();

const resources: Array<Awaited<ReturnType<typeof openHotspotDatabase>>> = [];
let previousFeishuKey: string | undefined;

beforeEach(() => {
  previousFeishuKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
});

afterEach(() => {
  if (previousFeishuKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousFeishuKey;
});

afterAll(async () => {
  for (const resource of resources) await resource.dispose();
});

function instrumentDb(raw: SqlDatabase): { db: SqlDatabase; statements: string[] } {
  const statements: string[] = [];
  const db = new Proxy(raw, {
    get(target, property) {
      if (property === "query" || property === "prepare") {
        return (sql: string) => {
          const statement = target[property](sql);
          return new Proxy(statement, {
            get(stmt, prop) {
              const value = stmt[prop as keyof SqlStatement];
              if (["get", "all", "run", "values"].includes(String(prop))) {
                return (...args: unknown[]) => {
                  statements.push(sql.replace(/\s+/g, " ").trim());
                  return (value as (...callArgs: unknown[]) => unknown).apply(stmt, args);
                };
              }
              return typeof value === "function" ? value.bind(stmt) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as SqlDatabase;
  return { db, statements };
}

/**
 * Exact pre-optimization 3-scan view SQL for `listWorkspaceAgentTaskSnapshot`.
 * Hydrates matched IDs via `store.hydrateTasksByIds` (with public/full column
 * parity checked separately) so every field of `MultiremiTask` is compared.
 */
function legacySnapshotIdsAndOrder(
  db: SqlDatabase,
  workspaceId: string,
  access?: TaskSnapshotAccess,
): Array<{ id: string; status: string; updated_at: string; completed_at: string | null; failed_at: string | null }> {
  const activePlaceholders = ACTIVE_TASK_STATUSES.map(() => "?").join(", ");
  const identityParams: Array<string | null> = [];
  let chatAccess = "";
  if (access) {
    let sessionAccess = "";
    if (access.taskToken) {
      sessionAccess = " AND task.id = ? AND task.agent_id = ? AND task.workspace_id = ?";
      identityParams.push(access.taskToken.taskId, access.taskToken.agentId, access.taskToken.workspaceId);
    }
    chatAccess = ` AND (((task.chat_session_id IS NULL OR task.chat_session_id = '') AND NOT EXISTS (
      SELECT 1 FROM multiremi_issue_sessions session
      WHERE session.id = task.issue_session_id AND session.chat_id IS NOT NULL
    )) OR EXISTS (
      SELECT 1 FROM multiremi_chat_sessions chat WHERE chat.id = task.chat_session_id${sessionAccess}
    ))`;
  }
  return db.query(
    `WITH ranked_outcomes AS (
       SELECT id,
              ROW_NUMBER() OVER (
                PARTITION BY agent_id
                ORDER BY COALESCE(completed_at, failed_at, updated_at, created_at) DESC
              ) AS outcome_rank
       FROM multiremi_turn_execution_records
       WHERE workspace_id = ? AND status IN ('completed', 'failed')
     ), candidates AS (
       SELECT id FROM multiremi_turn_execution_records
       WHERE workspace_id = ? AND status IN (${activePlaceholders})
       UNION SELECT id FROM ranked_outcomes WHERE outcome_rank = 1
     )
     SELECT task.id, task.status, task.updated_at, task.completed_at, task.failed_at
     FROM multiremi_turn_execution_records task
     JOIN candidates ON candidates.id = task.id
     WHERE 1 = 1${chatAccess}
     ORDER BY task.updated_at DESC`,
  ).all(workspaceId, workspaceId, ...ACTIVE_TASK_STATUSES, ...identityParams) as Array<{
    id: string;
    status: string;
    updated_at: string;
    completed_at: string | null;
    failed_at: string | null;
  }>;
}

function legacyCliCapabilitiesBody(identity: "human" | "task" | "daemon" | "share", issueCreationRestricted: boolean) {
  return {
    protocol_version: 1,
    manifest_version: String(CLI_CAPABILITIES_RUNTIME.schema_version),
    server_version: multiremiVersion,
    identity,
    features: {
      async_operations: true,
      capability_negotiation: true,
      jsonl_output: true,
      local_cwd_merge: true,
      resource_resolution: ["full_id", "unique_short_id", "unique_name"],
    },
    commands: Object.entries(CLI_CAPABILITIES_RUNTIME.commands)
      .map(([id, command]) => ({
        id,
        command: command.command,
        capability: command.capability,
        outputs: command.output,
        allowed: (command.auth as readonly string[]).includes(identity)
          && !(issueCreationRestricted && (id === "issue.create" || id === "issue.quick-create")),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function pickPublicComparableTask(task: MultiremiTask) {
  // Both legacy hydrateTasksByIds (full columns) and public snapshot (SNAPSHOT_PUBLIC_COLUMNS)
  // populate all public fields; normalize private fields absent in SNAPSHOT_PUBLIC_COLUMNS.
  const copy = { ...task } as Record<string, unknown>;
  delete copy.codexProfile;
  delete copy.codex_profile;
  delete copy.claudeProfile;
  delete copy.claude_profile;
  delete copy.executionConnection;
  delete copy.execution_connection;
  delete copy.delegationId;
  delete copy.delegation_id;
  delete copy.delegatedByAgentId;
  delete copy.delegated_by_agent_id;
  delete copy.delegatedFromIssueSessionId;
  delete copy.delegated_from_issue_session_id;
  delete copy.delegationSkipReason;
  delete copy.delegation_skip_reason;
  delete copy.delegationReturnTaskId;
  delete copy.delegation_return_task_id;
  delete copy.issueCreationRestricted;
  delete copy.issue_creation_restricted;
  delete copy.wakeSource;
  delete copy.wake_source;
  delete copy.wakeSeq;
  delete copy.wake_seq;
  delete copy.executionScope;
  delete copy.execution_scope;
  delete copy.boundIssueLogToSeq;
  delete copy.bound_issue_log_to_seq;
  delete copy.boundIssueLogDeliveredSeq;
  delete copy.bound_issue_log_delivered_seq;
  delete copy.inheritedProjectionFromSeq;
  delete copy.inherited_projection_from_seq;
  return copy;
}

describe("MUL-330: agent-task-snapshot and cli/capabilities equivalence and cost", () => {
  it("matches the legacy 3-scan view snapshot field-for-field across retries, lost, awaiting_human, private chats, and task tokens", async () => {
    const resource = await openHotspotDatabase();
    resources.push(resource);
    const db = resource.db;
    const store = new MultiremiStore(db);
    store.ensureLocalWorkspace();

    const foreignWs = store.createWorkspace({ name: "Foreign WS", slug: "mul330-foreign" });
    const agentRetry = store.createAgent({ name: "Retry Agent", provider: "codex" });
    const agentAwaiting = store.createAgent({ name: "Awaiting Agent", provider: "codex" });
    const agentPrivate = store.createAgent({ name: "Private Chat Agent", provider: "codex" });
    const agentNullEnded = store.createAgent({ name: "Null Ended Agent", provider: "codex" });
    const foreignAgent = store.createAgent({ name: "Foreign Agent", provider: "codex", workspaceId: foreignWs.id });

    const issue = store.createIssue({
      title: "Snapshot equivalence issue",
      workspaceId: "local",
      assigneeType: "agent",
      assigneeId: agentPrivate.id,
    });
    const publicSession = store.createIssueSession(issue.id, {
      title: "Public Main",
      createdByType: "member",
      createdById: "local",
    });
    const privateChat = store.createChatSession({ agentId: agentPrivate.id, creatorId: "local", title: "Private Chat" });
    const privateProjectedSession = store.getOrCreateDefaultChatSession(privateChat.id);

    // 1. Agent with multiple turns + multi-attempt retry + lost + cancelled + active offered/accepted/waiting_local_directory
    const insertTurnAndAttempt = (spec: {
      turnId: string;
      attemptId: string;
      attemptNo: number;
      agentId: string;
      workspaceId?: string;
      turnStatus: string;
      attemptStatus: string;
      currentAttemptId: string | null;
      createdAt: string;
      updatedAt: string;
      endedAt?: string | null;
      chatSessionId?: string | null;
      issueSessionId?: string | null;
      issueId?: string | null;
      createTurn?: boolean;
      replyBody?: string | null;
    }) => {
      const ws = spec.workspaceId ?? "local";
      const sessionId = spec.issueSessionId ?? spec.chatSessionId ?? `auto_${spec.turnId}`;
      let replyMessageId: string | null = null;
      if (spec.replyBody) {
        replyMessageId = `msg_${spec.turnId}`;
        db.run(
          `INSERT INTO multiremi_conversation_log (
             session_id, seq, id, kind, visibility, sender_type, sender_id, task_id,
             body_md, body_html, render_version, message_kind, metadata, created_at, updated_at
           ) VALUES (?, ?, ?, 'message', 'shown', 'agent', ?, ?, ?, ?, 1, 'reply', '{}', ?, ?)`,
          [
            sessionId,
            1000 + Math.floor(Math.random() * 100000),
            replyMessageId,
            spec.agentId,
            spec.turnId,
            spec.replyBody,
            spec.replyBody,
            spec.createdAt,
            spec.updatedAt,
          ],
        );
      }
      if (spec.createTurn !== false) {
        db.run(
          `INSERT INTO multiremi_turns (
             id, session_id, seq, issue_session_id, chat_session_id, issue_id,
             agent_id, status, current_attempt_id, reply_message_id, workspace_id,
             legacy_prompt, created_at, ended_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            spec.turnId,
            sessionId,
            100 + Math.floor(Math.random() * 100000),
            spec.issueSessionId ?? null,
            spec.chatSessionId ?? null,
            spec.issueId ?? null,
            spec.agentId,
            spec.turnStatus,
            spec.currentAttemptId,
            replyMessageId,
            ws,
            `prompt-${spec.turnId}`,
            spec.createdAt,
            spec.endedAt ?? null,
          ],
        );
      }
      db.run(
        `INSERT INTO multiremi_turn_attempts (
           id, turn_id, attempt_no, status, created_at, updated_at, ended_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          spec.attemptId,
          spec.turnId,
          spec.attemptNo,
          spec.attemptStatus,
          spec.createdAt,
          spec.updatedAt,
          spec.endedAt ?? null,
        ],
      );
    };

    // Multi-attempt turn for agentRetry: attempt 1 lost (older), attempt 2 failed (latest outcome), attempt 3 cancelled
    insertTurnAndAttempt({
      turnId: "tsk_retry_t1",
      attemptId: "tsk_retry_t1_a1",
      attemptNo: 1,
      agentId: agentRetry.id,
      turnStatus: "cancelled",
      attemptStatus: "lost",
      currentAttemptId: "tsk_retry_t1_a3",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:05:00.000Z",
      endedAt: "2026-01-01T00:04:00.000Z",
    });
    insertTurnAndAttempt({
      createTurn: false,
      turnId: "tsk_retry_t1",
      attemptId: "tsk_retry_t1_a2",
      attemptNo: 2,
      agentId: agentRetry.id,
      turnStatus: "cancelled",
      attemptStatus: "lost",
      currentAttemptId: "tsk_retry_t1_a3",
      createdAt: "2026-01-01T00:06:00.000Z",
      updatedAt: "2026-01-01T00:09:00.000Z",
      endedAt: "2026-01-01T00:10:00.000Z",
    });
    insertTurnAndAttempt({
      createTurn: false,
      turnId: "tsk_retry_t1",
      attemptId: "tsk_retry_t1_a3",
      attemptNo: 3,
      agentId: agentRetry.id,
      turnStatus: "cancelled",
      attemptStatus: "cancelled",
      currentAttemptId: "tsk_retry_t1_a3",
      createdAt: "2026-01-01T00:11:00.000Z",
      updatedAt: "2026-01-01T00:15:00.000Z",
      endedAt: "2026-01-01T00:15:00.000Z",
    });
    // Active attempts for agentRetry: offered -> queued, accepted -> dispatched, waiting_local_directory
    insertTurnAndAttempt({
      turnId: "tsk_retry_offered",
      attemptId: "tsk_retry_offered",
      attemptNo: 1,
      agentId: agentRetry.id,
      turnStatus: "pending",
      attemptStatus: "offered",
      currentAttemptId: "tsk_retry_offered",
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:01:00.000Z",
    });
    insertTurnAndAttempt({
      turnId: "tsk_retry_accepted",
      attemptId: "tsk_retry_accepted",
      attemptNo: 1,
      agentId: agentRetry.id,
      turnStatus: "running",
      attemptStatus: "accepted",
      currentAttemptId: "tsk_retry_accepted",
      createdAt: "2026-01-02T00:02:00.000Z",
      updatedAt: "2026-01-02T00:03:00.000Z",
    });
    insertTurnAndAttempt({
      turnId: "tsk_retry_waitdir",
      attemptId: "tsk_retry_waitdir",
      attemptNo: 1,
      agentId: agentRetry.id,
      turnStatus: "running",
      attemptStatus: "waiting_local_directory",
      currentAttemptId: "tsk_retry_waitdir",
      createdAt: "2026-01-02T00:04:00.000Z",
      updatedAt: "2026-01-02T00:05:00.000Z",
    });

    // 2. Awaiting-human edge cases for agentAwaiting:
    //    - Attempt 1 failed (NOT current_attempt_id -> MUST be ranked as terminal outcome!)
    //    - Attempt 2 has attempt.status = 'failed' while turn.status = 'awaiting_human' and current_attempt_id = a2
    //      -> MUST project as active 'awaiting_human', MUST NOT enter ranked_outcomes!
    //    - Another turn with turn.status = 'awaiting_human' and current_attempt_id = NULL + attempt.status = 'completed'
    //      (older than attempt 1 -> tests SQL 3-valued logic when current_attempt_id IS NULL)
    insertTurnAndAttempt({
      turnId: "tsk_await_t1",
      attemptId: "tsk_await_t1_a1",
      attemptNo: 1,
      agentId: agentAwaiting.id,
      turnStatus: "awaiting_human",
      attemptStatus: "failed",
      currentAttemptId: "tsk_await_t1_a2",
      createdAt: "2026-01-03T00:00:00.000Z",
      updatedAt: "2026-01-03T00:02:00.000Z",
      endedAt: "2026-01-03T00:02:00.000Z",
    });
    insertTurnAndAttempt({
      createTurn: false,
      turnId: "tsk_await_t1",
      attemptId: "tsk_await_t1_a2",
      attemptNo: 2,
      agentId: agentAwaiting.id,
      turnStatus: "awaiting_human",
      attemptStatus: "failed",
      currentAttemptId: "tsk_await_t1_a2",
      createdAt: "2026-01-03T00:03:00.000Z",
      updatedAt: "2026-01-03T00:10:00.000Z",
      endedAt: "2026-01-03T00:10:00.000Z",
    });
    insertTurnAndAttempt({
      turnId: "tsk_await_null_cur",
      attemptId: "tsk_await_null_cur_a1",
      attemptNo: 1,
      agentId: agentAwaiting.id,
      turnStatus: "awaiting_human",
      attemptStatus: "completed",
      currentAttemptId: null,
      createdAt: "2026-01-03T00:01:00.000Z",
      updatedAt: "2026-01-03T00:01:30.000Z",
      endedAt: "2026-01-03T00:01:30.000Z",
    });

    // 3. Private Chat hiding newest outcome for agentPrivate:
    //    - Older public Issue completed task
    //    - Newer private Chat completed task
    //    - Active projected private Chat Session task with damaged NULL chat_session_id
    insertTurnAndAttempt({
      turnId: "tsk_priv_old_public",
      attemptId: "tsk_priv_old_public",
      attemptNo: 1,
      agentId: agentPrivate.id,
      turnStatus: "completed",
      attemptStatus: "completed",
      currentAttemptId: "tsk_priv_old_public",
      issueId: issue.id,
      issueSessionId: publicSession.id,
      createdAt: "2026-01-04T00:00:00.000Z",
      updatedAt: "2026-01-04T00:01:00.000Z",
      endedAt: "2026-01-04T00:01:00.000Z",
      replyBody: "older public reply",
    });
    insertTurnAndAttempt({
      turnId: "tsk_priv_new_chat",
      attemptId: "tsk_priv_new_chat",
      attemptNo: 1,
      agentId: agentPrivate.id,
      turnStatus: "completed",
      attemptStatus: "completed",
      currentAttemptId: "tsk_priv_new_chat",
      chatSessionId: privateChat.id,
      createdAt: "2026-01-04T00:05:00.000Z",
      updatedAt: "2026-01-04T00:06:00.000Z",
      endedAt: "2026-01-04T00:06:00.000Z",
      replyBody: "newer private chat reply",
    });
    insertTurnAndAttempt({
      turnId: "tsk_priv_damaged_proj",
      attemptId: "tsk_priv_damaged_proj",
      attemptNo: 1,
      agentId: agentPrivate.id,
      turnStatus: "running",
      attemptStatus: "running",
      currentAttemptId: "tsk_priv_damaged_proj",
      issueSessionId: privateProjectedSession.id,
      chatSessionId: null,
      createdAt: "2026-01-04T00:07:00.000Z",
      updatedAt: "2026-01-04T00:08:00.000Z",
    });

    // 4. Null ended_at fallback to updated_at / created_at + autopilot run attachment
    insertTurnAndAttempt({
      turnId: "tsk_null_ended_older",
      attemptId: "tsk_null_ended_older",
      attemptNo: 1,
      agentId: agentNullEnded.id,
      turnStatus: "completed",
      attemptStatus: "completed",
      currentAttemptId: "tsk_null_ended_older",
      createdAt: "2026-01-05T00:00:00.000Z",
      updatedAt: "2026-01-05T00:02:00.000Z",
      endedAt: null,
    });
    insertTurnAndAttempt({
      turnId: "tsk_null_ended_newer",
      attemptId: "tsk_null_ended_newer",
      attemptNo: 1,
      agentId: agentNullEnded.id,
      turnStatus: "failed",
      attemptStatus: "lost",
      currentAttemptId: "tsk_null_ended_newer",
      createdAt: "2026-01-05T00:01:00.000Z",
      updatedAt: "2026-01-05T00:04:00.000Z",
      endedAt: null,
    });
    db.run(
      `INSERT INTO multiremi_autopilot_runs (id, autopilot_id, source, turn_id, triggered_at, created_at)
       VALUES (?, ?, 'api', ?, ?, ?)`,
      ["apr_mul330_1", "apl_mul330", "tsk_null_ended_newer", "2026-01-05T00:01:00.000Z", "2026-01-05T00:01:00.000Z"],
    );

    // 5. Foreign workspace task must never leak into local
    insertTurnAndAttempt({
      turnId: "tsk_foreign_active",
      attemptId: "tsk_foreign_active",
      attemptNo: 1,
      agentId: foreignAgent.id,
      workspaceId: foreignWs.id,
      turnStatus: "running",
      attemptStatus: "running",
      currentAttemptId: "tsk_foreign_active",
      createdAt: "2026-01-06T00:00:00.000Z",
      updatedAt: "2026-01-06T00:01:00.000Z",
    });

    const accessCases: Array<{ label: string; workspaceId: string; access?: TaskSnapshotAccess }> = [
      { label: "unrestricted local", workspaceId: "local" },
      { label: "human local", workspaceId: "local", access: { userId: "local" } },
      {
        label: "own private chat task token",
        workspaceId: "local",
        access: { userId: null, taskToken: { taskId: "tsk_priv_new_chat", agentId: agentPrivate.id, workspaceId: "local" } },
      },
      {
        label: "other task token (private newest outcome hidden, older public NOT promoted)",
        workspaceId: "local",
        access: { userId: null, taskToken: { taskId: "tsk_priv_old_public", agentId: agentPrivate.id, workspaceId: "local" } },
      },
      {
        label: "wrong agent task token",
        workspaceId: "local",
        access: { userId: null, taskToken: { taskId: "tsk_priv_new_chat", agentId: agentRetry.id, workspaceId: "local" } },
      },
      {
        label: "wrong workspace task token",
        workspaceId: "local",
        access: { userId: null, taskToken: { taskId: "tsk_priv_new_chat", agentId: agentPrivate.id, workspaceId: foreignWs.id } },
      },
      { label: "foreign workspace", workspaceId: foreignWs.id },
    ];

    for (const testCase of accessCases) {
      const actual = store.listWorkspaceAgentTaskSnapshot(testCase.workspaceId, testCase.access);
      const legacyRows = legacySnapshotIdsAndOrder(db, testCase.workspaceId, testCase.access);
      const legacyHydrated = store.hydrateTasksByIds(legacyRows.map((row) => row.id));

      expect(actual.map((task) => task.id), testCase.label).toEqual(legacyRows.map((row) => row.id));
      if (!testCase.access) {
        expect(actual, testCase.label).toEqual(legacyHydrated);
      } else {
        expect(actual.map(pickPublicComparableTask), testCase.label).toEqual(
          legacyHydrated.map(pickPublicComparableTask),
        );
      }
    }

    // Explicit semantic spot checks on key edge cases:
    const fullLocal = store.listWorkspaceAgentTaskSnapshot("local");
    const byId = new Map(fullLocal.map((task) => [task.id, task]));
    expect(byId.get("tsk_retry_t1_a2")?.status).toBe("failed");
    expect(byId.has("tsk_retry_t1_a1")).toBe(false);
    expect(byId.has("tsk_retry_t1_a3")).toBe(false);
    expect(byId.get("tsk_retry_offered")?.status).toBe("queued");
    expect(byId.get("tsk_retry_accepted")?.status).toBe("dispatched");
    expect(byId.get("tsk_retry_waitdir")?.status).toBe("waiting_local_directory");
    expect(byId.get("tsk_await_t1_a2")?.status).toBe("awaiting_human");
    expect(byId.get("tsk_await_t1_a1")?.status).toBe("failed");
    expect(byId.has("tsk_await_null_cur_a1")).toBe(false);
    expect(byId.get("tsk_null_ended_newer")?.autopilotRunId).toBe("apr_mul330_1");
    expect(byId.has("tsk_foreign_active")).toBe(false);

    // Confirm invisible private Chat newest outcome does NOT promote older public outcome:
    const otherTaskSnapshot = store.listWorkspaceAgentTaskSnapshot("local", {
      userId: null,
      taskToken: { taskId: "tsk_priv_old_public", agentId: agentPrivate.id, workspaceId: "local" },
    });
    expect(otherTaskSnapshot.some((task) => task.id === "tsk_priv_new_chat")).toBe(false);
    expect(otherTaskSnapshot.some((task) => task.id === "tsk_priv_old_public")).toBe(false);
    expect(otherTaskSnapshot.some((task) => task.id === "tsk_priv_damaged_proj")).toBe(false);
  }, 60_000);

  it("preserves exact /api/cli/capabilities responses and restriction semantics across all identities and restriction sources", async () => {
    const resource = await openHotspotDatabase();
    resources.push(resource);
    const db = resource.db;
    const store = new MultiremiStore(db);
    store.ensureLocalWorkspace();

    const secondaryWs = store.createWorkspace({ name: "Secondary WS", slug: "mul330-secondary" }, "local");
    const runtime = store.registerRuntime({
      id: "rt_mul330_caps",
      name: "Caps RT",
      provider: "codex",
      daemonId: "daemon_mul330_caps",
      workspaceId: "local",
    });
    store.heartbeatRuntime(runtime.id, { supportsFeishuBotConfig: true });

    const normalAgent = store.createAgent({ name: "Normal Agent", provider: "codex" });
    const restrictedAgent = store.createAgent({
      name: "Restricted Agent",
      provider: "codex",
      issueCreationRequiresProposal: true,
    });
    const issue = store.createIssue({
      title: "Caps issue",
      workspaceId: "local",
      assigneeType: "agent",
      assigneeId: normalAgent.id,
    });
    const sessionNormal = store.createIssueSession(issue.id, {
      title: "Normal",
      createdByType: "member",
      createdById: "local",
    });
    const sessionTaskFlag = store.createIssueSession(issue.id, {
      title: "Task Flag",
      createdByType: "member",
      createdById: "local",
    });
    const normalTask = store.createTask({
      agentId: normalAgent.id,
      issueId: issue.id,
      issueSessionId: sessionNormal.id,
      prompt: "normal",
    });
    const taskFlagRestricted = store.createTask({
      agentId: normalAgent.id,
      issueId: issue.id,
      issueSessionId: sessionTaskFlag.id,
      prompt: "task flag restricted",
      issueCreationRestricted: true,
    });
    const agentFlagRestricted = store.createTask({
      agentId: restrictedAgent.id,
      issueId: issue.id,
      issueSessionId: sessionNormal.id,
      prompt: "agent flag restricted",
    });

    // Feishu sender allowlist restricted task + delegated child task
    const botConfig = store.upsertFeishuBotConfig("local", {
      agentId: normalAgent.id,
      runtimeId: runtime.id,
      appId: "cli_mul330_caps",
      appSecretOp: "set",
      appSecret: "wJ4tQ7xR2nB8vC5mZ1kL0pS6dF3gH9jA",
      domain: "feishu",
      enabled: true,
      senderAccessPolicy: "agent",
    });
    const feishuInbound = store.submitFeishuBotMessage("local", runtime.id, {
      revision: botConfig.revision,
      externalSessionKey: "oc_mul330",
      externalMessageId: "om_mul330_1",
      senderOpenId: "ou_mul330_sender",
      senderName: "Feishu User",
      text: "Check caps",
      chatType: "p2p",
    });
    const delegatedChild = store.createTask({
      agentId: normalAgent.id,
      issueId: issue.id,
      issueSessionId: store.createIssueSession(issue.id, {
        title: "Delegated",
        createdByType: "member",
        createdById: "local",
      }).id,
      prompt: "delegated from feishu",
    });
    // Record delegation link via conversation log metadata delivery_turn_id (exact lineage mechanism)
    const parentTurnId = String(
      (db.query("SELECT turn_id FROM multiremi_turn_attempts WHERE id = ?").get(feishuInbound.taskId) as { turn_id: string }).turn_id,
    );
    const childTurnId = String(
      (db.query("SELECT turn_id FROM multiremi_turn_attempts WHERE id = ?").get(delegatedChild.id) as { turn_id: string }).turn_id,
    );
    db.run(
      `INSERT INTO multiremi_conversation_log (
         session_id, seq, id, kind, visibility, sender_type, sender_id, task_id,
         body_md, body_html, render_version, message_kind, metadata, created_at, updated_at
       ) VALUES (?, 999, ?, 'message', 'shown', 'agent', ?, ?, 'delegate', 'delegate', 1, 'request', ?, ?, ?)`,
      [
        feishuInbound.chatSessionId,
        "msg_mul330_delegation",
        normalAgent.id,
        parentTurnId,
        JSON.stringify({ delivery_turn_id: childTurnId }),
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );
    store.upsertFeishuBotConfig("local", {
      agentId: normalAgent.id,
      runtimeId: runtime.id,
      appId: "cli_mul330_caps",
      appSecretOp: "keep",
      domain: "feishu",
      enabled: true,
      senderAccessPolicy: "allowlist",
    });

    // Direct store code precedence check (and parity with isFeishuBotTaskIssueCreationRestricted):
    expect(store.isFeishuBotTaskIssueCreationRestricted(delegatedChild.id)).toBe(true);
    expect(store.getTaskIssueCreationRestrictionCode(normalTask.id, normalAgent.id)).toBeNull();
    expect(store.getTaskIssueCreationRestrictionCode(taskFlagRestricted.id, normalAgent.id)).toBe("issue_creation_requires_proposal");
    expect(store.getTaskIssueCreationRestrictionCode(agentFlagRestricted.id, restrictedAgent.id)).toBe("issue_creation_requires_proposal");
    expect(store.getTaskIssueCreationRestrictionCode(null, restrictedAgent.id)).toBe("issue_creation_requires_proposal");
    expect(store.getTaskIssueCreationRestrictionCode(null, normalAgent.id)).toBeNull();
    expect(store.getTaskIssueCreationRestrictionCode(feishuInbound.taskId, normalAgent.id)).toBe("feishu_sender_approval_required");
    expect(store.getTaskIssueCreationRestrictionCode(delegatedChild.id, normalAgent.id)).toBe("feishu_sender_approval_required");
    // Precedence: agent proposal flag overrides Feishu approval code (same as legacy order)
    expect(store.getTaskIssueCreationRestrictionCode(feishuInbound.taskId, restrictedAgent.id)).toBe("issue_creation_requires_proposal");

    const shareSecret = "mul330-share-secret";
    const shareRecord = store.ensureIssueShare(issue.id, "local", "local", 60);
    const shareToken = signIssueShareId(shareRecord.id, shareSecret);
    const humanToken = (await store.createAccessToken({
      name: "human", type: "pat", purpose: "cli", workspaceId: "local", userId: "local",
    })).token;
    const secondaryHumanToken = (await store.createAccessToken({
      name: "human-secondary", type: "pat", purpose: "cli", workspaceId: secondaryWs.id, userId: "local",
    })).token;
    const daemonToken = (await store.createAccessToken({
      name: "daemon", type: "daemon", purpose: "daemon", workspaceId: "local", userId: "local", daemonId: "daemon_mul330_caps",
    })).token;
    const makeTaskToken = async (taskId: string, agentId: string, name: string) => (await store.createAccessToken({
      name, type: "task", purpose: "task", workspaceId: "local", userId: "local", taskId, agentId,
    })).token;

    const app = createMultiremiApp({ store, authToken: "mul330-root", shareSecret });

    const cases: Array<{
      label: string;
      headers: Record<string, string>;
      identity: "human" | "task" | "daemon" | "share";
      restricted: boolean;
    }> = [
      { label: "human", headers: { Authorization: `Bearer ${humanToken}` }, identity: "human", restricted: false },
      { label: "daemon", headers: { Authorization: `Bearer ${daemonToken}` }, identity: "daemon", restricted: false },
      { label: "share", headers: { "X-Remi-Share": shareToken }, identity: "share", restricted: false },
      {
        label: "task unrestricted",
        headers: { Authorization: `Bearer ${await makeTaskToken(normalTask.id, normalAgent.id, "t-normal")}` },
        identity: "task",
        restricted: false,
      },
      {
        label: "task flag restricted",
        headers: { Authorization: `Bearer ${await makeTaskToken(taskFlagRestricted.id, normalAgent.id, "t-flag")}` },
        identity: "task",
        restricted: true,
      },
      {
        label: "agent flag restricted",
        headers: { Authorization: `Bearer ${await makeTaskToken(agentFlagRestricted.id, restrictedAgent.id, "t-agent")}` },
        identity: "task",
        restricted: true,
      },
      {
        label: "feishu allowlist restricted",
        headers: { Authorization: `Bearer ${await makeTaskToken(feishuInbound.taskId, normalAgent.id, "t-feishu")}` },
        identity: "task",
        restricted: true,
      },
      {
        label: "feishu delegated child restricted",
        headers: { Authorization: `Bearer ${await makeTaskToken(delegatedChild.id, normalAgent.id, "t-child")}` },
        identity: "task",
        restricted: true,
      },
    ];

    for (const item of cases) {
      const response = await app.request("/api/cli/capabilities", { headers: item.headers });
      expect(response.status, item.label).toBe(200);
      expect(response.headers.get("content-type"), item.label).toBe("application/json");
      const body = await response.json();
      expect(body, item.label).toEqual(legacyCliCapabilitiesBody(item.identity, item.restricted));
    }

    // Approving the Feishu sender clears the restriction immediately (no stale caching)
    const [sender] = store.listFeishuBotSenders("local");
    store.setFeishuBotSenderAllowed("local", sender!.id, true, "local");
    const feishuChildToken = await makeTaskToken(delegatedChild.id, normalAgent.id, "t-child-after");
    const afterApprove = await app.request("/api/cli/capabilities", {
      headers: { Authorization: `Bearer ${feishuChildToken}` },
    });
    expect(afterApprove.status).toBe(200);
    expect(await afterApprove.json()).toEqual(legacyCliCapabilitiesBody("task", false));

    // Secondary workspace exists vs missing workspace 404
    const secondaryOk = await app.request(`/api/cli/capabilities?workspace_id=${secondaryWs.id}`, {
      headers: { Authorization: `Bearer ${secondaryHumanToken}` },
    });
    expect(secondaryOk.status).toBe(200);
    const missingWs = await app.request("/api/cli/capabilities?workspace_id=ws_does_not_exist", {
      headers: { Authorization: `Bearer ${humanToken}` },
    });
    expect(missingWs.status).toBe(404);
  }, 60_000);

  it("enforces bounded SQL query counts, single view join, and latency budgets for both hot endpoints", async () => {
    const resource = await openHotspotDatabase();
    resources.push(resource);
    const { db, statements } = instrumentDb(resource.db);
    const store = new MultiremiStore(db);
    store.ensureLocalWorkspace();

    const secondaryWs = store.createWorkspace({ name: "Budget Secondary", slug: "mul330-budget-sec" }, "local");
    const agents = Array.from({ length: 12 }, (_, index) => store.createAgent({
      name: `Budget Agent ${index}`,
      provider: "codex",
      instructions: "I".repeat(8_192),
    }));
    const restrictedAgent = store.createAgent({
      name: "Budget Restricted Agent",
      provider: "codex",
      issueCreationRequiresProposal: true,
      instructions: "R".repeat(8_192),
    });

    // Seed 300 historical turns + retries + 8 active turns on raw db so seeding stays fast on both SQLite and PG.
    const largePrompt = "P".repeat(2_048);
    resource.db.transaction(() => {
      for (let i = 0; i < 300; i += 1) {
        const agent = agents[i % agents.length]!;
        const turnId = `tsk_b_hist_${i}`;
        const ts = new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
        const aStatus = i % 10 === 0 ? "cancelled" : i % 7 === 0 ? "lost" : i % 3 === 0 ? "failed" : "completed";
        const tStatus = aStatus === "lost" ? "failed" : aStatus;
        resource.db.run(
          `INSERT INTO multiremi_turns (
             id, session_id, seq, agent_id, status, current_attempt_id, workspace_id, legacy_prompt, created_at, ended_at
           ) VALUES (?, ?, 1, ?, ?, ?, 'local', ?, ?, ?)`,
          [turnId, `auto_b_${i}`, agent.id, tStatus, turnId, largePrompt, ts, ts],
        );
        resource.db.run(
          `INSERT INTO multiremi_turn_attempts (id, turn_id, attempt_no, status, created_at, updated_at, ended_at)
           VALUES (?, ?, 1, ?, ?, ?, ?)`,
          [turnId, turnId, aStatus, ts, ts, ts],
        );
        if (i % 5 === 0) {
          const retryId = `tsk_b_hist_${i}_r2`;
          const ts2 = new Date(Date.UTC(2026, 0, 1) + i * 60_000 + 30_000).toISOString();
          resource.db.run(
            `INSERT INTO multiremi_turn_attempts (id, turn_id, attempt_no, status, created_at, updated_at, ended_at)
             VALUES (?, ?, 2, 'completed', ?, ?, ?)`,
            [retryId, turnId, ts2, ts2, ts2],
          );
          resource.db.run(
            `UPDATE multiremi_turns SET current_attempt_id = ?, status = 'completed' WHERE id = ?`,
            [retryId, turnId],
          );
        }
      }
      const activeSpecs: Array<[string, string]> = [
        ["offered", "pending"], ["accepted", "running"], ["running", "running"],
        ["waiting_local_directory", "running"], ["running", "awaiting_human"],
        ["failed", "awaiting_human"], ["offered", "pending"], ["running", "running"],
      ];
      activeSpecs.forEach(([aStatus, tStatus], idx) => {
        const agent = agents[idx % agents.length]!;
        const turnId = `tsk_b_act_${idx}`;
        const ts = new Date(Date.UTC(2026, 6, 1) + idx * 60_000).toISOString();
        resource.db.run(
          `INSERT INTO multiremi_turns (
             id, session_id, seq, agent_id, status, current_attempt_id, workspace_id, legacy_prompt, created_at
           ) VALUES (?, ?, 1, ?, ?, ?, 'local', ?, ?)`,
          [turnId, `auto_b_act_${idx}`, agent.id, tStatus, turnId, largePrompt, ts],
        );
        resource.db.run(
          `INSERT INTO multiremi_turn_attempts (id, turn_id, attempt_no, status, created_at, updated_at)
           VALUES (?, ?, 1, ?, ?, ?)`,
          [turnId, turnId, aStatus, ts, ts],
        );
      });
    })();

    const runtime = store.registerRuntime({
      id: "rt_mul330_budget",
      name: "Budget RT",
      provider: "codex",
      daemonId: "daemon_mul330_budget",
      workspaceId: "local",
    });
    store.heartbeatRuntime(runtime.id, { supportsFeishuBotConfig: true });
    const issue = store.createIssue({
      title: "Budget issue",
      workspaceId: "local",
      assigneeType: "agent",
      assigneeId: agents[0]!.id,
    });
    const session1 = store.createIssueSession(issue.id, { title: "Main", createdByType: "member", createdById: "local" });
    const session2 = store.createIssueSession(issue.id, { title: "Restricted", createdByType: "member", createdById: "local" });
    const unrestrictedTask = store.createTask({
      agentId: agents[0]!.id, issueId: issue.id, issueSessionId: session1.id, prompt: largePrompt,
    });
    const taskRestricted = store.createTask({
      agentId: agents[0]!.id, issueId: issue.id, issueSessionId: session2.id, prompt: largePrompt, issueCreationRestricted: true,
    });
    const agentRestricted = store.createTask({
      agentId: restrictedAgent.id, issueId: issue.id, issueSessionId: session1.id, prompt: largePrompt,
    });
    const botConfig = store.upsertFeishuBotConfig("local", {
      agentId: agents[0]!.id, runtimeId: runtime.id, appId: "cli_mul330_budget",
      appSecretOp: "set", appSecret: "wJ4tQ7xR2nB8vC5mZ1kL0pS6dF3gH9jA",
      domain: "feishu", enabled: true, senderAccessPolicy: "agent",
    });
    const feishuInbound = store.submitFeishuBotMessage("local", runtime.id, {
      revision: botConfig.revision, externalSessionKey: "oc_mul330_budget", externalMessageId: "om_mul330_budget",
      senderOpenId: "ou_mul330_budget", senderName: "Budget Sender", text: "Hello", chatType: "p2p",
    });
    store.upsertFeishuBotConfig("local", {
      agentId: agents[0]!.id, runtimeId: runtime.id, appId: "cli_mul330_budget",
      appSecretOp: "keep", domain: "feishu", enabled: true, senderAccessPolicy: "allowlist",
    });

    const shareSecret = "mul330-budget-share";
    const shareToken = signIssueShareId(store.ensureIssueShare(issue.id, "local", "local", 60).id, shareSecret);
    const humanToken = (await store.createAccessToken({
      name: "human", type: "pat", purpose: "cli", workspaceId: "local", userId: "local",
    })).token;
    const secondaryHumanToken = (await store.createAccessToken({
      name: "human-secondary", type: "pat", purpose: "cli", workspaceId: secondaryWs.id, userId: "local",
    })).token;
    const daemonToken = (await store.createAccessToken({
      name: "daemon", type: "daemon", purpose: "daemon", workspaceId: "local", userId: "local", daemonId: "daemon_mul330_budget",
    })).token;
    const unrestrictedTaskToken = (await store.createAccessToken({
      name: "t1", type: "task", purpose: "task", workspaceId: "local", userId: "local", taskId: unrestrictedTask.id, agentId: agents[0]!.id,
    })).token;
    const taskRestrictedToken = (await store.createAccessToken({
      name: "t2", type: "task", purpose: "task", workspaceId: "local", userId: "local", taskId: taskRestricted.id, agentId: agents[0]!.id,
    })).token;
    const agentRestrictedToken = (await store.createAccessToken({
      name: "t3", type: "task", purpose: "task", workspaceId: "local", userId: "local", taskId: agentRestricted.id, agentId: restrictedAgent.id,
    })).token;
    const feishuRestrictedToken = (await store.createAccessToken({
      name: "t4", type: "task", purpose: "task", workspaceId: "local", userId: "local", taskId: feishuInbound.taskId, agentId: agents[0]!.id,
    })).token;

    const app = createMultiremiApp({ store, authToken: "mul330-budget-root", shareSecret });

    // 1. Agent task snapshot budgets (human & task); warm once so token last_used_at update is excluded deterministically.
    for (const [label, headers, maxStatements] of [
      ["snapshot human", { Authorization: `Bearer ${humanToken}` }, 5],
      ["snapshot task", { Authorization: `Bearer ${unrestrictedTaskToken}` }, 6],
    ] as const) {
      await app.request("/api/agent-task-snapshot?workspace_id=local", { headers });
      statements.length = 0;
      const started = performance.now();
      const response = await app.request("/api/agent-task-snapshot?workspace_id=local", { headers });
      const body = await response.json();
      const elapsedMs = performance.now() - started;
      console.info(JSON.stringify({ label, statements: statements.length, elapsed_ms: +elapsedMs.toFixed(3), rows: body.length }));

      expect(response.status, label).toBe(200);
      expect(body.length, label).toBeGreaterThanOrEqual(20);
      expect(statements.length, label).toBeLessThanOrEqual(maxStatements);
      expect(elapsedMs, label).toBeLessThan(2_000);

      const snapshotSql = statements.find((sql) => sql.includes("ranked_outcomes"));
      expect(snapshotSql, label).toBeDefined();
      // View must be referenced only once (for final PK join on materialized candidates), never 3 times.
      const viewMatches = snapshotSql!.match(/multiremi_turn_execution_records/g) ?? [];
      expect(viewMatches.length, label).toBe(1);
    }

    // 2. CLI capabilities budgets across all identities and restriction modes
    for (const [label, path, headers, maxStatements] of [
      ["caps human local", "/api/cli/capabilities", { Authorization: `Bearer ${humanToken}` }, 2],
      ["caps human secondary", `/api/cli/capabilities?workspace_id=${secondaryWs.id}`, { Authorization: `Bearer ${secondaryHumanToken}` }, 3],
      ["caps daemon", "/api/cli/capabilities", { Authorization: `Bearer ${daemonToken}` }, 1],
      ["caps share", "/api/cli/capabilities", { "X-Remi-Share": shareToken }, 1],
      ["caps task unrestricted", "/api/cli/capabilities", { Authorization: `Bearer ${unrestrictedTaskToken}` }, 4],
      ["caps task flag restricted", "/api/cli/capabilities", { Authorization: `Bearer ${taskRestrictedToken}` }, 4],
      ["caps agent flag restricted", "/api/cli/capabilities", { Authorization: `Bearer ${agentRestrictedToken}` }, 4],
      ["caps feishu restricted", "/api/cli/capabilities", { Authorization: `Bearer ${feishuRestrictedToken}` }, 4],
    ] as const) {
      await app.request(path, { headers });
      statements.length = 0;
      const started = performance.now();
      const response = await app.request(path, { headers });
      const body = await response.json();
      const elapsedMs = performance.now() - started;
      console.info(JSON.stringify({ label, statements: statements.length, elapsed_ms: +elapsedMs.toFixed(3), commands: body.commands.length }));

      expect(response.status, label).toBe(200);
      expect(statements.length, label).toBeLessThanOrEqual(maxStatements);
      expect(elapsedMs, label).toBeLessThan(2_000);
      // No full task/agent/skills/autopilot/workspace entity hydration on /api/cli/capabilities.
      for (const sql of statements) {
        expect(sql, `${label}: no view read`).not.toContain("multiremi_turn_execution_records");
        expect(sql, `${label}: no full agent read`).not.toMatch(/SELECT \* FROM multiremi_agents/i);
        expect(sql, `${label}: no skills hydration`).not.toContain("multiremi_skills");
        expect(sql, `${label}: no autopilot hydration`).not.toContain("multiremi_autopilot_run_records");
        expect(sql, `${label}: no full workspace read`).not.toMatch(/SELECT \* FROM multiremi_workspaces/i);
      }
    }
  }, 60_000);
});
