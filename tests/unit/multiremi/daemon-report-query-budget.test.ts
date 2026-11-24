import { withSynchronousRequestReadCache } from "@multiremi/store/request-read-cache.js";
import { createMultiremiApp } from "@multiremi/api.js";
import { expect, test } from "bun:test";
import { MultiremiStore } from "@multiremi/store.js";
import { countSql, fleet, loadedFleet, useReportFleetFixtures } from "../../fixtures/multiremi/daemon-report-fleet.js";

useReportFleetFixtures();

const observedCosts = new Map<string, number>();
function expectConstantCost(path: string, size: number, count: number) {
  if (size === 2) observedCosts.set(path, count);
  else if (observedCosts.has(path)) expect(count).toBe(observedCosts.get(path)!);
}

for (const size of [2, 40]) {
  for (const type of [
    "task.workspace",
    "turn.complete",
    "task.fail",
    "task.usage",
  ])
    test(`${type} budget with ${size} context messages`, async () => {
      const f = await loadedFleet(size);
      const turn = f.store.getTurnForAttempt(f.task.id)!;
      // Make every context body readable inline by this Agent. Completion must
      // examine the whole interval, rather than exit at its first folded body.
      if (type === "turn.complete") f.database.run(
        "UPDATE multiremi_conversation_log SET sender_type='agent',sender_id=? WHERE session_id=? AND message_kind='status'",
        [f.agent.id, f.issueSession.id],
      );
      const input = f.store
        .getDaemonTurnBridge()
        .offerInput(f.store.getTaskWithAgent(f.task.id)!);
      const completion = {
        trace: {
          head: 0,
          event_count: 0,
          tool_call_count: 0,
          type_histogram: [],
          closed: true,
        },
        final_reply_md: "finished",
        model: { provider: "claude", model: "fixture" },
      };
      const payload =
        type === "task.workspace"
          ? {
              task_id: f.task.id,
              runtime_id: f.runtimeIds[0],
              root_path: "/fixture",
              branch_name: `agent/${f.issue.key}`,
              status: "ready",
              repos: [],
            }
          : type === "turn.complete"
            ? {
                ...completion,
                turn_id: turn.id,
                attempt_id: f.task.id,
                input_to_seq: input.input_to_seq,
                reply: { body_md: "finished", message_kind: "final" },
              }
            : type === "task.fail"
              ? { ...completion, task_id: f.task.id, error: "fixture failure" }
              : {
                  task_id: f.task.id,
                  usageSnapshot: {
                    version: 2,
                    runId: "budget-run",
                    revision: 1,
                    complete: false,
                    units: Array.from({ length: size }, (_, index) => (
                      {
                        unitId: `request-${index}`,
                        revision: 1,
                        provider: "claude",
                        model: "fixture",
                        modelSource: "provider_reported",
                        scope: "request",
                        source: "provider_request",
                        accuracy: "exact",
                        inputTokens: 10,
                        outputTokens: 2,
                        cacheReadTokens: 0,
                        cacheWriteTokens: 0,
                        actualUnsplitTokens: 0,
                        reportedTotalTokens: 12,
                        contextTokens: null,
                        contextWindow: null,
                        costAmount: null,
                        costCurrency: null,
                        occurredAt: "2026-11-17T00:00:00Z",
                      })),
                  },
                };
      const sql = await countSql(f.database, f.layer, () =>
        f.sessions[0]!.handleMessage(
          JSON.stringify({
            v: 2,
            t: type,
            rt: f.runtimeIds[0],
            seq: 1,
            p: payload,
          }),
        ),
      );
      expect(
        f.frames[0]!.find((frame) => frame.t === "res" && frame.re === "1")?.p
          .ok,
      ).toBe(true);
      if (type === "task.workspace")
        expect(f.store.getIssueWorkspace(f.issue.id)?.rootPath).toBe(
          "/fixture",
        );
      if (type === "turn.complete") {
        expect(f.store.getTask(f.task.id)?.status).toBe("completed");
        expect(
          f.store.getMessage(f.store.getTurn(turn.id)!.reply_message_id!)
            ?.body_md,
        ).toBe("finished");
      }
      if (type === "task.fail")
        expect(f.store.getTask(f.task.id)?.status).toBe("failed");
      if (type === "task.usage")
        expect(f.store.getTask(f.task.id)?.usage[0]?.totalTokens).toBe(12 * size);
      console.info("REPORT_COST", type, size, sql.length,
        { reads: sql.filter(statement => /^\s*(SELECT|WITH)\b/i.test(statement)).length,
          writes: sql.filter(statement => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(statement)).length });
      expectConstantCost(type, size, sql.length);
      const budgets = {
        "task.workspace": 48,
        // MUL-31: fixed-cost execution fence + restart downlink reads. The
        // 2/40 comparison above still rejects history-dependent query growth.
        "turn.complete": 214,
        "task.fail": 137,
        "task.usage": 40,
      };
      expect(sql.length).toBeLessThanOrEqual(
        budgets[type as keyof typeof budgets],
      );
      expect(
        sql.filter((statement) =>
          /SELECT \* FROM multiremi_conversation_log WHERE id=\? AND kind='message'/.test(
            statement,
          ),
        ).length,
      ).toBeLessThanOrEqual(8);
    }, 60_000);
  for (const range of [false, true])
    test(`session messages ${range ? "range" : "page"} budget with ${size} context messages`, async () => {
      const f = await loadedFleet(size);
      const turn = f.store.getTurnForAttempt(f.task.id)!;
      for (let i = 0; i < size; i++) {
        const root = f.store.sendMessage({
          session_id: f.issueSession.id,
          sender: { type: "platform", id: null },
          to: { type: "none" },
          body_md: "question",
          message_kind: "status",
          wake_requested: "inbox_only",
        }).message;
        f.store.sendMessage({
          session_id: f.issueSession.id,
          sender: { type: "platform", id: null },
          to: { type: "none" },
          body_md: "answer",
          message_kind: "status",
          wake_requested: "inbox_only",
          reply_to_id: root.id,
          source_turn_id: turn.id,
          metadata: { human_response: true },
        });
      }
      await f.layer.drain();
      const app = createMultiremiApp({
        store: f.store,
        authToken: "fixture-cost",
      });
      const sql = await countSql(f.database, f.layer, async () => {
        const response = await app.request(
          `/api/sessions/${f.issueSession.id}/messages?${range ? "from=0&to=999999" : "limit=100"}`,
          { headers: { Authorization: "Bearer fixture-cost" } },
        );
        expect(response.status).toBe(200);
        const page = (await response.json()) as any;
        expect(
          (range ? page.entries : page.messages).length,
        ).toBeGreaterThanOrEqual(size);
      });
      console.info("MESSAGES_COST", range ? "range" : "page", size, sql.length);
      expect(sql.length).toBeLessThan(50);
    }, 60_000);
}

for (const size of [2, 40])
  test(`feishu.outbound_result budget with ${size} context messages`, async () => {
    const f = await loadedFleet(size);
    const inbound = f.store.submitFeishuBotMessage("local", f.runtimeIds[0]!, {
      revision: f.config.revision,
      externalSessionKey: "oc_cost",
      externalMessageId: "om_cost",
      chatId: "oc_cost",
      text: "hello",
      senderOpenId: "ou_cost",
      deliveryMode: "native_cot_v1",
    });
    await f.layer.drain();
    const outbound = f.frames[0]!.find(
      (x) => x.t === "feishu.outbound" && x.p.task_id === inbound.taskId,
    )!.p;
    // Historical outbounds share a binding but have no active transport lease.
    // Seed their persisted rows directly so fixture setup does not send external messages.
    for (let i = 0; i < size; i++)
      f.database.run(
        `INSERT INTO multiremi_feishu_bot_outbound_deliveries
    (id,workspace_id,binding_id,chat_id,body,status,available_at,created_at,updated_at)
    SELECT ?,workspace_id,binding_id,chat_id,'history','sent',available_at,created_at,updated_at
    FROM multiremi_feishu_bot_outbound_deliveries WHERE id=?`,
        [`history-${i}`, outbound.id],
      );
    f.store.claimAcknowledgedFeishuBotOutbound(
      "local",
      f.runtimeIds[0]!,
      outbound.id,
      outbound.claim_token,
    );
    await f.layer.drain();
    const sql = await countSql(f.database, f.layer, () =>
      f.sessions[0]!.handleMessage(
        JSON.stringify({
          v: 2,
          t: "feishu.outbound_result",
          seq: 1,
          rt: f.runtimeIds[0],
          p: {
            request_id: outbound.id,
            claim_token: outbound.claim_token,
            status: "sent",
            external_message_id: "om_sent_cost",
          },
        }),
      ),
    );
    expect(f.frames[0]!.find((x) => x.t === "res" && x.re === "1")?.p.ok).toBe(
      true,
    );
    expect(
      f.database
        .query(
          "SELECT status,external_message_id FROM multiremi_feishu_bot_outbound_deliveries WHERE id=?",
        )
        .get(outbound.id),
    ).toMatchObject({ status: "sent", external_message_id: "om_sent_cost" });
    console.info("OUTBOUND_COST", size, sql.length);
    expect(sql.length).toBeLessThanOrEqual(64);
  }, 60_000);

test("task hydration aggregates usage once for the entire task batch", async () => {
  const f = await loadedFleet(2);
  const tasks = Array.from({ length: 20 }, (_, index) =>
    f.store.createTask({ agentId: f.agent.id, prompt: `batch ${index}` }),
  );
  await f.layer.drain();
  const expected = tasks.map((task) => f.store.getTask(task.id)!);
  let actual: ReturnType<MultiremiStore["hydrateTasksByIds"]> = [];
  const sql = await countSql(f.database, f.layer, () => {
    actual = f.store.hydrateTasksByIds(tasks.map((task) => task.id));
  });
  expect(actual).toEqual(expected);
  expect(
    sql.filter((statement) => /FROM multiremi_usage_units u/.test(statement)),
  ).toHaveLength(1);
});

test("batched Runtime identities retain drain fences and invalidate them after writes", async () => {
  const f = await fleet();
  const expected = f.runtimeIds
    .map((id) => f.store.getRuntimeLite(id)!)
    .sort((a, b) => a!.id.localeCompare(b!.id));
  const sql = await countSql(f.database, f.layer, () => {
    const actual = f.store
      .getRuntimesLite([...f.runtimeIds, f.runtimeIds[0]!])
      .sort((a, b) => a.id.localeCompare(b.id));
    expect(actual).toEqual(expected);
  });
  expect(sql.length).toBe(1);
  withSynchronousRequestReadCache(() => {
    f.store.getRuntimesLite(f.runtimeIds);
    f.store.beginDaemonDrain("local", "dm_cost_0");
    expect(f.store.hasCliUpdateDrainForRuntime(f.runtimeIds[0]!)).toBe(true);
    expect(f.store.hasCliUpdateDrainForRuntime(f.runtimeIds[1]!)).toBe(true);
    expect(f.store.hasCliUpdateDrainForRuntime(f.runtimeIds[2]!)).toBe(false);
    f.store.undrainDaemon("local", "dm_cost_0");
    expect(f.store.hasCliUpdateDrainForRuntime(f.runtimeIds[0]!)).toBe(false);
  });
});

for (const size of [2, 40])
  test(`Chat projection batches retry ancestry with ${size} context messages`, async () => {
    const f = await loadedFleet(size);
    const sql = await countSql(f.database, f.layer, () => {
      const projection = f.store.buildTaskSessionProjection(f.peer.id, {
        boundsOnly: true,
      });
      expect(projection?.sessionId).toBe(f.peer.chatSessionId!);
    });
    console.info("PROJECTION_COST", size, sql.length);
    expect(sql.length).toBeLessThanOrEqual(50);
    expect(
      sql.filter((statement) => /WITH RECURSIVE lineage AS/.test(statement)),
    ).toHaveLength(1);
  }, 60_000);

for (const size of [2, 40])
  test(`range markers batch ${size} targets outside the window`, async () => {
    const f = await loadedFleet(size);
    const turn = f.store.getTurnForAttempt(f.task.id)!;
    const roots = Array.from(
      { length: size },
      (_, index) =>
        f.store.sendMessage({
          session_id: f.issueSession.id,
          sender: { type: "platform", id: null },
          to: { type: "none" },
          message_kind: "status",
          wake_requested: "inbox_only",
          body_md: `protected ${index}`,
          source_turn_id: turn.id,
          metadata: { human_request: { kind: "fixture" } },
        }).message,
    );
    const from = f.store.getConversationLogHead(f.issueSession.id)!.headSeq;
    for (const root of roots)
      f.store.appendConversationLog({
        sessionId: f.issueSession.id,
        kind: "message",
        visibility: "shown",
        authorType: "platform",
        bodyMd: "edited copy",
        metadata: { target_seq: root.seq },
      });
    await f.layer.drain();
    const app = createMultiremiApp({
      store: f.store,
      authToken: "fixture-cost",
    });
    const sql = await countSql(f.database, f.layer, async () => {
      const response = await app.request(
        `/api/sessions/${f.issueSession.id}/messages?from=${from}&to=999999`,
        { headers: { Authorization: "Bearer fixture-cost" } },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        entries: Array<{ body_md: string }>;
      };
      expect(body.entries.map((entry) => entry.body_md)).toEqual(
        roots.map(() => "edited copy"),
      );
    });
    console.info("MARKER_COST", size, sql.length);
    expect(sql.length).toBeLessThan(50);
  }, 60_000);

for (const size of [2, 40]) {
  test(`POST feishu-bot/messages budget with ${size} history rows`, async () => {
    const f = await loadedFleet(size);
    const inbound = f.store.submitFeishuBotMessage('local', f.runtimeIds[0]!, {
      revision: f.config.revision, externalSessionKey: 'oc_http_cost', externalMessageId: 'om_http_seed',
      chatId: 'oc_http_cost', senderOpenId: 'ou_cost', text: 'seed', deliveryMode: 'native_cot_v1',
    });
    for (let index = 0; index < size; index++) f.store.sendMessage({ session_id: inbound.chatSessionId,
      sender: { type: 'platform', id: null }, to: { type: 'none' }, message_kind: 'status',
      wake_requested: 'inbox_only', body_md: `bot history ${index}` });
    await f.layer.drain();
    const app = createMultiremiApp({ store: f.store, authToken: 'fixture-cost' });
    const sql = await countSql(f.database, f.layer, async () => {
      const response = await app.request(`/api/daemon/runtimes/${f.runtimeIds[0]}/feishu-bot/messages`, {
        method: 'POST', headers: { Authorization: 'Bearer fixture-cost', 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: f.config.revision, external_session_key: 'oc_http_cost',
          external_message_id: 'om_http_cost', chat_id: 'oc_http_cost', sender_open_id: 'ou_cost',
          text: 'HTTP inbound', delivery_mode: 'native_cot_v1' }),
      });
      expect(response.status).toBe(202);
      const body = await response.json() as any;
      expect(body.chatSessionId).toBe(inbound.chatSessionId);
      expect(body.duplicate).toBe(false);
    });
    console.info('POST_FEISHU_COST', size, sql.length);
    expectConstantCost('POST feishu', size, sql.length);
    expect(sql.length).toBeLessThanOrEqual(96);
  }, 60_000);

  test(`Question permissions and hidden pages budget with ${size} visible and ${size * 10} hidden notifications`, async () => {
    const f = await loadedFleet(2);
    const send = (metadata: Record<string, unknown>, body_md: string) => f.store.sendMessage({
      session_id: f.issueSession.id, sender: { type: 'platform', id: null }, to: { type: 'none' },
      message_kind: 'status', wake_requested: 'inbox_only', body_md, metadata,
    }).message;
    const original = send({ question: { version: 1, workspace_id: 'local', source_issue_id: f.issue.id,
      route_revision: 1, route: [{ stage: 'human' }] } }, 'original');
    for (let i = 0; i < size * 10; i++) send({ question_notification: true,
      root_question_id: original.id, question_route_revision: 0 }, 'HIDDEN EXPIRED ROUTE');
    // SQL casts are only the prefilter: strict metadata validation must still
    // reject a string revision that happens to compare equal to numeric 1.
    const malformed = send({ question_notification: true,
      root_question_id: original.id, question_route_revision: '1' }, 'HIDDEN STRING REVISION');
    expect(f.store.canReadQuestionNotification(malformed.id, { userId: 'local', admin: false })).toBe(false);
    const visible = Array.from({ length: size }, () => send({ question_notification: true,
      root_question_id: original.id, question_route_revision: 1 }, 'visible human notification'));
    await f.layer.drain();
    const app = createMultiremiApp({ store: f.store, authToken: 'fixture-cost' });
    const sql = await countSql(f.database, f.layer, async () => {
      const response = await app.request(`/api/sessions/${f.issueSession.id}/messages?after_seq=${original.seq}&limit=100`,
        { headers: { Authorization: 'Bearer fixture-cost' } });
      expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body.messages.map((row: any) => row.id)).toEqual(visible.map(row => row.id));
      expect(body.next_cursor).toBeNull();
      expect(JSON.stringify(body)).not.toContain('HIDDEN');
    });
    console.info('QUESTION_HIDDEN_COST', size, sql.length);
    expectConstantCost('Question permissions', size, sql.length);
    expect(sql.length).toBeLessThan(50);
  }, 60_000);
}

test('usage fact and receipt writes stay batched at the 10,000-unit protocol limit', async () => {
  const f = await loadedFleet(2);
  const unit = { unitId: 'limit', revision: 1, provider: 'claude', model: 'fixture', scope: 'request' as const,
    source: 'provider_request' as const, accuracy: 'exact' as const, inputTokens: 10, outputTokens: 2,
    cacheReadTokens: 0, cacheWriteTokens: 0, actualUnsplitTokens: 0, reportedTotalTokens: 12,
    contextTokens: null, contextWindow: null, costAmount: null, costCurrency: null, occurredAt: '2026-11-17T00:00:00Z' };
  const snapshot = { version: 2 as const, runId: 'maximum-frame', revision: 1, complete: false,
    units: Array.from({ length: 10_000 }, (_, index) => ({ ...unit, unitId: `limit-${index}` })) };
  const sql = await countSql(f.database, f.layer, () => f.store.reportTaskUsageSnapshot(f.task.id, snapshot));
  expect(f.store.getTask(f.task.id)?.usage[0]?.totalTokens).toBe(120_000);
  expect(sql.filter(statement => /^INSERT INTO multiremi_usage_units\(/.test(statement))).toHaveLength(1);
  expect(sql.filter(statement => /^INSERT INTO multiremi_usage_unit_receipts\(/.test(statement))).toHaveLength(1);
  const replay = await countSql(f.database, f.layer, () => f.store.reportTaskUsageSnapshot(f.task.id, snapshot));
  expect(f.store.getTask(f.task.id)?.usage[0]?.totalTokens).toBe(120_000);
  expect(replay.length).toBeLessThan(40);
  console.info('MAX_USAGE_COST', sql.length, replay.length);
}, 60_000);

for (const historySize of [100, 3000]) {
  test(`task.usage incremental prefetch reads only frame units with ${historySize} historical units`, async () => {
    const f = await loadedFleet(2);
    const unit = { unitId: 'history', revision: 1, provider: 'claude', model: 'fixture', scope: 'request' as const,
      source: 'provider_request' as const, accuracy: 'exact' as const, inputTokens: 10, outputTokens: 2,
      cacheReadTokens: 0, cacheWriteTokens: 0, actualUnsplitTokens: 0, reportedTotalTokens: 12,
      contextTokens: null, contextWindow: null, costAmount: null, costCurrency: null, occurredAt: '2026-11-17T00:00:00Z' };
    const snapshot = { version: 2 as const, runId: 'incremental-history', revision: 1, complete: false,
      units: Array.from({ length: historySize }, (_, index) => ({ ...unit, unitId: `history-${index}` })) };
    f.store.reportTaskUsageSnapshot(f.task.id, snapshot);
    // Include audit history in the scale fixture: no historical conflict may be
    // fetched for an unrelated incremental unit (or parsed as a revision floor).
    f.database.run(`INSERT INTO multiremi_usage_identity_conflicts
      (task_id,run_id,unit_id,revision,evidence_sha256,identity_key,owner_task_id,owner_run_id,unit_json,recorded_at)
      SELECT task_id,run_id,unit_id,revision,'fixture','fixture',task_id,run_id,'{}',occurred_at
      FROM multiremi_usage_units WHERE task_id=? AND run_id=?`, [f.task.id, snapshot.runId]);
    for (const [index, delta] of [
      { ...unit, unitId: 'history-0', revision: 2, outputTokens: 3, reportedTotalTokens: 13 },
      { ...unit, unitId: 'new-unit' },
    ].entries()) {
      const observed: Record<string, number[]> = {};
      const sql = await countSql(f.database, f.layer, () => f.sessions[0]!.handleMessage(JSON.stringify({
        v: 2, t: 'task.usage', rt: f.runtimeIds[0], seq: index + 1,
        p: { task_id: f.task.id, usageSnapshot: { ...snapshot, revision: index + 2, units: [delta] } },
      })), (statement, result) => {
        const table = /FROM (multiremi_usage_units|multiremi_usage_unit_receipts|multiremi_usage_identity_conflicts) WHERE/.exec(statement)?.[1];
        if (table && Array.isArray(result)) (observed[table] ??= []).push(result.length);
      });
      expect(f.frames[0]!.find(frame => frame.t === 'res' && frame.re === String(index + 1))?.p.ok).toBe(true);
      console.info('INCREMENTAL_USAGE_ROWS', historySize, delta.unitId, observed, sql.length);
      const expectedRows = index === 0 ? 1 : 0;
      expect(observed).toEqual({ multiremi_usage_units: [expectedRows], multiremi_usage_unit_receipts: [expectedRows], multiremi_usage_identity_conflicts: [expectedRows] });
      expect(sql.length).toBeLessThanOrEqual(40);
      expect(f.store.getTask(f.task.id)?.usage[0]?.totalTokens).toBe(12 * historySize + 1 + 12 * index);
    }
  }, 60_000);
}
