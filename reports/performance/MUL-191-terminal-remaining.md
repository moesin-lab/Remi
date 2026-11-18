# MUL-191：终态剩余 SQL 审计（第三轮）

固定输入、完整 ACK/终态/回复及 layer.drain() 之后的测量；本地 SQLite，不代表真实 PG 或线上负载。小档和 stable 扩展档相同。

| 帧 | 上轮读/写=总数 | 本轮读/写=总数 | 目标 | 尚超出 |
|---|---:|---:|---:|---:|
| turn.complete |197/52=249|175/52=227|60|167|
| task.fail |141/25=166|116/25=141|40|101|

旧 context-only 的 2/40 两档：complete 163/48=211，fail 107/27=134；测试常数已同步，扩展规模不变性断言保留。

本轮合并 turn/attempt raw row、message、Session 的窄投影、Chat/Project/资源/操作者、自动任务归属、评论存在性和下行目标读取。Chat workspace lineage 改用 RuntimeLite，只需要 daemon/legacyDaemon 身份。未增加延后任务、未删除 ACK/终态/usage/outbox/通知。

## 剩余读取的边界

以下是现有事务与投影契约下的剩余执行清单，供所有者审查是否接受超过 60/40。不是数学上的 SQL 最小值；若把不同事务、业务校验和通知投影重构成新契约，仍可能减少语句。这里没有把已知可复用的相同快照读取留作下一轮。

逐执行证据记录参数、同步 cache scope、锁/事务 generation 和调用来源；JSON 的 `executions` 保留顺序。相同 SQL 多次不等于重复读取同一快照：参数可不同，写入可能已更改依赖表，或已进入新锁代际/异步快照。scope=null 表示该段未启用请求缓存，不跨后台任务借用先前快照。

在同一 scope/generation 内，按 SQL+参数并跟踪 FROM/JOIN 的依赖表写入（包括 turn_execution_records→turns/attempts、agent_lane_records→session_lanes）审计，未发现重复的同参数、未失效查询。该审计覆盖本夹具，不能替代 PG 并发测试。Runtime input 的分阶段快照按同步段关闭缓存；yield/await 后不共享旧 scope。

## 验证与复现

`MULTIREMI_TEST_QUERY_PROFILE=/tmp/profile.json MULTIREMI_TEST_SQL_TRACE=audit bun run test tests/unit/multiremi/daemon-report-scale-budget.test.ts`；原始 SQL trace 输出在 `/tmp/mul182-sql-audit-<frame>-<scale>.json`。本报告 JSON 固化了对应参数/代际；随机 fixture ID 已稳定化为占位符。

CI 反馈修复：无缓存的 attempt→turn 保留窄字段读取，避免 PG 迁移前后 prepared SELECT * 结果类型冲突。拒绝帧按任务/usage/日志和通知验证无副作用。规模夹具给连接、offer/downlink 使用手动时钟并固定业务时间；计数前通过真实 Hub 的 applyRemoteHead 补齐批量 SQL seed 绕过通知形成的日志缺口，保留填充器和通知，避免后台补洞分页混入帧计数。生产默认时钟与期限未改。

SQLite 三文件规模/旧预算/共享读取回归 38 pass；本地 PG 17.6 规模、两个迁移套件通过；额外每条 SQL 人为延迟 10ms 的 PG 规模 10 pass（终态仍 227/141），验证慢帧不会再混入准备阶段补洞。该临时延迟诊断已从代码移除。决策/状态页按顺序联合复测 18 pass，原 SQL 恒定断言保留。最终完整 CI 结论以 PR 描述及交付评论为准。PG 决策窗口用例需要创建并读取 52 条历史问答，原 15 秒在本地/CI 均超时；按契约测试设显式 60 秒，使异步工作在 teardown 前完成，不修改 SQL 预算或业务期限。

相关行为回归：10 文件 168 pass / 53 skip / 0 fail；skip 是未配置真实 PG 等前提，不能算 PG 通过。完整 CI 及最终 head 结论以 PR 描述/交付评论为准。

## turn.complete: 227 executions

类别执行数：{'校验': 128, '锁': 11, '其他': 47, '必要写入': 41}。

### turn.complete-001 · 11 次 · 校验

```sql
SELECT runtime.*, profile.display_name AS daemon_display_name, drain.daemon_id AS draining_daemon_id FROM multiremi_runtimes runtime LEFT JOIN multiremi_daemon_drains drain ON drain.workspace_id = COALESCE(runtime.workspace_id, 'local') AND drain.daemon_id = COALESCE(runtime.daemon_id, runtime.id) LEFT JOIN multiremi_daemon_profiles profile ON profile.workspace_id = COALESCE(runtime.workspace_id, 'local') AND profile.daemon_id = runtime.daemon_id WHERE runtime.id = ?
```

确认当前宿主身份、物理 daemon 和 drain fence；异步下行每次同步段重新取快照。

来源：packages/server/src/store/repos/runtimes-repo.ts:635、packages/server/src/store/repos/runtimes-repo.ts:543。

执行位置 / scope:generation：1 / 1:0, 8 / 1:2, 166 / None:None, 173 / 2:0, 177 / 2:2, 183 / None:None, 188 / 3:0, 192 / 3:2, 198 / 4:0, 205 / 5:0, 226 / 5:2。参数见相邻 JSON。

### turn.complete-002 · 2 次 · 校验

```sql
SELECT 1 FROM multiremi_daemon_retirements WHERE workspace_id = ? AND daemon_id = ?
```

拒绝已经退役的物理 daemon 上报，不能只验证 runtime 的存在。

来源：packages/server/src/store/repos/daemon-retirement-repo.ts:160、packages/server/src/api/daemon-protocol/report-handlers.ts:186、packages/server/src/store/repos/tasks-repo.ts:4799。

执行位置 / scope:generation：2 / 1:0, 9 / 1:2。参数见相邻 JSON。

### turn.complete-003 · 2 次 · 校验

```sql
SELECT id, workspace_id, runtime_id, status, agent_id, chat_session_id, issue_id, issue_session_id FROM multiremi_turn_execution_records WHERE id = ?
```

读取规范 turn/attempt 执行投影的身份、状态、lineage 或通知事实；窄 guard 与完整 task/终态投影使用不同列和提交时刻。

来源：packages/server/src/store/repos/tasks-repo.ts:2701、packages/server/src/store/repos/tasks-repo.ts:5361、packages/server/src/api/daemon-protocol/task-offers.ts:249。

执行位置 / scope:generation：3 / 1:0, 164 / 1:4。参数见相邻 JSON。

### turn.complete-004 · 5 次 · 锁

```sql
UPDATE multiremi_workspaces SET updated_at = updated_at WHERE id = ?
```

取得 workspace/Session/Issue/turn 的数据库互斥；不同外层事务或不同 lane 不能共享锁，删除会改变 PG 竞争下的校验顺序。

来源：packages/server/src/store/context.ts:1084、packages/server/src/store/request-read-cache.ts:203。

执行位置 / scope:generation：4 / 1:1, 149 / 1:3, 176 / 2:1, 191 / 3:1, 212 / 5:1。参数见相邻 JSON。

### turn.complete-005 · 4 次 · 校验

```sql
SELECT * FROM multiremi_turn_execution_records WHERE id = ?
```

读取规范 turn/attempt 执行投影的身份、状态、lineage 或通知事实；窄 guard 与完整 task/终态投影使用不同列和提交时刻。

来源：packages/server/src/store/repos/tasks-repo.ts:2673、packages/server/src/store/repos/tasks-repo.ts:2653。

执行位置 / scope:generation：5 / 1:2, 45 / 1:2, 129 / 1:2, 219 / 5:2。参数见相邻 JSON。

### turn.complete-006 · 2 次 · 其他

```sql
SELECT u.task_id AS task_id,u.provider,COALESCE(u.model,u.requested_model,'unknown') AS model, SUM(COALESCE(input_tokens,0)) AS input_tokens,SUM(COALESCE(output_tokens,0)) AS output_tokens, SUM(COALESCE(cache_read_tokens,0)) AS cache_read_tokens,SUM(COALESCE(cache_write_tokens,0)) AS cache_write_tokens, SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)+COALESCE(cache_read_tokens,0)+COALESCE(cache_write_tokens,0)+COALESCE(actual_unsplit_tokens,0)) AS total_tokens FROM multiremi_usage_units u WHERE u.task_id IN (?) AND source<>'context_snapshot' AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL OR cache_read_tokens IS NOT NULL OR cache_write_tokens IS NOT NULL OR actual_unsplit_tokens IS NOT NULL) GROUP BY u.task_id,u.provider,COALESCE(u.model,u.requested_model,'unknown') ORDER BY task_id,u.provider,model
```

按 ledger 集合汇总规范用量；按 task 与按 turn 是不同投影，不能复用旧累计字段。

来源：packages/server/src/store/request-read-cache.ts:182、packages/server/src/store/usage-projection.ts:21。

执行位置 / scope:generation：6 / 1:2, 220 / 5:2。参数见相邻 JSON。

### turn.complete-007 · 2 次 · 校验

```sql
SELECT id FROM multiremi_autopilot_run_records WHERE task_id = ? ORDER BY created_at DESC LIMIT 1
```

解析本轮关联的 autopilot run；有 run 时必须同步终态并保留可追溯关系。

来源：packages/server/src/store/request-read-cache.ts:182、packages/server/src/store/repos/tasks-repo.ts:7355。

执行位置 / scope:generation：7 / 1:2, 221 / 5:2。参数见相邻 JSON。

### turn.complete-008 · 2 次 · 校验

```sql
SELECT * FROM multiremi_workspaces WHERE id = ?
```

读取工作区设置与权限边界；终态后的通知/派活仍须遵守当前工作区约束。

来源：packages/server/src/store/repos/workspaces-repo.ts:582、packages/server/src/store/repos/tasks-repo.ts:4800、packages/server/src/store/repos/tasks-repo.ts:3060。

执行位置 / scope:generation：10 / 1:2, 62 / 1:2。参数见相邻 JSON。

### turn.complete-009 · 1 次 · 校验

```sql
SELECT * FROM multiremi_turns WHERE current_attempt_id=?
```

核对 turn/current attempt、终态状态、输入水位或派生轮卡；写入后、取得新锁后及异步新快照必须重读。

来源：packages/server/src/store/request-read-cache.ts:182、packages/server/src/store/execution-reads.ts:33。

执行位置 / scope:generation：11 / 1:2。参数见相邻 JSON。

### turn.complete-010 · 6 次 · 校验

```sql
SELECT scoped.*, CASE WHEN scoped.chat_id IS NOT NULL THEN chat.workspace_id ELSE issue.workspace_id END AS owner_workspace_id, head.workspace_id AS head_workspace_id, CASE WHEN scoped.parent_session_id IS NULL OR (parent.id IS NOT NULL AND parent.workspace_id = scoped.workspace_id AND COALESCE(parent.chat_id, '') = COALESCE(scoped.chat_id, '') AND (scoped.chat_id IS NOT NULL OR parent.issue_id = scoped.issue_id)) THEN 1 ELSE 0 END AS parent_owner_valid, CASE WHEN scoped.chat_id IS NULL AND EXISTS (SELECT 1 FROM multiremi_issue_activity activity WHERE activity.issue_id = scoped.issue_id AND activity.type = 'issue_main_session_rotated') THEN 1 ELSE 0 END AS has_rotation FROM (SELECT s.*, ( SELECT COUNT(*) FROM multiremi_conversation_log e WHERE e.session_id = s.parent_session_id AND e.kind <> 'head' AND e.seq > 0 AND ((s.inherit_mode = 'follow' AND (s.follow_frozen_seq IS NULL OR e.seq <= s.follow_frozen_seq)) OR (s.inherit_mode <> 'follow' AND e.seq <= s.inherit_cutoff_seq)) ) AS inherited_event_count FROM multiremi_issue_sessions s WHERE s.id = ?) scoped LEFT JOIN multiremi_chat_sessions chat ON chat.id = scoped.chat_id LEFT JOIN multiremi_issues issue ON issue.id = scoped.issue_id LEFT JOIN multiremi_issue_sessions parent ON parent.id = scoped.parent_session_id LEFT JOIN multiremi_conversation_heads head ON head.session_id = scoped.id
```

读取/记录 Issue 状态审计，不以终态帧本身代替业务状态事实。

来源：packages/server/src/store/request-read-cache.ts:182、packages/server/src/store/repos/issue-sessions-repo.ts:439。

执行位置 / scope:generation：12 / 1:2, 28 / 1:2, 46 / 1:2, 65 / 1:2, 95 / 1:2, 108 / 1:2。参数见相邻 JSON。

### turn.complete-011 · 1 次 · 锁

```sql
UPDATE multiremi_issue_sessions SET updated_at = updated_at WHERE id = ?
```

取得 workspace/Session/Issue/turn 的数据库互斥；不同外层事务或不同 lane 不能共享锁，删除会改变 PG 竞争下的校验顺序。

来源：packages/server/src/store/repos/tasks-repo.ts:7092、packages/server/src/store/request-read-cache.ts:203。

执行位置 / scope:generation：13 / 1:2。参数见相邻 JSON。

### turn.complete-012 · 1 次 · 必要写入

```sql
INSERT INTO multiremi_session_lanes(session_id,reader_type,reader_id,execution_scope,created_at,updated_at) VALUES(?,'agent',?,?,?,?) ON CONFLICT(session_id,reader_type,reader_id,execution_scope) DO UPDATE SET updated_at=multiremi_session_lanes.updated_at
```

创建/推进 lane 或保存暂停状态；既是并发边界也是可恢复的消费水位。

来源：packages/server/src/store/inbox/lane-machine.ts:20、packages/server/src/store/request-read-cache.ts:203。

执行位置 / scope:generation：14 / 1:2。参数见相邻 JSON。

### turn.complete-013 · 4 次 · 校验

```sql
SELECT * FROM multiremi_turn_attempts WHERE id=?
```

核对 turn/current attempt、终态状态、输入水位或派生轮卡；写入后、取得新锁后及异步新快照必须重读。

来源：packages/server/src/store/request-read-cache.ts:182、packages/server/src/store/execution-reads.ts:18。

执行位置 / scope:generation：15 / 1:2, 38 / 1:2, 70 / 1:2, 104 / 1:2。参数见相邻 JSON。

### turn.complete-014 · 1 次 · 校验

```sql
SELECT 1 FROM multiremi_conversation_log WHERE session_id=? AND kind='message' AND visibility='shown' AND deleted_at IS NULL AND to_agent_id=? AND wake_applied='now' AND seq>? AND seq<=? AND COALESCE(json_extract(metadata,'$.execution_scope'),'')=? LIMIT 1
```

读取规范消息/回复/决策事实和可见范围；输入连续性、回复来源及通知投影都依赖这些列。

来源：packages/server/src/store/repos/tasks-repo.ts:5412、packages/server/src/store/turn-execution-records.ts:142。

执行位置 / scope:generation：16 / 1:2。参数见相邻 JSON。

### turn.complete-015 · 1 次 · 校验

```sql
SELECT seq,sender_type,sender_id,body_md,to_agent_id,wake_applied,metadata FROM multiremi_conversation_log WHERE session_id=? AND seq>? AND seq<=? AND kind='message' AND visibility='shown' AND deleted_at IS NULL
```

读取规范消息/回复/决策事实和可见范围；输入连续性、回复来源及通知投影都依赖这些列。

来源：packages/server/src/store/inbox/lane-machine.ts:131、packages/server/src/store/repos/tasks-repo.ts:5415。

执行位置 / scope:generation：17 / 1:2。参数见相邻 JSON。

### turn.complete-016 · 1 次 · 校验

```sql
SELECT cursor_seq,cursor_offset FROM multiremi_session_lanes WHERE session_id=? AND reader_type='agent' AND reader_id=? AND execution_scope=?
```

核对 lane 游标、暂停与排队状态；决定 ACK、补铃和下一轮输入范围。

来源：packages/server/src/store/inbox/lane-machine.ts:144、packages/server/src/store/repos/tasks-repo.ts:5424。

执行位置 / scope:generation：18 / 1:2。参数见相邻 JSON。

### turn.complete-017 · 3 次 · 校验

```sql
SELECT * FROM multiremi_conversation_heads WHERE session_id = ?
```

读取提交后的 seq/log_version，保证读取回执、轮卡与下行水位一致。

来源：packages/server/src/store/request-read-cache.ts:182、packages/server/src/store/repos/conversation-log-repo.ts:575。

执行位置 / scope:generation：19 / 1:2, 75 / 1:2, 127 / 1:2。参数见相邻 JSON。

### turn.complete-018 · 1 次 · 必要写入

```sql
UPDATE multiremi_turn_attempts SET input_ack_seq=?,input_read_seq=?,input_read_offset=?,input_trigger_ack=1 WHERE id=?
```

持久化 attempt 终态、输入收据/offer 水位或最终 trace 事实；后续重放必须读取持久化的新值。

来源：packages/server/src/store/inbox/attempt-input.ts:59、packages/server/src/store/repos/tasks-repo.ts:5425。

执行位置 / scope:generation：20 / 1:2。参数见相邻 JSON。

### turn.complete-019 · 2 次 · 校验

```sql
SELECT 1 AS present FROM multiremi_conversation_log log JOIN multiremi_issue_sessions s ON s.id = log.session_id WHERE s.issue_id = ? AND log.sender_type = 'agent' AND log.sender_id = ? AND log.kind = 'message' AND log.message_kind IN ('request', 'reply', 'final') AND log.to_type = 'none' AND SUBSTR(log.id, 1, 4) = 'cmt_' AND log.visibility='shown' AND log.deleted_at IS NULL AND log.task_id = (SELECT turn_id FROM multiremi_turn_attempts WHERE id=?) AND log.created_at >= ? LIMIT 1
```

核对 turn/current attempt、终态状态、输入水位或派生轮卡；写入后、取得新锁后及异步新快照必须重读。

来源：packages/server/src/store/request-read-cache.ts:182、packages/server/src/store/repos/tasks-repo.ts:7259。

执行位置 / scope:generation：21 / 1:2, 48 / 1:2。参数见相邻 JSON。

### turn.complete-020 · 1 次 · 锁

```sql
UPDATE multiremi_turns SET current_attempt_id=current_attempt_id WHERE id IN (SELECT turn_id FROM multiremi_turn_execution_records WHERE id = ? AND status IN ('dispatched', 'running', 'waiting_local_directory', 'awaiting_human'))
```

取得 workspace/Session/Issue/turn 的数据库互斥；不同外层事务或不同 lane 不能共享锁，删除会改变 PG 竞争下的校验顺序。

来源：packages/server/src/store/turn-execution-records.ts:180、packages/server/src/store/repos/tasks-repo.ts:5434。

执行位置 / scope:generation：22 / 1:2。参数见相邻 JSON。

### turn.complete-021 · 1 次 · 校验

```sql
SELECT target.*,owner.current_attempt_id AS mutation_current_attempt_id, owner.session_id AS mutation_session_id,owner.agent_id AS mutation_agent_id, owner.reply_message_id AS mutation_reply_message_id,owner.started_at AS mutation_started_at FROM (SELECT id,turn_id,('completed') AS mutation_0,(?) AS mutation_1,(?) AS mutation_2,(COALESCE(?, session_id)) AS mutation_3,(COALESCE(?, work_dir)) AS mutation_4,(NULL) AS mutation_5,(NULL) AS mutation_6,(?) AS mutation_7,(?) AS mutation_8 FROM multiremi_turn_execution_records WHERE id = ? AND status IN ('dispatched', 'running', 'waiting_local_directory', 'awaiting_human')) target JOIN multiremi_turns owner ON owner.id=target.turn_id
```

在 turn 锁内读取 mutation target 和 current_attempt_id；防止被替换/终态的 attempt 回写新轮。

来源：packages/server/src/store/turn-execution-records.ts:189、packages/server/src/store/repos/tasks-repo.ts:5434。

执行位置 / scope:generation：23 / 1:2。参数见相邻 JSON。

### turn.complete-022 · 3 次 · 校验

```sql
SELECT * FROM multiremi_turns WHERE id=?
```

核对 turn/current attempt、终态状态、输入水位或派生轮卡；写入后、取得新锁后及异步新快照必须重读。

来源：packages/server/src/store/request-read-cache.ts:182、packages/server/src/store/execution-reads.ts:12。

执行位置 / scope:generation：24 / 1:2, 73 / 1:2, 105 / 1:2。参数见相邻 JSON。

### turn.complete-023 · 3 次 · 校验

```sql
SELECT s.*, ( SELECT COUNT(*) FROM multiremi_conversation_log e WHERE e.session_id = s.parent_session_id AND e.kind <> 'head' AND e.seq > 0 AND ((s.inherit_mode = 'follow' AND (s.follow_frozen_seq IS NULL OR e.seq <= s.follow_frozen_seq)) OR (s.inherit_mode <> 'follow' AND e.seq <= s.inherit_cutoff_seq)) ) AS inherited_event_count FROM multiremi_issue_sessions s WHERE id = ?
```

读取规范消息/回复/决策事实和可见范围；输入连续性、回复来源及通知投影都依赖这些列。

来源：packages/server/src/store/request-read-cache.ts:182、packages/server/src/store/repos/issue-sessions-repo.ts:433。

执行位置 / scope:generation：25 / 1:2, 94 / 1:2, 106 / 1:2。参数见相邻 JSON。

### turn.complete-024 · 3 次 · 校验

```sql
SELECT chat.id, chat.workspace_id, chat.creator_id, chat.agent_id, chat.runtime_workspace_id, chat.project_id, chat.title, chat.status, chat.session_id, chat.work_dir, chat.session_runtime_id, chat.session_provider, chat.session_execution_fingerprint, chat.latest_task_id, chat.pinned, chat.origin_autopilot_id, chat.origin_run_id, chat.created_at, chat.updated_at, (SELECT COUNT(*) FROM multiremi_conversation_log m LEFT JOIN multiremi_session_lanes legacy ON legacy.session_id = m.session_id AND legacy.reader_type = 'member' AND legacy.reader_id = m.to_member_id AND legacy.execution_scope = '' LEFT JOIN multiremi_workspace_read_cursors shared ON shared.session_id = m.session_id AND shared.workspace_id = chat.workspace_id WHERE m.session_id = chat.id AND m.kind = 'message' AND m.visibility = 'shown' AND m.to_member_id IS NOT NULL AND m.deleted_at IS NULL AND m.seq > COALESCE(legacy.cursor_seq, 0) AND m.seq > COALESCE(shared.cursor_seq, 0)) AS unread_count, (SELECT MIN(m.created_at) FROM multiremi_conversation_log m LEFT JOIN multiremi_session_lanes legacy ON legacy.session_id = m.session_id AND legacy.reader_type = 'member' AND legacy.reader_id = m.to_member_id AND legacy.execution_scope = '' LEFT JOIN multiremi_workspace_read_cursors shared ON shared.session_id = m.session_id AND shared.workspace_id = chat.workspace_id WHERE m.session_id = chat.id AND m.kind = 'message' AND m.visibility = 'shown' AND m.to_member_id IS NOT NULL AND m.deleted_at IS NULL AND m.seq > COALESCE(legacy.cursor_seq, 0) AND m.seq > COALESCE(shared.cursor_seq, 0)) AS reader_unread_since, (SELECT SUBSTR(m.body, 1, 240) FROM multiremi_chat_message_records m WHERE m.chat_session_id = chat.id ORDER BY m.sequence DESC, m.id DESC LIMIT 1) AS last_message_content, (SELECT m.role FROM multiremi_chat_message_records m WHERE m.chat_session_id = chat.id ORDER BY m.sequence DESC, m.id DESC LIMIT 1) AS last_message_role, (SELECT m.created_at FROM multiremi_chat_message_records m WHERE m.chat_session_id = chat.id ORDER BY m.sequence DESC, m.id DESC LIMIT 1) AS last_message_created_at FROM multiremi_chat_sessions chat WHERE chat.id = ?
```

读取规范消息/回复/决策事实和可见范围；输入连续性、回复来源及通知投影都依赖这些列。

来源：packages/server/src/store/request-read-cache.ts:182、packages/server/src/store/repos/chat-repo.ts:254。

执行位置 / scope:generation：26 / 1:2, 71 / 1:2, 107 / 1:2。参数见相邻 JSON。

### turn.complete-025 · 1 次 · 校验

```sql
SELECT workspace_id FROM multiremi_autopilots WHERE session_id=?
```

解析 autopilot Session 的所属工作区；消息统一入口不能只支持 Issue/Chat。

来源：packages/server/src/store/request-read-cache.ts:182、packages/server/src/store/inbox/send-message.ts:77。

执行位置 / scope:generation：27 / 1:2。参数见相邻 JSON。

### turn.complete-026 · 4 次 · 校验

```sql
SELECT * FROM multiremi_conversation_log WHERE id=? AND kind='message'
```

读取规范消息/回复/决策事实和可见范围；输入连续性、回复来源及通知投影都依赖这些列。

来源：packages/server/src/store/request-read-cache.ts:182、packages/server/src/store/inbox/send-message.ts:22。

执行位置 / scope:generation：29 / 1:2, 41 / 1:2, 74 / 1:2, 85 / 1:2。参数见相邻 JSON。

### turn.complete-027 · 7 次 · 校验

```sql
SELECT i.*, w.id AS existing_workspace_id FROM multiremi_issues i LEFT JOIN multiremi_workspaces w ON w.id = i.workspace_id WHERE i.id = ?
```

核对 Issue 归属、父子状态与执行负责人，完成一个 turn 不等于整个 Issue 已完成。

来源：packages/server/src/store/request-read-cache.ts:182、packages/server/src/store/repos/issues-repo.ts:850。

执行位置 / scope:generation：30 / 1:2, 57 / 1:2, 72 / 1:2, 113 / 1:2, 120 / 1:2, 125 / 1:2, 152 / 1:4。参数见相邻 JSON。

### turn.complete-028 · 2 次 · 校验

```sql
SELECT l.* FROM multiremi_issue_labels l JOIN multiremi_issue_to_labels il ON il.label_id = l.id WHERE il.issue_id = ? ORDER BY lower(l.name) ASC
```

批量构建 Issue 的标签投影，保持现有通知内容。

来源：packages/server/src/store/request-read-cache.ts:182、packages/server/src/store/repos/issues-repo.ts:5399。

执行位置 / scope:generation：31 / 1:2, 153 / 1:4。参数见相邻 JSON。

### turn.complete-029 · 1 次 · 校验

```sql
SELECT * FROM multiremi_agents WHERE id = ?
```

验证 agent 未归档及其执行配置，供回复身份校验和后续派活。

来源：packages/server/src/store/request-read-cache.ts:182、packages/server/src/store/repos/agents-skills-repo.ts:756。

执行位置 / scope:generation：32 / 1:2。参数见相邻 JSON。

### turn.complete-030 · 1 次 · 其他

```sql
SELECT s.* FROM multiremi_skills s JOIN multiremi_agent_skills aks ON aks.skill_id = s.id WHERE aks.agent_id = ? AND s.archived_at IS NULL ORDER BY aks.created_at ASC, s.name ASC
```

读取当前可用 Skill 配置，避免派发已归档或过期能力。

来源：packages/server/src/store/request-read-cache.ts:182、packages/server/src/store/repos/agents-skills-repo.ts:897。

执行位置 / scope:generation：33 / 1:2。参数见相邻 JSON。

### turn.complete-031 · 2 次 · 必要写入

```sql
UPDATE multiremi_conversation_heads SET workspace_id=COALESCE(workspace_id,?),updated_at=updated_at WHERE session_id=?
```

原子分配消息 seq 或递增 log_version，不能用进程内计数替代。

来源：packages/server/src/store/inbox/send-message.ts:159、packages/server/src/store/repos/conversation-log-repo.ts:128、packages/server/src/store/repos/issues-repo.ts:4432。

执行位置 / scope:generation：34 / 1:2, 76 / 1:2。参数见相邻 JSON。

### turn.complete-032 · 3 次 · 校验

```sql
SELECT id,workspace_id,parent_issue_id,assignee_type,assignee_id FROM multiremi_issues WHERE id=?
```

核对 Issue 归属、父子状态与执行负责人，完成一个 turn 不等于整个 Issue 已完成。

来源：packages/server/src/store/issue-responsibility.ts:20、packages/server/src/store/issue-responsibility.ts:24。

执行位置 / scope:generation：35 / 1:2, 77 / 1:2, 114 / 1:2。参数见相邻 JSON。

### turn.complete-033 · 3 次 · 校验

```sql
SELECT * FROM multiremi_conversation_log WHERE id = ?
```

读取规范消息/回复/决策事实和可见范围；输入连续性、回复来源及通知投影都依赖这些列。

来源：packages/server/src/store/repos/conversation-log-repo.ts:599、packages/server/src/store/repos/conversation-log-repo.ts:474、packages/server/src/store/inbox/send-message.ts:234。

执行位置 / scope:generation：36 / 1:2, 84 / 1:2, 98 / 1:2。参数见相邻 JSON。

### turn.complete-034 · 2 次 · 必要写入

```sql
INSERT INTO multiremi_conversation_heads (session_id, head_seq, log_version, updated_at) VALUES (?, 1, 1, ?) ON CONFLICT(session_id) DO UPDATE SET head_seq = multiremi_conversation_heads.head_seq + 1, log_version = multiremi_conversation_heads.log_version + 1, updated_at = excluded.updated_at RETURNING head_seq
```

原子分配消息 seq 或递增 log_version，不能用进程内计数替代。

来源：packages/server/src/store/repos/conversation-log-repo.ts:553、packages/server/src/store/repos/conversation-log-repo.ts:486。

执行位置 / scope:generation：37 / 1:2, 99 / 1:2。参数见相邻 JSON。

### turn.complete-035 · 2 次 · 必要写入

```sql
INSERT INTO multiremi_conversation_log ( session_id, seq, id, kind, visibility, sender_type, sender_id, task_id, body_md, body_html, render_version, reply_to_id, resolved_at, resolved_by_type, resolved_by_id, metadata, revision, created_at, updated_at, deleted_at, to_type,to_ref,to_agent_id,to_member_id,message_kind,wake_requested,wake_applied,wake_reason,dedupe_key, options,card_token_hash,card_token_recipient,card_token_consumed_at ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
```

持久化规范回复/可见性/决策元数据或递增 revision，供重放及浏览器补读。

来源：packages/server/src/store/repos/conversation-log-repo.ts:493、packages/server/src/store/inbox/send-message.ts:236、packages/server/src/store/repos/issue-sessions-repo.ts:723。

执行位置 / scope:generation：39 / 1:2, 100 / 1:2。参数见相邻 JSON。

### turn.complete-036 · 6 次 · 校验

```sql
SELECT * FROM multiremi_conversation_log WHERE session_id = ? AND seq = ?
```

读取规范消息/回复/决策事实和可见范围；输入连续性、回复来源及通知投影都依赖这些列。

来源：packages/server/src/store/request-read-cache.ts:182、packages/server/src/store/repos/conversation-log-repo.ts:592。

执行位置 / scope:generation：40 / 1:2, 79 / 1:2, 82 / 1:2, 101 / 1:2, 140 / 1:2, 144 / 1:2。参数见相邻 JSON。

### turn.complete-037 · 1 次 · 必要写入

```sql
UPDATE multiremi_turn_attempts SET status=?,branch_name=?,session_id=?,work_dir=?,wait_reason=?,failure_reason=?,ended_at=?,updated_at=? WHERE id=?
```

持久化 attempt 终态、输入收据/offer 水位或最终 trace 事实；后续重放必须读取持久化的新值。

来源：packages/server/src/store/turn-execution-records.ts:158、packages/server/src/store/turn-execution-records.ts:236。

执行位置 / scope:generation：42 / 1:2。参数见相邻 JSON。

### turn.complete-038 · 1 次 · 必要写入

```sql
UPDATE multiremi_turns SET status=?,ended_at=?,reply_message_id=? WHERE id=?
```

持久化 turn 终态、规范回复链接与轮卡状态。

来源：packages/server/src/store/turn-execution-records.ts:158、packages/server/src/store/turn-execution-records.ts:237。

执行位置 / scope:generation：43 / 1:2。参数见相邻 JSON。

### turn.complete-039 · 1 次 · 必要写入

```sql
INSERT INTO multiremi_task_traces (task_id, location, updated_at) VALUES (?, 'none', ?) ON CONFLICT(task_id) DO UPDATE SET location = 'none', runtime_id = NULL, updated_at = excluded.updated_at WHERE multiremi_task_traces.location = 'daemon'
```

持久化 trace 的终态位置，后续读取不能继续等待 daemon。

来源：packages/server/src/store/repos/task-traces-repo.ts:55、packages/server/src/store/store.ts:1093。

执行位置 / scope:generation：44 / 1:2。参数见相邻 JSON。

### turn.complete-040 · 1 次 · 校验

```sql
SELECT id FROM multiremi_message_question_records WHERE task_id = ? AND status IN ('pending','responded')
```

检查待答/已答 Q、provider 等待和提醒截止，防止终态后丢卡或重复提醒。

来源：packages/server/src/store/repos/tasks-repo.ts:6986、packages/server/src/store/repos/tasks-repo.ts:6572。

执行位置 / scope:generation：47 / 1:2。参数见相邻 JSON。

### turn.complete-041 · 1 次 · 校验

```sql
SELECT reply_message_id FROM multiremi_turns WHERE current_attempt_id = ?
```

核对 turn/current attempt、终态状态、输入水位或派生轮卡；写入后、取得新锁后及异步新快照必须重读。

来源：packages/server/src/store/repos/tasks-repo.ts:6580、packages/server/src/store/repos/tasks-repo.ts:5457。

执行位置 / scope:generation：49 / 1:2。参数见相邻 JSON。

### turn.complete-042 · 1 次 · 校验

```sql
SELECT t.id, t.status, t.current_attempt_id FROM multiremi_turns t JOIN multiremi_turn_attempts a ON a.turn_id = t.id WHERE a.id = ?
```

核对 turn/current attempt、终态状态、输入水位或派生轮卡；写入后、取得新锁后及异步新快照必须重读。

来源：packages/server/src/store/repos/tasks-repo.ts:6637、packages/server/src/store/repos/tasks-repo.ts:5457。

执行位置 / scope:generation：50 / 1:2。参数见相邻 JSON。

### turn.complete-043 · 1 次 · 必要写入

```sql
UPDATE multiremi_access_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE type = 'task' AND task_id = ? AND revoked_at IS NULL
```

撤销终态任务凭据，避免完成后继续写业务状态。

来源：packages/server/src/store/repos/access-tokens-repo.ts:243、packages/server/src/store/repos/tasks-repo.ts:6662。

执行位置 / scope:generation：51 / 1:2。参数见相邻 JSON。

### turn.complete-044 · 2 次 · 校验

```sql
SELECT workspace_id FROM multiremi_issues WHERE id = ?
```

核对 Issue 归属、父子状态与执行负责人，完成一个 turn 不等于整个 Issue 已完成。

来源：packages/server/src/store/request-read-cache.ts:182、packages/server/src/store/context.ts:1586。

执行位置 / scope:generation：52 / 1:2, 86 / 1:2。参数见相邻 JSON。

### turn.complete-045 · 2 次 · 必要写入

```sql
INSERT INTO multiremi_issue_activity (id, issue_id, workspace_id, actor_type, actor_id, type, body, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
```

保存 issue_activity 的业务变更，后续通知、回放和派活必须观察提交后的事实。

来源：packages/server/src/store/context.ts:1448、packages/server/src/store/repos/tasks-repo.ts:6763、packages/server/src/store/repos/issues-repo.ts:4450。

执行位置 / scope:generation：53 / 1:2, 87 / 1:2。参数见相邻 JSON。

### turn.complete-046 · 1 次 · 校验

```sql
SELECT log.*,log.sender_type AS author_type,log.sender_id AS author_id,log.reply_to_id AS parent_id, s.issue_id, log.session_id AS issue_session_id, log.body_md AS body, CASE WHEN log.sender_type = 'platform' THEN 'system' ELSE 'comment' END AS type FROM multiremi_conversation_log log JOIN multiremi_issue_sessions s ON s.id = log.session_id WHERE log.id = ? AND log.kind IN ('message', 'system') AND log.deleted_at IS NULL
```

读取规范消息/回复/决策事实和可见范围；输入连续性、回复来源及通知投影都依赖这些列。

来源：packages/server/src/store/context.ts:1579、packages/server/src/store/repos/tasks-repo.ts:7199。

执行位置 / scope:generation：54 / 1:2。参数见相邻 JSON。

### turn.complete-047 · 1 次 · 锁

```sql
UPDATE multiremi_workspaces SET updated_at = updated_at WHERE id = (SELECT workspace_id FROM multiremi_issues WHERE id = ?)
```

取得 workspace/Session/Issue/turn 的数据库互斥；不同外层事务或不同 lane 不能共享锁，删除会改变 PG 竞争下的校验顺序。

来源：packages/server/src/store/repos/issues-repo.ts:4367、packages/server/src/store/repos/tasks-repo.ts:7214。

执行位置 / scope:generation：55 / 1:2。参数见相邻 JSON。

### turn.complete-048 · 1 次 · 锁

```sql
UPDATE multiremi_issues SET id = id WHERE id = ?
```

取得 workspace/Session/Issue/turn 的数据库互斥；不同外层事务或不同 lane 不能共享锁，删除会改变 PG 竞争下的校验顺序。

来源：packages/server/src/store/issue-row-lock.ts:5、packages/server/src/store/repos/issues-repo.ts:4373。

执行位置 / scope:generation：56 / 1:2。参数见相邻 JSON。

### turn.complete-049 · 3 次 · 校验

```sql
SELECT cmt.*, log.id AS log_id, log.body_md AS log_body_md, log.updated_at AS log_updated_at, log.resolved_at AS log_resolved_at, log.resolved_by_type AS log_resolved_by_type, log.resolved_by_id AS log_resolved_by_id FROM multiremi_issue_message_records cmt LEFT JOIN multiremi_conversation_log log ON log.id = cmt.id WHERE cmt.id = ?
```

读取 Issue 的规范消息投影，用于回写回复与发布提交后的通知。

来源：packages/server/src/store/repos/issues-repo.ts:4907、packages/server/src/store/repos/issues-repo.ts:4384、packages/server/src/store/repos/issues-repo.ts:4457、packages/server/src/store/repos/issues-repo.ts:4585。

执行位置 / scope:generation：58 / 1:2, 88 / 1:2, 154 / 1:4。参数见相邻 JSON。

### turn.complete-050 · 3 次 · 其他

```sql
SELECT * FROM multiremi_comment_reactions WHERE comment_id IN (?) ORDER BY created_at ASC
```

批量读取评论反应，维持提交后的评论完整投影。

来源：packages/server/src/store/repos/issues-repo.ts:5691、packages/server/src/store/repos/issues-repo.ts:6216。

执行位置 / scope:generation：59 / 1:2, 89 / 1:2, 155 / 1:4。参数见相邻 JSON。

### turn.complete-051 · 3 次 · 其他

```sql
SELECT * FROM multiremi_attachments WHERE comment_id IN (?) ORDER BY created_at ASC
```

批量读取回复附件，保留消息通知与投影的附件契约。

来源：packages/server/src/store/repos/issues-repo.ts:5845、packages/server/src/store/repos/issues-repo.ts:6217。

执行位置 / scope:generation：60 / 1:2, 90 / 1:2, 156 / 1:4。参数见相邻 JSON。

### turn.complete-052 · 1 次 · 其他

```sql
SELECT * FROM multiremi_skill_files WHERE skill_id IN (SELECT value FROM json_each(?)) ORDER BY skill_id ASC, path ASC
```

集合读取 Skill 文件；保留完整 bundle 且语句数不随 Skill 数增长。

来源：packages/server/src/store/request-read-cache.ts:182、packages/server/src/store/repos/agents-skills-repo.ts:906。

执行位置 / scope:generation：61 / 1:2。参数见相邻 JSON。

### turn.complete-053 · 1 次 · 必要写入

```sql
UPDATE multiremi_issues SET updated_at = ? WHERE id = ?
```

保存 issues 的业务变更，后续通知、回放和派活必须观察提交后的事实。

来源：packages/server/src/store/repos/issues-repo.ts:4410、packages/server/src/store/repos/tasks-repo.ts:7214。

执行位置 / scope:generation：63 / 1:2。参数见相邻 JSON。

### turn.complete-054 · 1 次 · 校验

```sql
SELECT * FROM multiremi_issue_message_records WHERE id = ?
```

读取 Issue 的规范消息投影，用于回写回复与发布提交后的通知。

来源：packages/server/src/store/context.ts:1568、packages/server/src/store/repos/issues-repo.ts:6270。

执行位置 / scope:generation：64 / 1:2。参数见相邻 JSON。

### turn.complete-055 · 1 次 · 必要写入

```sql
INSERT INTO multiremi_session_participants ( id, session_id, participant_type, participant_id, role, status, joined_at, updated_at ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?) ON CONFLICT(session_id, participant_type, participant_id) DO UPDATE SET role = excluded.role, status = 'active', updated_at = excluded.updated_at
```

保存 session_participants 的业务变更，后续通知、回放和派活必须观察提交后的事实。

来源：packages/server/src/store/repos/issue-sessions-repo.ts:608、packages/server/src/store/repos/issues-repo.ts:4413。

执行位置 / scope:generation：66 / 1:2。参数见相邻 JSON。

### turn.complete-056 · 1 次 · 必要写入

```sql
INSERT INTO multiremi_session_lanes ( session_id, reader_id, execution_scope, cursor_seq, generation, status, created_at, updated_at ) VALUES (?, ?, ?, 0, 1, 'active', ?, ?) ON CONFLICT(session_id, reader_type, reader_id, execution_scope) DO NOTHING
```

创建/推进 lane 或保存暂停状态；既是并发边界也是可恢复的消费水位。

来源：packages/server/src/store/repos/issue-sessions-repo.ts:789、packages/server/src/store/repos/issue-sessions-repo.ts:616。

执行位置 / scope:generation：67 / 1:2。参数见相邻 JSON。

### turn.complete-057 · 1 次 · 校验

```sql
SELECT * FROM multiremi_agent_lane_records WHERE session_id = ? AND agent_id = ? AND execution_scope = ?
```

核对执行 lane 的 generation 与读水位，不能把另一个执行 scope 的消费算到本轮。

来源：packages/server/src/store/repos/issue-sessions-repo.ts:798、packages/server/src/store/repos/issue-sessions-repo.ts:616。

执行位置 / scope:generation：68 / 1:2。参数见相邻 JSON。

### turn.complete-058 · 1 次 · 校验

```sql
SELECT * FROM multiremi_session_participants WHERE session_id = ? AND participant_type = ? AND participant_id = ?
```

验证消息收件人已参与 Session，保留投递与权限边界。

来源：packages/server/src/store/repos/issue-sessions-repo.ts:620、packages/server/src/store/repos/issues-repo.ts:4413。

执行位置 / scope:generation：69 / 1:2。参数见相邻 JSON。

### turn.complete-059 · 1 次 · 必要写入

```sql
UPDATE multiremi_conversation_log SET to_type=?,to_ref=?,to_agent_id=?,to_member_id=?,message_kind=?,reply_to_id=?, wake_requested=?,wake_applied=?,wake_reason=?,dedupe_key=?,options=?,task_id=COALESCE(?,task_id) WHERE id=?
```

持久化规范回复/可见性/决策元数据或递增 revision，供重放及浏览器补读。

来源：packages/server/src/store/inbox/send-message.ts:228、packages/server/src/store/repos/issues-repo.ts:4432。

执行位置 / scope:generation：78 / 1:2。参数见相邻 JSON。

### turn.complete-060 · 1 次 · 必要写入

```sql
UPDATE multiremi_conversation_heads SET log_version = log_version + 1, updated_at = ? WHERE session_id = ?
```

原子分配消息 seq 或递增 log_version，不能用进程内计数替代。

来源：packages/server/src/store/repos/conversation-log-repo.ts:672、packages/server/src/store/inbox/send-message.ts:232。

执行位置 / scope:generation：80 / 1:2。参数见相邻 JSON。

### turn.complete-061 · 1 次 · 必要写入

```sql
UPDATE multiremi_conversation_log SET metadata = ?, updated_at = ?, revision = revision + 1 WHERE session_id = ? AND seq = ?
```

持久化规范回复/可见性/决策元数据或递增 revision，供重放及浏览器补读。

来源：packages/server/src/store/repos/conversation-log-repo.ts:677、packages/server/src/store/inbox/send-message.ts:232。

执行位置 / scope:generation：81 / 1:2。参数见相邻 JSON。

### turn.complete-062 · 1 次 · 必要写入

```sql
UPDATE multiremi_conversation_log SET visibility='shown' WHERE id=?
```

持久化规范回复/可见性/决策元数据或递增 revision，供重放及浏览器补读。

来源：packages/server/src/store/inbox/send-message.ts:233、packages/server/src/store/repos/issues-repo.ts:4432。

执行位置 / scope:generation：83 / 1:2。参数见相邻 JSON。

### turn.complete-063 · 2 次 · 校验

```sql
SELECT * FROM multiremi_workspace_members WHERE workspace_id = ? AND archived_at IS NULL ORDER BY name ASC
```

确定共享操作者、作者与通知收件人，不能用 agent 或缓存的用户身份替代。

来源：packages/server/src/store/repos/workspaces-repo.ts:219、packages/server/src/store/repos/issues-repo.ts:6548。

执行位置 / scope:generation：91 / 1:2, 159 / 1:4。参数见相邻 JSON。

### turn.complete-064 · 1 次 · 必要写入

```sql
INSERT INTO multiremi_system_events (id, workspace_id, resource, event, resource_id, project_id, payload, status, attempt_count, available_at, created_at) VALUES (?, ?, 'issue_comment', ?, ?, ?, ?, 'pending', 0, ?, ?)
```

持久化/结算可靠通知意图，避免事务提交后通知丢失。

来源：packages/server/src/store/repos/issues-repo.ts:4524、packages/server/src/store/repos/issues-repo.ts:4480。

执行位置 / scope:generation：92 / 1:2。参数见相邻 JSON。

### turn.complete-065 · 2 次 · 必要写入

```sql
UPDATE multiremi_turns SET reply_message_id=? WHERE id=? AND current_attempt_id=?
```

持久化 turn 终态、规范回复链接与轮卡状态。

来源：packages/server/src/store/repos/conversation-log-repo.ts:830、packages/server/src/store/repos/tasks-repo.ts:7222、packages/server/src/store/repos/tasks-repo.ts:6796。

执行位置 / scope:generation：93 / 1:2, 103 / 1:2。参数见相邻 JSON。

### turn.complete-066 · 1 次 · 必要写入

```sql
UPDATE multiremi_issue_sessions SET updated_at = ? WHERE id = ?
```

保存 issue_sessions 的业务变更，后续通知、回放和派活必须观察提交后的事实。

来源：packages/server/src/store/repos/issue-sessions-repo.ts:722、packages/server/src/store/repos/tasks-repo.ts:6795。

执行位置 / scope:generation：96 / 1:2。参数见相邻 JSON。

### turn.complete-067 · 1 次 · 校验

```sql
SELECT seq FROM multiremi_conversation_log WHERE session_id = ? AND task_id = ? AND kind = 'turn' ORDER BY seq ASC LIMIT 1
```

读取规范消息/回复/决策事实和可见范围；输入连续性、回复来源及通知投影都依赖这些列。

来源：packages/server/src/store/repos/issue-sessions-repo.ts:751、packages/server/src/store/repos/issue-sessions-repo.ts:723。

执行位置 / scope:generation：97 / 1:2。参数见相邻 JSON。

### turn.complete-068 · 1 次 · 必要写入

```sql
UPDATE multiremi_turn_attempts SET failure_reason=? WHERE id=?
```

持久化 attempt 终态、输入收据/offer 水位或最终 trace 事实；后续重放必须读取持久化的新值。

来源：packages/server/src/store/repos/conversation-log-repo.ts:829、packages/server/src/store/repos/tasks-repo.ts:6796。

执行位置 / scope:generation：102 / 1:2。参数见相邻 JSON。

### turn.complete-069 · 1 次 · 校验

```sql
SELECT cursor_seq FROM multiremi_session_lanes WHERE session_id=? AND reader_type='agent' AND reader_id=? AND execution_scope=?
```

核对 lane 游标、暂停与排队状态；决定 ACK、补铃和下一轮输入范围。

来源：packages/server/src/store/inbox/lane-machine.ts:93、packages/server/src/store/repos/tasks-repo.ts:7176。

执行位置 / scope:generation：109 / 1:2。参数见相邻 JSON。

### turn.complete-070 · 1 次 · 校验

```sql
SELECT id FROM multiremi_conversation_log WHERE session_id=? AND kind='message' AND to_agent_id=? AND seq>? AND wake_applied='now' AND deleted_at IS NULL AND COALESCE(json_extract(metadata,'$.execution_scope'),'')=? ORDER BY seq DESC LIMIT 1
```

读取规范消息/回复/决策事实和可见范围；输入连续性、回复来源及通知投影都依赖这些列。

来源：packages/server/src/store/inbox/lane-machine.ts:102、packages/server/src/store/repos/tasks-repo.ts:7176。

执行位置 / scope:generation：110 / 1:2。参数见相邻 JSON。

### turn.complete-071 · 1 次 · 校验

```sql
SELECT task.*,snapshot.id AS terminal_report_id,snapshot.metadata AS terminal_report_metadata, (SELECT MAX(seq) FROM multiremi_conversation_log e WHERE e.session_id=task.issue_session_id AND e.task_id=t.id) AS terminal_event_seq FROM multiremi_turn_execution_records task JOIN multiremi_turns t ON t.id=task.turn_id AND t.current_attempt_id=task.id LEFT JOIN multiremi_conversation_log snapshot ON snapshot.session_id=? AND snapshot.dedupe_key='delegation_terminal:'||task.id WHERE COALESCE(t.delegated_from_issue_session_id,t.session_id)=? AND t.status IN ('completed','failed','cancelled') AND t.delegation_id IS NOT NULL AND t.delegated_by_agent_id IS NOT NULL AND t.agent_id<>t.delegated_by_agent_id AND t.delegation_return_turn_id IS NULL AND t.delegation_skip_reason IS NULL ORDER BY t.ended_at,t.created_at,t.id
```

读取规范 turn/attempt 执行投影的身份、状态、lineage 或通知事实；窄 guard 与完整 task/终态投影使用不同列和提交时刻。

来源：packages/server/src/store/repos/tasks-repo.ts:6361、packages/server/src/store/repos/tasks-repo.ts:6191。

执行位置 / scope:generation：111 / 1:2。参数见相邻 JSON。

### turn.complete-072 · 1 次 · 锁

```sql
UPDATE multiremi_issues SET id=id WHERE id=?
```

取得 workspace/Session/Issue/turn 的数据库互斥；不同外层事务或不同 lane 不能共享锁，删除会改变 PG 竞争下的校验顺序。

来源：packages/server/src/store/inbox/issue-status.ts:9、packages/server/src/store/repos/tasks-repo.ts:6821。

执行位置 / scope:generation：112 / 1:2。参数见相邻 JSON。

### turn.complete-073 · 1 次 · 校验

```sql
SELECT t.*,m.sender_type AS trigger_sender,m.wake_reason AS trigger_reason,m.message_kind AS trigger_kind, (SELECT COUNT(*) FROM multiremi_conversation_log merged WHERE merged.kind='message' AND merged.deleted_at IS NULL AND json_extract(CASE WHEN json_valid(merged.metadata) THEN merged.metadata ELSE '{}' END,'$.delivery_turn_id')=t.id AND merged.wake_reason IN ('human_sender','agent_dispatch')) AS merged_work_triggers FROM multiremi_turns t LEFT JOIN multiremi_conversation_log m ON m.id=t.trigger_message_id LEFT JOIN multiremi_issue_sessions owned_session ON owned_session.id=t.session_id WHERE t.issue_id=? AND COALESCE(owned_session.chat_id,t.chat_session_id) IS NULL AND (owned_session.id IS NULL OR owned_session.issue_id=t.issue_id) ORDER BY t.created_at DESC,t.seq DESC,t.id DESC
```

核对 turn/current attempt、终态状态、输入水位或派生轮卡；写入后、取得新锁后及异步新快照必须重读。

来源：packages/server/src/store/inbox/issue-status.ts:20、packages/server/src/store/repos/tasks-repo.ts:6821。

执行位置 / scope:generation：115 / 1:2。参数见相邻 JSON。

### turn.complete-074 · 1 次 · 校验

```sql
SELECT 1 FROM multiremi_conversation_log d JOIN multiremi_issue_sessions s ON s.id=d.session_id WHERE s.issue_id=? AND s.chat_id IS NULL AND d.kind='message' AND d.message_kind='decision' AND d.sender_type='agent' AND d.sender_id=? AND d.deleted_at IS NULL AND d.resolved_at IS NULL AND NOT EXISTS(SELECT 1 FROM multiremi_conversation_log r WHERE r.reply_to_id=d.id AND r.message_kind='reply' AND r.deleted_at IS NULL) LIMIT 1
```

读取规范消息/回复/决策事实和可见范围；输入连续性、回复来源及通知投影都依赖这些列。

来源：packages/server/src/store/inbox/issue-status.ts:25、packages/server/src/store/repos/tasks-repo.ts:6821。

执行位置 / scope:generation：116 / 1:2。参数见相邻 JSON。

### turn.complete-075 · 1 次 · 校验

```sql
SELECT m.id FROM multiremi_turns t JOIN multiremi_conversation_log m ON m.task_id = t.id WHERE t.issue_id = ? AND m.kind = 'message' AND m.message_kind = 'decision' AND m.deleted_at IS NULL AND m.resolved_at IS NULL UNION SELECT m.id FROM multiremi_issue_sessions s JOIN multiremi_conversation_log m ON m.session_id = s.id WHERE s.issue_id = ? AND m.kind = 'message' AND m.message_kind = 'decision' AND m.deleted_at IS NULL AND m.resolved_at IS NULL
```

核对 turn/current attempt、终态状态、输入水位或派生轮卡；写入后、取得新锁后及异步新快照必须重读。

来源：packages/server/src/store/repos/issues-repo.ts:580、packages/server/src/store/inbox/issue-status.ts:29。

执行位置 / scope:generation：117 / 1:2。参数见相邻 JSON。

### turn.complete-076 · 1 次 · 校验

```sql
SELECT COUNT(*) AS open_children FROM multiremi_issues child JOIN multiremi_issues parent ON parent.id = child.parent_issue_id AND parent.workspace_id = child.workspace_id WHERE child.parent_issue_id = ? AND child.status NOT IN ('done', 'cancelled')
```

核对 Issue 归属、父子状态与执行负责人，完成一个 turn 不等于整个 Issue 已完成。

来源：packages/server/src/store/repos/issues-repo.ts:1491、packages/server/src/store/repos/issues-repo.ts:3432。

执行位置 / scope:generation：118 / 1:2。参数见相邻 JSON。

### turn.complete-077 · 1 次 · 必要写入

```sql
UPDATE multiremi_issues SET status=?,completed_at=?,archived_at=NULL,updated_at=? WHERE id=?
```

保存 issues 的业务变更，后续通知、回放和派活必须观察提交后的事实。

来源：packages/server/src/store/inbox/issue-status.ts:51、packages/server/src/store/repos/tasks-repo.ts:6821。

执行位置 / scope:generation：119 / 1:2。参数见相邻 JSON。

### turn.complete-078 · 1 次 · 必要写入

```sql
INSERT INTO multiremi_system_events ( id, workspace_id, resource, event, resource_id, project_id, payload, status, attempt_count, available_at, lease_until, last_error, created_at, processed_at ) VALUES (?, ?, 'issue', 'status_changed', ?, ?, ?, 'pending', 0, ?, NULL, NULL, ?, NULL)
```

持久化/结算可靠通知意图，避免事务提交后通知丢失。

来源：packages/server/src/store/repos/autopilots-repo.ts:1012、packages/server/src/store/inbox/issue-status.ts:54。

执行位置 / scope:generation：121 / 1:2。参数见相邻 JSON。

### turn.complete-079 · 2 次 · 其他

```sql
SELECT * FROM multiremi_system_events WHERE id = ?
```

读取或推进提交后的可靠通知，防止原终态已提交而通知意图丢失。

来源：packages/server/src/store/repos/autopilots-repo.ts:1042、packages/server/src/store/repos/autopilots-repo.ts:1038、packages/server/src/store/repos/issues-repo.ts:4568。

执行位置 / scope:generation：122 / 1:2, 151 / 1:4。参数见相邻 JSON。

### turn.complete-080 · 1 次 · 校验

```sql
SELECT 1 AS present FROM multiremi_turns turns JOIN multiremi_issue_sessions sessions ON sessions.id = turns.session_id WHERE turns.issue_id = ? AND sessions.issue_id = turns.issue_id AND sessions.chat_id IS NULL AND turns.status IN ('pending', 'running', 'awaiting_human') LIMIT 1
```

核对 turn/current attempt、终态状态、输入水位或派生轮卡；写入后、取得新锁后及异步新快照必须重读。

来源：packages/server/src/store/repos/tasks-repo.ts:7344、packages/server/src/store/repos/tasks-repo.ts:7017。

执行位置 / scope:generation：123 / 1:2。参数见相邻 JSON。

### turn.complete-081 · 1 次 · 锁

```sql
UPDATE multiremi_issues SET lifecycle_state = lifecycle_state WHERE id = ?
```

取得 workspace/Session/Issue/turn 的数据库互斥；不同外层事务或不同 lane 不能共享锁，删除会改变 PG 竞争下的校验顺序。

来源：packages/server/src/store/context.ts:1102、packages/server/src/store/repos/issue-sessions-repo.ts:298。

执行位置 / scope:generation：124 / 1:2。参数见相邻 JSON。

### turn.complete-082 · 1 次 · 校验

```sql
SELECT s.*, ( SELECT COUNT(*) FROM multiremi_conversation_log e WHERE e.session_id = s.parent_session_id AND e.kind <> 'head' AND e.seq > 0 AND ((s.inherit_mode = 'follow' AND (s.follow_frozen_seq IS NULL OR e.seq <= s.follow_frozen_seq)) OR (s.inherit_mode <> 'follow' AND e.seq <= s.inherit_cutoff_seq)) ) AS inherited_event_count FROM multiremi_issue_sessions s WHERE s.chat_id IS NULL AND s.issue_id = ? AND s.is_default = 1 LIMIT 1
```

读取规范消息/回复/决策事实和可见范围；输入连续性、回复来源及通知投影都依赖这些列。

来源：packages/server/src/store/repos/issue-sessions-repo.ts:304、packages/server/src/store/repos/tasks-repo.ts:6642。

执行位置 / scope:generation：126 / 1:2。参数见相邻 JSON。

### turn.complete-083 · 1 次 · 其他

```sql
SELECT c.id, c.agent_id, b.id AS binding_id FROM multiremi_feishu_bot_chat_bindings b JOIN multiremi_chat_sessions c ON c.id = b.chat_session_id WHERE b.issue_id = ? AND b.workspace_id = ? AND c.workspace_id = ? AND c.status <> 'archived' ORDER BY b.updated_at DESC, b.created_at DESC, b.id DESC
```

验证 Chat/Issue/bot 的绑定及外部投递目标，不能把普通私聊误判为 Topic。

来源：packages/server/src/store/repos/inbox-repo.ts:156、packages/server/src/store/repos/inbox-repo.ts:43。

执行位置 / scope:generation：128 / 1:2。参数见相邻 JSON。

### turn.complete-084 · 1 次 · 其他

```sql
SELECT * FROM multiremi_feishu_bot_configs WHERE workspace_id = ? ORDER BY created_at, bot_id
```

读取 bot 配置和所有权；下行快照与终态卡片/文本均须采用当前绑定。

来源：packages/server/src/store/repos/feishu-bot-repo.ts:266、packages/server/src/store/store.ts:2461。

执行位置 / scope:generation：130 / 1:2。参数见相邻 JSON。

### turn.complete-085 · 5 次 · 其他

```sql
SELECT * FROM multiremi_feishu_bot_configs WHERE workspace_id = ? AND bot_id = ?
```

读取 bot 配置和所有权；下行快照与终态卡片/文本均须采用当前绑定。

来源：packages/server/src/store/request-read-cache.ts:182、packages/server/src/store/repos/feishu-bot-repo.ts:435、packages/server/src/store/repos/feishu-bot-repo.ts:3542。

执行位置 / scope:generation：131 / 1:2, 168 / None:None, 186 / None:None, 203 / 4:0, 209 / 5:0。参数见相邻 JSON。

### turn.complete-086 · 1 次 · 其他

```sql
SELECT b.* FROM multiremi_feishu_bot_chat_bindings b JOIN multiremi_chat_sessions c ON c.id = b.chat_session_id WHERE b.workspace_id = ? AND b.bot_id = ? AND b.app_id = ? AND b.issue_id = ? AND c.status = 'active' AND b.chat_id IS NOT NULL AND b.reply_to_message_id IS NOT NULL ORDER BY b.updated_at DESC, b.created_at DESC, b.id DESC
```

验证 Chat/Issue/bot 的绑定及外部投递目标，不能把普通私聊误判为 Topic。

来源：packages/server/src/store/repos/feishu-bot-repo.ts:2856、packages/server/src/store/repos/tasks-repo.ts:6654。

执行位置 / scope:generation：132 / 1:2。参数见相邻 JSON。

### turn.complete-087 · 1 次 · 校验

```sql
SELECT DISTINCT sessions.issue_id FROM multiremi_conversation_log messages JOIN multiremi_issue_sessions sessions ON sessions.id = messages.session_id WHERE messages.task_id = ? AND messages.kind = 'message' AND messages.sender_type = 'agent' AND messages.sender_id = ? AND messages.message_kind IN ('request', 'reply', 'final') AND messages.deleted_at IS NULL AND sessions.chat_id IS NULL AND sessions.issue_id <> ? ORDER BY sessions.issue_id
```

读取规范消息/回复/决策事实和可见范围；输入连续性、回复来源及通知投影都依赖这些列。

来源：packages/server/src/store/repos/tasks-repo.ts:6841、packages/server/src/store/repos/tasks-repo.ts:5457。

执行位置 / scope:generation：133 / 1:2。参数见相邻 JSON。

### turn.complete-088 · 1 次 · 必要写入

```sql
UPDATE multiremi_conversation_log SET message_kind=? WHERE id=(SELECT reply_message_id FROM multiremi_turns WHERE id=?)
```

持久化规范回复/可见性/决策元数据或递增 revision，供重放及浏览器补读。

来源：packages/server/src/store/repos/tasks-repo.ts:5459、packages/server/src/store/turn-execution-records.ts:142。

执行位置 / scope:generation：134 / 1:2。参数见相邻 JSON。

### turn.complete-089 · 1 次 · 校验

```sql
SELECT event_count, tool_call_count, type_histogram, model, context_usage, worked_ms, process_item_count, late_subagents FROM multiremi_turn_attempts WHERE id = ?
```

核对 turn/current attempt、终态状态、输入水位或派生轮卡；写入后、取得新锁后及异步新快照必须重读。

来源：packages/server/src/store/store.ts:4698、packages/server/src/store/repos/tasks-repo.ts:5460。

执行位置 / scope:generation：135 / 1:2。参数见相邻 JSON。

### turn.complete-090 · 1 次 · 必要写入

```sql
UPDATE multiremi_turn_attempts SET tool_call_count=?,event_count=?,type_histogram=?,model=?,context_usage=?,worked_ms=?,process_item_count=?,late_subagents=? WHERE id=?
```

持久化 attempt 终态、输入收据/offer 水位或最终 trace 事实；后续重放必须读取持久化的新值。

来源：packages/server/src/store/repos/conversation-log-repo.ts:829、packages/server/src/store/store.ts:4730。

执行位置 / scope:generation：136 / 1:2。参数见相邻 JSON。

### turn.complete-091 · 1 次 · 校验

```sql
SELECT session_id,seq FROM multiremi_turns WHERE id=?
```

核对 turn/current attempt、终态状态、输入水位或派生轮卡；写入后、取得新锁后及异步新快照必须重读。

来源：packages/server/src/store/repos/conversation-log-repo.ts:134、packages/server/src/store/turn-execution-records.ts:144。

执行位置 / scope:generation：137 / 1:2。参数见相邻 JSON。

### turn.complete-092 · 1 次 · 必要写入

```sql
UPDATE multiremi_conversation_log SET revision=revision+?,updated_at=? WHERE session_id=? AND seq=?
```

持久化规范回复/可见性/决策元数据或递增 revision，供重放及浏览器补读。

来源：packages/server/src/store/repos/conversation-log-repo.ts:136、packages/server/src/store/turn-execution-records.ts:144。

执行位置 / scope:generation：138 / 1:2。参数见相邻 JSON。

### turn.complete-093 · 1 次 · 必要写入

```sql
UPDATE multiremi_conversation_heads SET log_version=log_version+?,updated_at=? WHERE session_id=?
```

原子分配消息 seq 或递增 log_version，不能用进程内计数替代。

来源：packages/server/src/store/repos/conversation-log-repo.ts:137、packages/server/src/store/turn-execution-records.ts:144。

执行位置 / scope:generation：139 / 1:2。参数见相邻 JSON。

### turn.complete-094 · 1 次 · 校验

```sql
SELECT t.*,a.status AS attempt_status,a.attempt_no,a.failure_reason,a.progress_summary,a.event_count, a.tool_call_count,a.type_histogram,a.model,a.trace_ref,a.usage,a.started_at AS attempt_started_at,a.ended_at AS attempt_ended_at, a.context_usage,a.worked_ms,a.process_item_count,a.late_subagents FROM multiremi_turns t LEFT JOIN multiremi_turn_attempts a ON a.id=t.current_attempt_id WHERE t.id=?
```

核对 turn/current attempt、终态状态、输入水位或派生轮卡；写入后、取得新锁后及异步新快照必须重读。

来源：packages/server/src/store/turn-attempts.ts:82、packages/server/src/store/repos/conversation-log-repo.ts:139。

执行位置 / scope:generation：141 / 1:2。参数见相邻 JSON。

### turn.complete-095 · 1 次 · 校验

```sql
SELECT body_md FROM multiremi_conversation_log WHERE id=?
```

读取规范消息/回复/决策事实和可见范围；输入连续性、回复来源及通知投影都依赖这些列。

来源：packages/server/src/store/turn-attempts.ts:84、packages/server/src/store/repos/conversation-log-repo.ts:139。

执行位置 / scope:generation：142 / 1:2。参数见相邻 JSON。

### turn.complete-096 · 1 次 · 校验

```sql
SELECT a.turn_id AS task_id,u.provider,COALESCE(u.model,u.requested_model,'unknown') AS model, SUM(COALESCE(input_tokens,0)) AS input_tokens,SUM(COALESCE(output_tokens,0)) AS output_tokens, SUM(COALESCE(cache_read_tokens,0)) AS cache_read_tokens,SUM(COALESCE(cache_write_tokens,0)) AS cache_write_tokens, SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)+COALESCE(cache_read_tokens,0)+COALESCE(cache_write_tokens,0)+COALESCE(actual_unsplit_tokens,0)) AS total_tokens FROM multiremi_usage_units u JOIN multiremi_turn_attempts a ON a.id=u.task_id WHERE a.turn_id IN (?) AND source<>'context_snapshot' AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL OR cache_read_tokens IS NOT NULL OR cache_write_tokens IS NOT NULL OR actual_unsplit_tokens IS NOT NULL) GROUP BY a.turn_id,u.provider,COALESCE(u.model,u.requested_model,'unknown') ORDER BY task_id,u.provider,model
```

核对 turn/current attempt、终态状态、输入水位或派生轮卡；写入后、取得新锁后及异步新快照必须重读。

来源：packages/server/src/store/request-read-cache.ts:182、packages/server/src/store/usage-projection.ts:21。

执行位置 / scope:generation：143 / 1:2。参数见相邻 JSON。

### turn.complete-097 · 1 次 · 其他

```sql
SELECT runtime_id FROM multiremi_turn_execution_records WHERE workspace_id=? AND runtime_id IS NOT NULL AND status IN ('dispatched','running','waiting_local_directory','awaiting_human') UNION SELECT runtime_id FROM multiremi_feishu_bot_configs WHERE workspace_id=? AND runtime_id IS NOT NULL UNION SELECT runtime_id FROM multiremi_feishu_bot_runtime_states WHERE workspace_id=? AND (state<>'stopped' OR release_pending=1) UNION SELECT runtime_id FROM multiremi_background_tasks WHERE workspace_id=? AND lane_state<>'closed' UNION SELECT r.id AS runtime_id FROM multiremi_runtimes r JOIN multiremi_daemon_drains d ON d.workspace_id=COALESCE(r.workspace_id,'local') AND d.daemon_id=COALESCE(r.daemon_id,r.id) WHERE d.workspace_id=?
```

一次集合查询计算活跃 attempt、bot、驻留任务和 drain 的消费者；保留跨宿主通知而避免全 runtime 派活。

来源：packages/server/src/store/repos/runtimes-repo.ts:584、packages/server/src/store/request-read-cache.ts:182。

执行位置 / scope:generation：145 / 1:2。参数见相邻 JSON。

### turn.complete-098 · 1 次 · 其他

```sql
SELECT * FROM multiremi_issue_subscribers WHERE issue_id = ? ORDER BY created_at ASC
```

确定 Issue 订阅人，维持提交后的通知范围。

来源：packages/server/src/store/repos/issues-repo.ts:5251、packages/server/src/store/repos/issues-repo.ts:6337。

执行位置 / scope:generation：146 / 1:2。参数见相邻 JSON。

### turn.complete-099 · 1 次 · 校验

```sql
SELECT member.* FROM multiremi_workspace_members member JOIN multiremi_workspaces workspace ON workspace.id = member.workspace_id WHERE member.workspace_id = ? AND member.user_id = 'local' ORDER BY CASE WHEN member.id = ? THEN 0 ELSE 1 END, member.created_at, member.id LIMIT 1
```

确定共享操作者、作者与通知收件人，不能用 agent 或缓存的用户身份替代。

来源：packages/server/src/store/repos/workspaces-repo.ts:138、packages/server/src/store/repos/issues-repo.ts:5252。

执行位置 / scope:generation：147 / 1:2。参数见相邻 JSON。

### turn.complete-100 · 1 次 · 其他

```sql
SELECT workspace_id FROM multiremi_system_events WHERE id = ?
```

读取或推进提交后的可靠通知，防止原终态已提交而通知意图丢失。

来源：packages/server/src/store/repos/issues-repo.ts:4559、packages/server/src/store/request-read-cache.ts:293。

执行位置 / scope:generation：148 / 1:3。参数见相邻 JSON。

### turn.complete-101 · 1 次 · 必要写入

```sql
UPDATE multiremi_system_events SET status = 'processed', processed_at = ?, lease_until = NULL WHERE id = ? AND status = 'pending'
```

持久化/结算可靠通知意图，避免事务提交后通知丢失。

来源：packages/server/src/store/repos/issues-repo.ts:4565、packages/server/src/store/request-read-cache.ts:293。

执行位置 / scope:generation：150 / 1:4。参数见相邻 JSON。

### turn.complete-102 · 1 次 · 校验

```sql
SELECT seq FROM multiremi_conversation_log WHERE id = ? AND kind IN ('message', 'system') LIMIT 1
```

读取规范消息/回复/决策事实和可见范围；输入连续性、回复来源及通知投影都依赖这些列。

来源：packages/server/src/store/repos/issues-repo.ts:6245、packages/server/src/store/repos/issues-repo.ts:4593。

执行位置 / scope:generation：157 / 1:4。参数见相邻 JSON。

### turn.complete-103 · 1 次 · 校验

```sql
SELECT * FROM multiremi_turns WHERE id=? OR current_attempt_id=?
```

核对 turn/current attempt、终态状态、输入水位或派生轮卡；写入后、取得新锁后及异步新快照必须重读。

来源：packages/server/src/store/repos/issues-repo.ts:6401、packages/server/src/store/repos/issues-repo.ts:4594。

执行位置 / scope:generation：158 / 1:4。参数见相邻 JSON。

### turn.complete-104 · 1 次 · 必要写入

```sql
UPDATE multiremi_system_events SET last_error = NULL WHERE id = ?
```

持久化/结算可靠通知意图，避免事务提交后通知丢失。

来源：packages/server/src/store/repos/issues-repo.ts:4599、packages/server/src/store/request-read-cache.ts:293。

执行位置 / scope:generation：160 / 1:4。参数见相邻 JSON。

### turn.complete-105 · 1 次 · 其他

```sql
SELECT DISTINCT runtime_id FROM multiremi_turn_execution_records WHERE workspace_id = ? AND status IN ('queued', 'dispatched')
```

集合计算有待派任务的宿主；没有待派任务的宿主不唤醒，不能删掉资格筛选。

来源：packages/server/src/store/repos/tasks-repo.ts:3341、packages/server/src/store/request-read-cache.ts:182。

执行位置 / scope:generation：161 / 1:4。参数见相邻 JSON。

### turn.complete-106 · 1 次 · 校验

```sql
SELECT runtime.*, profile.display_name AS daemon_display_name, drain.daemon_id AS draining_daemon_id FROM multiremi_runtimes runtime LEFT JOIN multiremi_daemon_drains drain ON drain.workspace_id = COALESCE(runtime.workspace_id, 'local') AND drain.daemon_id = COALESCE(runtime.daemon_id, runtime.id) LEFT JOIN multiremi_daemon_profiles profile ON profile.workspace_id = COALESCE(runtime.workspace_id, 'local') AND profile.daemon_id = runtime.daemon_id WHERE runtime.id IN (?)
```

确认当前宿主身份、物理 daemon 和 drain fence；异步下行每次同步段重新取快照。

来源：packages/server/src/store/request-read-cache.ts:182、packages/server/src/store/repos/runtimes-repo.ts:553。

执行位置 / scope:generation：162 / 1:4。参数见相邻 JSON。

### turn.complete-107 · 1 次 · 其他

```sql
SELECT id FROM multiremi_feishu_bot_outbound_deliveries WHERE task_id = ? AND kind = 'cot' AND delivery_mode = 'split'
```

检查出站租约、重试、去重及待投递实体，保持重放、消息顺序与最终状态。

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3055、packages/server/src/store/store.ts:2477。

执行位置 / scope:generation：163 / 1:4。参数见相邻 JSON。

### turn.complete-108 · 1 次 · 校验

```sql
SELECT reply_message_id FROM multiremi_turns WHERE id=?
```

核对 turn/current attempt、终态状态、输入水位或派生轮卡；写入后、取得新锁后及异步新快照必须重读。

来源：packages/server/src/store/inbox/daemon-turn-bridge.ts:251、packages/server/src/api/daemon-protocol/report-handlers.ts:216。

执行位置 / scope:generation：165 / 1:4。参数见相邻 JSON。

### turn.complete-109 · 4 次 · 其他

```sql
SELECT bot_id FROM multiremi_feishu_bot_configs WHERE workspace_id = ? AND runtime_id = ?
```

读取 bot 配置和所有权；下行快照与终态卡片/文本均须采用当前绑定。

来源：packages/server/src/store/repos/feishu-bot-repo.ts:277、packages/server/src/store/store.ts:2510、packages/server/src/store/store.ts:2505。

执行位置 / scope:generation：167 / None:None, 184 / None:None, 201 / 4:0, 208 / 5:0。参数见相邻 JSON。

### turn.complete-110 · 1 次 · 其他

```sql
SELECT MIN(wake_at) AS wake_at FROM ( SELECT available_at AS wake_at FROM multiremi_feishu_bot_outbound_deliveries WHERE workspace_id = ? AND status = 'pending' AND available_at > ? UNION ALL SELECT leased_until AS wake_at FROM multiremi_feishu_bot_outbound_deliveries WHERE workspace_id = ? AND status = 'sending' AND leased_until > ? ) deadlines
```

检查出站租约、重试、去重及待投递实体，保持重放、消息顺序与最终状态。

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3551、packages/server/src/api/server.ts:1241。

执行位置 / scope:generation：169 / None:None。参数见相邻 JSON。

### turn.complete-111 · 1 次 · 校验

```sql
SELECT request.created_at, request.expires_at FROM multiremi_message_question_records request JOIN multiremi_turn_execution_records task ON task.id = request.task_id WHERE task.workspace_id = ? AND task.issue_id IS NOT NULL AND request.status = 'pending' AND request.reminder_sent_at IS NULL AND request.expires_at IS NOT NULL AND EXISTS (SELECT 1 FROM multiremi_feishu_bot_outbound_deliveries delivery WHERE delivery.human_request_id = request.id AND delivery.kind = 'decision_card' AND delivery.status = 'sent' AND delivery.external_message_id IS NOT NULL AND delivery.degraded IS NULL)
```

读取规范 turn/attempt 执行投影的身份、状态、lineage 或通知事实；窄 guard 与完整 task/终态投影使用不同列和提交时刻。

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3560、packages/server/src/api/server.ts:1241。

执行位置 / scope:generation：170 / None:None。参数见相邻 JSON。

### turn.complete-112 · 1 次 · 校验

```sql
SELECT MAX(delivery.sent_at) AS sent_at FROM multiremi_message_question_records request JOIN multiremi_turn_execution_records task ON task.id=request.task_id JOIN multiremi_conversation_log message ON message.id=request.id JOIN multiremi_feishu_bot_outbound_deliveries delivery ON delivery.human_request_id=request.id JOIN multiremi_feishu_bot_chat_bindings binding ON binding.id=delivery.binding_id AND binding.workspace_id=delivery.workspace_id WHERE task.workspace_id=? AND task.issue_id IS NOT NULL AND request.status='pending' AND binding.bot_id=? AND binding.app_id=? AND request.reminder_sent_at IS NULL AND request.expires_at IS NULL AND CAST(json_extract(CASE WHEN json_valid(message.metadata) THEN message.metadata ELSE '{}' END,'$.question.version') AS TEXT)='1' AND delivery.kind='decision_card' AND delivery.status='sent' AND delivery.external_message_id IS NOT NULL AND delivery.degraded IS NULL GROUP BY request.id
```

读取规范 turn/attempt 执行投影的身份、状态、lineage 或通知事实；窄 guard 与完整 task/终态投影使用不同列和提交时刻。

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3578、packages/server/src/api/server.ts:1241。

执行位置 / scope:generation：171 / None:None。参数见相邻 JSON。

### turn.complete-113 · 2 次 · 校验

```sql
SELECT drain.deadline FROM multiremi_runtimes runtime JOIN multiremi_daemon_drains drain ON drain.workspace_id = COALESCE(runtime.workspace_id, 'local') AND drain.daemon_id = COALESCE(runtime.daemon_id, runtime.id) WHERE runtime.id = ?
```

确认当前宿主身份、物理 daemon 和 drain fence；异步下行每次同步段重新取快照。

来源：packages/server/src/store/store.ts:3507、packages/server/src/api/server.ts:1241。

执行位置 / scope:generation：172 / None:None, 187 / None:None。参数见相邻 JSON。

### turn.complete-114 · 2 次 · 校验

```sql
SELECT id, status, runtime_id, agent_id FROM multiremi_turn_execution_records WHERE status IN (?, ?, ?, ?) AND runtime_id = ? ORDER BY created_at DESC
```

读取规范 turn/attempt 执行投影的身份、状态、lineage 或通知事实；窄 guard 与完整 task/终态投影使用不同列和提交时刻。

来源：packages/server/src/store/repos/tasks-repo.ts:3160、packages/server/src/api/daemon-protocol/task-input-snapshot.ts:9。

执行位置 / scope:generation：174 / 2:0, 189 / 3:0。参数见相邻 JSON。

### turn.complete-115 · 2 次 · 校验

```sql
SELECT id, workspace_id, runtime_id, status, agent_id, chat_session_id, issue_id, issue_session_id FROM multiremi_turn_execution_records WHERE id IN (SELECT value FROM json_each(?))
```

读取规范 turn/attempt 执行投影的身份、状态、lineage 或通知事实；窄 guard 与完整 task/终态投影使用不同列和提交时刻。

来源：packages/server/src/store/repos/tasks-repo.ts:2714、packages/server/src/api/daemon-protocol/task-input-snapshot.ts:13。

执行位置 / scope:generation：175 / 2:0, 190 / 3:0。参数见相邻 JSON。

### turn.complete-116 · 2 次 · 必要写入

```sql
INSERT INTO multiremi_session_lanes (session_id,reader_type,reader_id,execution_scope,created_at,updated_at) SELECT t.session_id,'agent',t.agent_id,t.execution_scope,?,? FROM multiremi_turns t JOIN multiremi_turn_attempts a ON a.turn_id=t.id WHERE a.id IN (SELECT value FROM json_each(?)) AND t.current_attempt_id=a.id AND t.workspace_id=? AND a.runtime_id=? AND t.status IN ('running','awaiting_human') ORDER BY t.session_id,t.agent_id,t.execution_scope ON CONFLICT(session_id,reader_type,reader_id,execution_scope) DO UPDATE SET updated_at=multiremi_session_lanes.updated_at
```

创建/推进 lane 或保存暂停状态；既是并发边界也是可恢复的消费水位。

来源：packages/server/src/store/inbox/daemon-turn-bridge.ts:126、packages/server/src/store/request-read-cache.ts:293。

执行位置 / scope:generation：178 / 2:2, 193 / 3:2。参数见相邻 JSON。

### turn.complete-117 · 2 次 · 其他

```sql
SELECT t.*,a.id AS snapshot_attempt_id, a.input_ack_seq,a.input_read_seq,a.session_id AS provider_session_id, l.cursor_seq AS lane_cursor,COALESCE(h.head_seq,0) AS snapshot_head FROM multiremi_turns t JOIN multiremi_turn_attempts a ON a.turn_id=t.id JOIN multiremi_session_lanes l ON l.session_id=t.session_id AND l.reader_type='agent' AND l.reader_id=t.agent_id AND l.execution_scope=t.execution_scope LEFT JOIN multiremi_conversation_heads h ON h.session_id=t.session_id WHERE a.id IN (SELECT value FROM json_each(?)) AND t.current_attempt_id=a.id AND t.workspace_id=? AND a.runtime_id=? AND t.status IN ('running','awaiting_human')
```

集合生成全部活 attempt 的输入快照，关联 lane/head/日志窗口；删除会遗漏并发轮的中断输入或 wrap-up。

来源：packages/server/src/store/inbox/daemon-turn-bridge.ts:140、packages/server/src/store/request-read-cache.ts:293。

执行位置 / scope:generation：179 / 2:2, 194 / 3:2。参数见相邻 JSON。

### turn.complete-118 · 2 次 · 必要写入

```sql
UPDATE multiremi_turn_attempts SET input_ack_seq=CASE WHEN COALESCE(session_id,'')='' THEN 0 ELSE COALESCE((SELECT l.cursor_seq FROM multiremi_session_lanes l JOIN multiremi_turns t ON t.session_id=l.session_id AND t.agent_id=l.reader_id AND t.execution_scope=l.execution_scope WHERE t.id=multiremi_turn_attempts.turn_id AND l.reader_type='agent'),0) END, input_read_seq=CASE WHEN COALESCE(session_id,'')='' THEN 0 ELSE COALESCE((SELECT l.cursor_seq FROM multiremi_session_lanes l JOIN multiremi_turns t ON t.session_id=l.session_id AND t.agent_id=l.reader_id AND t.execution_scope=l.execution_scope WHERE t.id=multiremi_turn_attempts.turn_id AND l.reader_type='agent'),0) END, input_read_offset=0 WHERE id IN (SELECT value FROM json_each(?)) AND input_ack_seq IS NULL
```

持久化 attempt 终态、输入收据/offer 水位或最终 trace 事实；后续重放必须读取持久化的新值。

来源：packages/server/src/store/inbox/daemon-turn-bridge.ts:145、packages/server/src/store/request-read-cache.ts:293。

执行位置 / scope:generation：180 / 2:2, 195 / 3:2。参数见相邻 JSON。

### turn.complete-119 · 2 次 · 其他

```sql
SELECT e.*,a.id AS snapshot_attempt_id FROM multiremi_turn_attempts a JOIN multiremi_turns t ON t.id=a.turn_id JOIN multiremi_conversation_log e ON e.session_id=t.session_id WHERE a.id IN (SELECT value FROM json_each(?)) AND e.seq>a.input_ack_seq AND e.seq<=COALESCE((SELECT h.head_seq FROM multiremi_conversation_heads h WHERE h.session_id=t.session_id),0) AND e.kind='message' AND e.deleted_at IS NULL AND e.visibility='shown' ORDER BY a.id,e.seq
```

集合生成全部活 attempt 的输入快照，关联 lane/head/日志窗口；删除会遗漏并发轮的中断输入或 wrap-up。

来源：packages/server/src/store/inbox/daemon-turn-bridge.ts:162、packages/server/src/store/request-read-cache.ts:293。

执行位置 / scope:generation：181 / 2:2, 196 / 3:2。参数见相邻 JSON。

### turn.complete-120 · 2 次 · 必要写入

```sql
UPDATE multiremi_turn_attempts SET projection_to_seq=CASE WHEN COALESCE(projection_to_seq,0)<COALESCE((SELECT h.head_seq FROM multiremi_turns t JOIN multiremi_conversation_heads h ON h.session_id=t.session_id WHERE t.id=multiremi_turn_attempts.turn_id),0) THEN (SELECT h.head_seq FROM multiremi_turns t JOIN multiremi_conversation_heads h ON h.session_id=t.session_id WHERE t.id=multiremi_turn_attempts.turn_id) ELSE projection_to_seq END WHERE id IN (SELECT value FROM json_each(?))
```

持久化 attempt 终态、输入收据/offer 水位或最终 trace 事实；后续重放必须读取持久化的新值。

来源：packages/server/src/store/inbox/daemon-turn-bridge.ts:175、packages/server/src/store/request-read-cache.ts:293。

执行位置 / scope:generation：182 / 2:2, 197 / 3:2。参数见相邻 JSON。

### turn.complete-121 · 2 次 · 其他

```sql
SELECT bot_id FROM multiremi_feishu_bot_runtime_states WHERE workspace_id = ? AND runtime_id = ? AND (state <> 'stopped' OR release_pending = 1) ORDER BY reported_at DESC LIMIT 1
```

确定 bot 的真实宿主与在线状态，保留旧宿主停止确认和接管边界。

来源：packages/server/src/store/repos/feishu-bot-repo.ts:285、packages/server/src/store/store.ts:2510、packages/server/src/store/store.ts:2505。

执行位置 / scope:generation：185 / None:None, 202 / 4:0。参数见相邻 JSON。

### turn.complete-122 · 2 次 · 其他

```sql
SELECT 'update' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_update_requests WHERE runtime_id = ? AND status = 'pending' AND updated_at >= '2026-11-17T11:58:00.000Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_runtime_update_requests WHERE runtime_id = ? AND ((status = 'pending' AND updated_at < '2026-11-17T11:58:00.000Z') OR (status IN ('running', 'restarting', 'verifying') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T11:40:00.000Z'))) AS sweep, FALSE AS housekeeping UNION ALL SELECT 'model_list' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_model_list_requests WHERE runtime_id = ? AND status = 'pending' AND created_at >= '2026-11-17T11:59:30.000Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_runtime_model_list_requests WHERE runtime_id = ? AND ((status = 'pending' AND created_at < '2026-11-17T11:59:30.000Z') OR (status IN ('running') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T11:59:00.000Z'))) AS sweep, FALSE AS housekeeping UNION ALL SELECT 'command' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_command_requests WHERE runtime_id = ? AND status = 'pending' AND created_at >= '2026-11-17T11:57:00.000Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_runtime_command_requests WHERE runtime_id = ? AND ((status = 'pending' AND created_at < '2026-11-17T11:57:00.000Z') OR (status IN ('running') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T11:40:00.000Z'))) AS sweep, EXISTS (SELECT 1 FROM multiremi_runtime_command_requests WHERE runtime_id = ? AND status IN ('completed', 'failed', 'timeout') AND (command <> '' OR args <> '[]')) AS housekeeping UNION ALL SELECT 'local_skills' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_local_skill_list_requests WHERE runtime_id = ? AND status = 'pending' AND created_at >= '2026-11-17T11:57:00.000Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_runtime_local_skill_list_requests WHERE runtime_id = ? AND ((status = 'pending' AND created_at < '2026-11-17T11:57:00.000Z') OR (status IN ('running') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T11:59:00.000Z'))) AS sweep, FALSE AS housekeeping UNION ALL SELECT 'local_skill_import' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_local_skill_import_requests WHERE runtime_id = ? AND status = 'pending' AND created_at >= '2026-11-17T11:57:00.000Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_runtime_local_skill_import_requests WHERE runtime_id = ? AND ((status = 'pending' AND created_at < '2026-11-17T11:57:00.000Z') OR (status IN ('running') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T11:59:00.000Z'))) AS sweep, FALSE AS housekeeping UNION ALL SELECT 'gc_run' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_gc_run_requests WHERE runtime_id = ? AND status = 'pending' AND created_at >= '2026-11-17T11:50:00.000Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_runtime_gc_run_requests WHERE runtime_id = ? AND ((status = 'pending' AND created_at < '2026-11-17T11:50:00.000Z') OR (status IN ('running') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T11:50:00.000Z'))) AS sweep, FALSE AS housekeeping UNION ALL SELECT 'bot_menu' AS family, EXISTS (SELECT 1 FROM multiremi_bot_menu_publish_requests WHERE runtime_id = ? AND status = 'pending' AND created_at >= '2026-11-17T11:57:00.000Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_bot_menu_publish_requests WHERE runtime_id = ? AND ((status = 'pending' AND created_at < '2026-11-17T11:57:00.000Z') OR (status IN ('running') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T11:55:00.000Z'))) AS sweep, FALSE AS housekeeping UNION ALL SELECT 'directory_scan' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_directory_scan_requests WHERE runtime_id = ? AND status = 'pending' AND created_at >= '2026-11-17T11:57:00.000Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_runtime_directory_scan_requests WHERE runtime_id = ? AND ((status = 'pending' AND created_at < '2026-11-17T11:57:00.000Z') OR (status IN ('running') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T11:59:00.000Z'))) AS sweep, FALSE AS housekeeping
```

一次 union/EXISTS 读取所有 runtime 命令族的可领取状态；查询含当前时间边界，不与不同时间的快照合并。

来源：packages/server/src/store/repos/runtimes-repo.ts:2750、packages/server/src/store/repos/runtimes-repo.ts:2418。

执行位置 / scope:generation：199 / 4:0, 206 / 5:0。参数见相邻 JSON。

### turn.complete-123 · 2 次 · 校验

```sql
SELECT * FROM multiremi_platform_maintenance WHERE id = 'platform'
```

每个下行同步段检查维护闸门；维护期间不得发出更新/外部投递。

来源：packages/server/src/store/repos/platform-maintenance-repo.ts:192、packages/server/src/store/repos/platform-maintenance-repo.ts:41。

执行位置 / scope:generation：200 / 4:0, 207 / 5:0。参数见相邻 JSON。

### turn.complete-124 · 2 次 · 其他

```sql
SELECT * FROM multiremi_feishu_bot_runtime_states WHERE workspace_id = ? AND bot_id = ? AND runtime_id = ?
```

确定 bot 的真实宿主与在线状态，保留旧宿主停止确认和接管边界。

来源：packages/server/src/store/repos/feishu-bot-repo.ts:4182、packages/server/src/store/repos/feishu-bot-repo.ts:3302。

执行位置 / scope:generation：204 / 4:0, 210 / 5:0。参数见相邻 JSON。

### turn.complete-125 · 1 次 · 其他

```sql
SELECT id, operation FROM multiremi_feishu_bot_outbound_operations WHERE workspace_id = ? AND ((status = 'pending' AND available_at <= ?) OR (status = 'processing' AND leased_until <= ?)) ORDER BY created_at, CASE kind WHEN 'topic' THEN 0 WHEN 'round' THEN 1 WHEN 'retarget' THEN 2 WHEN 'human_request' THEN 3 WHEN 'round_delivery' THEN 4 ELSE 5 END, id LIMIT 32
```

读取可执行或租约过期的外部操作，保留可靠出站操作的恢复。

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3123、packages/server/src/store/repos/feishu-bot-repo.ts:3309。

执行位置 / scope:generation：211 / 5:0。参数见相邻 JSON。

### turn.complete-126 · 1 次 · 校验

```sql
SELECT decision.id, decision.issue_id FROM multiremi_message_decision_records decision JOIN multiremi_issues issue ON issue.id = decision.issue_id WHERE decision.status = 'escalated' AND decision.reminder_sent_at IS NULL AND issue.workspace_id = ? AND ( SELECT o.sent_at FROM multiremi_feishu_bot_outbound_deliveries o JOIN multiremi_feishu_bot_chat_bindings b ON b.id = o.binding_id WHERE o.kind = 'decision_card' AND o.decision_id = decision.id AND b.bot_id = ? AND o.status = 'sent' AND o.external_message_id IS NOT NULL AND o.degraded IS NULL AND o.sent_at IS NOT NULL ORDER BY o.created_at DESC, o.id DESC LIMIT 1 ) <= ? ORDER BY decision.id ASC
```

确定需要更新/提醒的决策记录，保留升级链和决策状态。

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3318、packages/server/src/store/request-read-cache.ts:293。

执行位置 / scope:generation：213 / 5:2。参数见相邻 JSON。

### turn.complete-127 · 1 次 · 其他

```sql
SELECT id, kind FROM multiremi_feishu_bot_outbound_deliveries WHERE workspace_id = ? AND delivery_mode = 'split' AND attempt_count >= 6 AND binding_id IN (SELECT id FROM multiremi_feishu_bot_chat_bindings WHERE workspace_id = ? AND bot_id = ?) AND ((status = 'pending' AND available_at <= ?) OR (status = 'sending' AND leased_until <= ?))
```

检查出站租约、重试、去重及待投递实体，保持重放、消息顺序与最终状态。

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3325、packages/server/src/store/request-read-cache.ts:293。

执行位置 / scope:generation：214 / 5:2。参数见相邻 JSON。

### turn.complete-128 · 1 次 · 校验

```sql
SELECT request.id, request.task_id, request.expires_at, request.created_at, (SELECT MAX(card.sent_at) FROM multiremi_feishu_bot_outbound_deliveries card WHERE card.human_request_id=request.id AND card.kind='decision_card' AND card.status='sent' AND card.external_message_id IS NOT NULL AND card.degraded IS NULL) AS card_sent_at FROM multiremi_message_question_records request JOIN multiremi_turn_execution_records task ON task.id = request.task_id JOIN multiremi_conversation_log message ON message.id=request.id WHERE request.status = 'pending' AND request.reminder_sent_at IS NULL -- A reminder is worth sending only while it still leaves the reader -- time to act: under a minute of lifetime left, the nudge would arrive -- as the request expires. The bound is the same expression the CAS and -- the claim use, so SQLite and Postgres agree. AND (request.expires_at >= ? OR (request.expires_at IS NULL AND CAST(json_extract(CASE WHEN json_valid(message.metadata) THEN message.metadata ELSE '{}' END,'$.question.version') AS TEXT)='1' AND EXISTS (SELECT 1 FROM multiremi_feishu_bot_outbound_deliveries card WHERE card.human_request_id=request.id AND card.kind='decision_card' AND card.status='sent' AND card.external_message_id IS NOT NULL AND card.degraded IS NULL AND card.sent_at<=?))) AND task.issue_id IS NOT NULL AND task.workspace_id = ? AND ( SELECT COUNT(*) FROM multiremi_feishu_bot_outbound_deliveries o JOIN multiremi_feishu_bot_chat_bindings b ON b.id = o.binding_id WHERE o.kind = 'decision_card' AND o.human_request_id = request.id AND b.bot_id = ? AND o.status = 'sent' AND o.external_message_id IS NOT NULL AND o.degraded IS NULL ) > 0 ORDER BY request.expires_at ASC, request.id ASC
```

读取规范 turn/attempt 执行投影的身份、状态、lineage 或通知事实；窄 guard 与完整 task/终态投影使用不同列和提交时刻。

来源：packages/server/src/store/repos/feishu-bot-repo.ts:2519、packages/server/src/store/repos/feishu-bot-repo.ts:3334。

执行位置 / scope:generation：215 / 5:2。参数见相邻 JSON。

### turn.complete-129 · 1 次 · 其他

```sql
SELECT d.*, COALESCE(d.outbound_task_id, d.task_id) AS target_task_id, b.chat_id, b.thread_id, s.open_id FROM multiremi_feishu_bot_deliveries d JOIN multiremi_feishu_bot_chat_bindings b ON b.id = d.binding_id AND b.workspace_id = d.workspace_id LEFT JOIN multiremi_feishu_bot_senders s ON s.id = d.sender_id WHERE d.workspace_id = ? AND d.outbound_requested = 1 AND b.chat_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM multiremi_feishu_bot_outbound_deliveries carrier WHERE carrier.task_id = COALESCE(d.outbound_task_id, d.task_id) AND (carrier.kind IS NULL OR carrier.kind = 'cot') AND carrier.unit_key = '') AND NOT EXISTS (SELECT 1 FROM multiremi_feishu_bot_deliveries earlier WHERE COALESCE(earlier.outbound_task_id, earlier.task_id) = COALESCE(d.outbound_task_id, d.task_id) AND earlier.outbound_requested = 1 AND (earlier.created_at < d.created_at OR (earlier.created_at = d.created_at AND earlier.external_message_id < d.external_message_id))) ORDER BY d.created_at, d.external_message_id LIMIT 32
```

读取外部消息来源、reply/thread 和投递任务，不能构造脱离原会话的回复。

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3196、packages/server/src/store/repos/feishu-bot-repo.ts:3336。

执行位置 / scope:generation：216 / 5:2。参数见相邻 JSON。

### turn.complete-130 · 1 次 · 校验

```sql
SELECT o.task_id FROM multiremi_feishu_bot_outbound_deliveries o JOIN multiremi_turn_execution_records t ON t.id = o.task_id WHERE o.workspace_id = ? AND o.kind = 'cot' AND o.delivery_mode = 'split' AND (t.status NOT IN ('completed', 'failed', 'cancelled') OR NOT EXISTS ( SELECT 1 FROM multiremi_feishu_bot_outbound_deliveries r WHERE r.task_id = o.task_id AND r.kind = 'result_card'))
```

读取规范 turn/attempt 执行投影的身份、状态、lineage 或通知事实；窄 guard 与完整 task/终态投影使用不同列和提交时刻。

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3213、packages/server/src/store/repos/feishu-bot-repo.ts:3336。

执行位置 / scope:generation：217 / 5:2。参数见相邻 JSON。

### turn.complete-131 · 1 次 · 其他

```sql
SELECT o.*, b.bot_id FROM multiremi_feishu_bot_outbound_deliveries o JOIN multiremi_feishu_bot_chat_bindings b ON b.id=o.binding_id AND b.workspace_id=o.workspace_id WHERE o.task_id = ? AND o.kind = 'cot' AND o.delivery_mode = 'split'
```

检查出站租约、重试、去重及待投递实体，保持重放、消息顺序与最终状态。

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3220、packages/server/src/store/repos/feishu-bot-repo.ts:3214。

执行位置 / scope:generation：218 / 5:2。参数见相邻 JSON。

### turn.complete-132 · 1 次 · 校验

```sql
SELECT * FROM multiremi_message_question_records WHERE task_id = ? ORDER BY created_at ASC, id ASC
```

检查待答/已答 Q、provider 等待和提醒截止，防止终态后丢卡或重复提醒。

来源：packages/server/src/store/repos/tasks-repo.ts:4911、packages/server/src/store/repos/feishu-bot-repo.ts:3247。

执行位置 / scope:generation：222 / 5:2。参数见相邻 JSON。

### turn.complete-133 · 1 次 · 其他

```sql
SELECT d.external_message_id FROM multiremi_feishu_bot_deliveries d JOIN multiremi_feishu_bot_chat_bindings b ON b.id = d.binding_id JOIN multiremi_feishu_bot_configs c ON c.workspace_id = d.workspace_id AND c.bot_id = b.bot_id AND c.app_id = b.app_id WHERE d.workspace_id = ? AND COALESCE(d.outbound_task_id, d.task_id) = ? ORDER BY d.created_at, d.external_message_id
```

读取外部消息来源、reply/thread 和投递任务，不能构造脱离原会话的回复。

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3276、packages/server/src/store/repos/feishu-bot-repo.ts:3214。

执行位置 / scope:generation：223 / 5:2。参数见相邻 JSON。

### turn.complete-134 · 1 次 · 必要写入

```sql
INSERT INTO multiremi_feishu_bot_outbound_deliveries (id, workspace_id, binding_id, task_id, chat_id, thread_id, reply_to_message_id, body, kind, unit_key, cascade_failure, delivery_mode, previous_delivery_id, human_request_id, human_request_task_id, target_message_id, mention_snapshot, interaction_open_id, degraded, status, available_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'split', ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?) ON CONFLICT DO NOTHING
```

持久化可靠出站回复及幂等键；内存发送不能代替 outbox。

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3235、packages/server/src/store/repos/feishu-bot-repo.ts:3279。

执行位置 / scope:generation：224 / 5:2。参数见相邻 JSON。

### turn.complete-135 · 1 次 · 其他

```sql
SELECT id FROM multiremi_feishu_bot_outbound_deliveries WHERE task_id = ? AND kind = ? AND unit_key = ?
```

检查出站租约、重试、去重及待投递实体，保持重放、消息顺序与最终状态。

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3279、packages/server/src/store/repos/feishu-bot-repo.ts:3214。

执行位置 / scope:generation：225 / 5:2。参数见相邻 JSON。

### turn.complete-136 · 1 次 · 其他

```sql
SELECT o.* FROM multiremi_feishu_bot_outbound_deliveries o JOIN multiremi_feishu_bot_chat_bindings b ON b.id = o.binding_id WHERE o.workspace_id = ? AND b.bot_id = ? AND b.app_id = ? AND (o.kind IS NULL OR o.kind NOT IN ('decision_card', 'decision_card_patch', 'decision_reminder') OR o.degraded IS NOT NULL) AND (? = 1 OR o.delivery_mode IS NULL OR o.delivery_mode = 'legacy') AND (o.decision_id IS NULL OR EXISTS ( SELECT 1 FROM multiremi_message_decision_records decision JOIN multiremi_issues target ON target.id = decision.issue_id AND target.workspace_id = decision.workspace_id JOIN multiremi_issues source ON source.id = decision.source_issue_id AND source.workspace_id = decision.workspace_id WHERE decision.id = o.decision_id AND decision.workspace_id = o.workspace_id AND decision.issue_id = o.decision_issue_id AND b.workspace_id = o.workspace_id AND b.issue_id = decision.issue_id )) AND NOT EXISTS ( SELECT 1 FROM multiremi_feishu_bot_round_pushes r WHERE r.wake_task_id = o.task_id AND r.binding_id = b.id AND r.workspace_id = o.workspace_id AND r.delivery_mode = 'proactive' AND (b.issue_id IS NULL OR b.issue_id <> r.issue_id) ) AND NOT EXISTS ( SELECT 1 FROM multiremi_feishu_bot_human_request_pushes h WHERE h.wake_task_id = o.task_id AND h.binding_id = b.id AND h.workspace_id = o.workspace_id AND (b.issue_id IS NULL OR b.issue_id <> h.issue_id) ) AND (o.task_id IS NULL OR ? = 1 OR o.body <> '') AND (? = 1 OR o.presentation_checkpoint IS NULL) AND (? = 1 OR o.attachments IS NULL) AND NOT EXISTS ( SELECT 1 FROM multiremi_feishu_bot_outbound_deliveries received WHERE o.kind = 'receipt' AND o.unit_key <> o.target_message_id || ':received' AND received.task_id = o.task_id AND received.kind = 'receipt' AND received.unit_key = o.target_message_id || ':received' AND received.status IN ('pending', 'sending')) AND (o.previous_delivery_id IS NULL OR EXISTS ( SELECT 1 FROM multiremi_feishu_bot_outbound_deliveries previous WHERE previous.id = o.previous_delivery_id AND previous.workspace_id = o.workspace_id AND (previous.status = 'sent' OR (o.cascade_failure = 0 AND previous.status = 'failed')))) AND ((o.status = 'pending' AND o.available_at <= ?) OR (o.status = 'sending' AND o.leased_until IS NOT NULL AND o.leased_until <= ?)) ORDER BY o.created_at ASC, o.id ASC LIMIT 1
```

检查出站租约、重试、去重及待投递实体，保持重放、消息顺序与最终状态。

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3409、packages/server/src/store/request-read-cache.ts:293。

执行位置 / scope:generation：227 / 5:2。参数见相邻 JSON。

## task.fail: 141 executions

类别执行数：{'校验': 82, '其他': 34, '锁': 4, '必要写入': 21}。

### task.fail-001 · 4 次 · 校验

```sql
SELECT * FROM multiremi_turn_execution_records WHERE id = ?
```

读取规范 turn/attempt 执行投影的身份、状态、lineage 或通知事实；窄 guard 与完整 task/终态投影使用不同列和提交时刻。

来源：packages/server/src/store/repos/tasks-repo.ts:2673、packages/server/src/store/repos/tasks-repo.ts:2653。

执行位置 / scope:generation：1 / 1:0, 7 / 1:2, 21 / 1:2, 126 / 4:2。参数见相邻 JSON。

### task.fail-002 · 3 次 · 其他

```sql
SELECT u.task_id AS task_id,u.provider,COALESCE(u.model,u.requested_model,'unknown') AS model, SUM(COALESCE(input_tokens,0)) AS input_tokens,SUM(COALESCE(output_tokens,0)) AS output_tokens, SUM(COALESCE(cache_read_tokens,0)) AS cache_read_tokens,SUM(COALESCE(cache_write_tokens,0)) AS cache_write_tokens, SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)+COALESCE(cache_read_tokens,0)+COALESCE(cache_write_tokens,0)+COALESCE(actual_unsplit_tokens,0)) AS total_tokens FROM multiremi_usage_units u WHERE u.task_id IN (?) AND source<>'context_snapshot' AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL OR cache_read_tokens IS NOT NULL OR cache_write_tokens IS NOT NULL OR actual_unsplit_tokens IS NOT NULL) GROUP BY u.task_id,u.provider,COALESCE(u.model,u.requested_model,'unknown') ORDER BY task_id,u.provider,model
```

按 ledger 集合汇总规范用量；按 task 与按 turn 是不同投影，不能复用旧累计字段。

来源：packages/server/src/store/request-read-cache.ts:182、packages/server/src/store/usage-projection.ts:21。

执行位置 / scope:generation：2 / 1:0, 8 / 1:2, 127 / 4:2。参数见相邻 JSON。

### task.fail-003 · 3 次 · 校验

```sql
SELECT id FROM multiremi_autopilot_run_records WHERE task_id = ? ORDER BY created_at DESC LIMIT 1
```

解析本轮关联的 autopilot run；有 run 时必须同步终态并保留可追溯关系。

来源：packages/server/src/store/request-read-cache.ts:182、packages/server/src/store/repos/tasks-repo.ts:7355。

执行位置 / scope:generation：3 / 1:0, 9 / 1:2, 128 / 4:2。参数见相邻 JSON。

### task.fail-004 · 10 次 · 校验

```sql
SELECT runtime.*, profile.display_name AS daemon_display_name, drain.daemon_id AS draining_daemon_id FROM multiremi_runtimes runtime LEFT JOIN multiremi_daemon_drains drain ON drain.workspace_id = COALESCE(runtime.workspace_id, 'local') AND drain.daemon_id = COALESCE(runtime.daemon_id, runtime.id) LEFT JOIN multiremi_daemon_profiles profile ON profile.workspace_id = COALESCE(runtime.workspace_id, 'local') AND profile.daemon_id = runtime.daemon_id WHERE runtime.id = ?
```

确认当前宿主身份、物理 daemon 和 drain fence；异步下行每次同步段重新取快照。

来源：packages/server/src/store/repos/runtimes-repo.ts:635、packages/server/src/store/repos/runtimes-repo.ts:543。

执行位置 / scope:generation：4 / 1:0, 10 / 1:2, 87 / None:None, 92 / 2:0, 95 / None:None, 102 / 3:0, 106 / 3:2, 112 / 4:0, 133 / 4:2, 135 / 5:0。参数见相邻 JSON。

### task.fail-005 · 2 次 · 校验

```sql
SELECT 1 FROM multiremi_daemon_retirements WHERE workspace_id = ? AND daemon_id = ?
```

拒绝已经退役的物理 daemon 上报，不能只验证 runtime 的存在。

来源：packages/server/src/store/repos/daemon-retirement-repo.ts:160、packages/server/src/api/daemon-protocol/report-handlers.ts:186、packages/server/src/store/repos/tasks-repo.ts:4799。

执行位置 / scope:generation：5 / 1:0, 11 / 1:2。参数见相邻 JSON。

### task.fail-006 · 3 次 · 锁

```sql
UPDATE multiremi_workspaces SET updated_at = updated_at WHERE id = ?
```

取得 workspace/Session/Issue/turn 的数据库互斥；不同外层事务或不同 lane 不能共享锁，删除会改变 PG 竞争下的校验顺序。

来源：packages/server/src/store/context.ts:1084、packages/server/src/store/request-read-cache.ts:203。

执行位置 / scope:generation：6 / 1:1, 105 / 3:1, 119 / 4:1。参数见相邻 JSON。

### task.fail-007 · 1 次 · 校验

```sql
SELECT * FROM multiremi_workspaces WHERE id = ?
```

读取工作区设置与权限边界；终态后的通知/派活仍须遵守当前工作区约束。

来源：packages/server/src/store/repos/workspaces-repo.ts:582、packages/server/src/store/repos/tasks-repo.ts:4800。

执行位置 / scope:generation：12 / 1:2。参数见相邻 JSON。

### task.fail-008 · 3 次 · 校验

```sql
SELECT chat.id, chat.workspace_id, chat.creator_id, chat.agent_id, chat.runtime_workspace_id, chat.project_id, chat.title, chat.status, chat.session_id, chat.work_dir, chat.session_runtime_id, chat.session_provider, chat.session_execution_fingerprint, chat.latest_task_id, chat.pinned, chat.origin_autopilot_id, chat.origin_run_id, chat.created_at, chat.updated_at, (SELECT COUNT(*) FROM multiremi_conversation_log m LEFT JOIN multiremi_session_lanes legacy ON legacy.session_id = m.session_id AND legacy.reader_type = 'member' AND legacy.reader_id = m.to_member_id AND legacy.execution_scope = '' LEFT JOIN multiremi_workspace_read_cursors shared ON shared.session_id = m.session_id AND shared.workspace_id = chat.workspace_id WHERE m.session_id = chat.id AND m.kind = 'message' AND m.visibility = 'shown' AND m.to_member_id IS NOT NULL AND m.deleted_at IS NULL AND m.seq > COALESCE(legacy.cursor_seq, 0) AND m.seq > COALESCE(shared.cursor_seq, 0)) AS unread_count, (SELECT MIN(m.created_at) FROM multiremi_conversation_log m LEFT JOIN multiremi_session_lanes legacy ON legacy.session_id = m.session_id AND legacy.reader_type = 'member' AND legacy.reader_id = m.to_member_id AND legacy.execution_scope = '' LEFT JOIN multiremi_workspace_read_cursors shared ON shared.session_id = m.session_id AND shared.workspace_id = chat.workspace_id WHERE m.session_id = chat.id AND m.kind = 'message' AND m.visibility = 'shown' AND m.to_member_id IS NOT NULL AND m.deleted_at IS NULL AND m.seq > COALESCE(legacy.cursor_seq, 0) AND m.seq > COALESCE(shared.cursor_seq, 0)) AS reader_unread_since, (SELECT SUBSTR(m.body, 1, 240) FROM multiremi_chat_message_records m WHERE m.chat_session_id = chat.id ORDER BY m.sequence DESC, m.id DESC LIMIT 1) AS last_message_content, (SELECT m.role FROM multiremi_chat_message_records m WHERE m.chat_session_id = chat.id ORDER BY m.sequence DESC, m.id DESC LIMIT 1) AS last_message_role, (SELECT m.created_at FROM multiremi_chat_message_records m WHERE m.chat_session_id = chat.id ORDER BY m.sequence DESC, m.id DESC LIMIT 1) AS last_message_created_at FROM multiremi_chat_sessions chat WHERE chat.id = ?
```

读取规范消息/回复/决策事实和可见范围；输入连续性、回复来源及通知投影都依赖这些列。

来源：packages/server/src/store/request-read-cache.ts:182、packages/server/src/store/repos/chat-repo.ts:254。

执行位置 / scope:generation：13 / 1:2, 51 / 1:2, 64 / 1:2。参数见相邻 JSON。

### task.fail-009 · 1 次 · 其他

```sql
SELECT id, workspace_id, agent_id, chat_session_id, issue_id FROM multiremi_feishu_bot_chat_bindings WHERE chat_session_id = ?
```

验证 Chat/Issue/bot 的绑定及外部投递目标，不能把普通私聊误判为 Topic。

来源：packages/server/src/store/request-read-cache.ts:182、packages/server/src/store/repos/tasks-repo.ts:2849。

执行位置 / scope:generation：14 / 1:2。参数见相邻 JSON。

### task.fail-010 · 2 次 · 校验

```sql
WITH RECURSIVE retry_lineage AS ( SELECT id, parent_task_id, workspace_id, agent_id, chat_session_id, task_kind, attempt FROM multiremi_turn_execution_records WHERE id = ? UNION ALL SELECT parent.id, parent.parent_task_id, parent.workspace_id, parent.agent_id, parent.chat_session_id, parent.task_kind, parent.attempt FROM multiremi_turn_execution_records parent JOIN retry_lineage child ON child.parent_task_id = parent.id AND child.workspace_id = parent.workspace_id AND child.agent_id = parent.agent_id AND child.chat_session_id = parent.chat_session_id AND child.task_kind = parent.task_kind AND child.attempt > 1 AND child.attempt = parent.attempt + 1 AND NOT EXISTS (SELECT 1 FROM multiremi_conversation_log retry_input JOIN multiremi_chat_sessions retry_session ON retry_session.id = retry_input.session_id WHERE retry_input.task_id = child.id AND retry_input.kind = 'message' AND retry_input.sender_type = 'member' AND retry_input.deleted_at IS NULL) ) SELECT push.binding_id, push.workspace_id, push.issue_id FROM multiremi_feishu_bot_round_pushes push JOIN retry_lineage lineage ON lineage.id = push.wake_task_id WHERE push.delivery_mode = 'proactive' UNION ALL SELECT push.binding_id, push.workspace_id, push.issue_id FROM multiremi_feishu_bot_human_request_pushes push JOIN retry_lineage lineage ON lineage.id = push.wake_task_id
```

读取规范 turn/attempt 执行投影的身份、状态、lineage 或通知事实；窄 guard 与完整 task/终态投影使用不同列和提交时刻。

来源：packages/server/src/store/repos/tasks-repo.ts:2871、packages/server/src/store/repos/tasks-repo.ts:5527、packages/server/src/store/repos/tasks-repo.ts:6586。

执行位置 / scope:generation：15 / 1:2, 23 / 1:2。参数见相邻 JSON。

### task.fail-011 · 1 次 · 锁

```sql
UPDATE multiremi_turns SET current_attempt_id=current_attempt_id WHERE id IN (SELECT turn_id FROM multiremi_turn_execution_records WHERE id = ? AND status IN ('dispatched', 'running', 'waiting_local_directory', 'awaiting_human'))
```

取得 workspace/Session/Issue/turn 的数据库互斥；不同外层事务或不同 lane 不能共享锁，删除会改变 PG 竞争下的校验顺序。

来源：packages/server/src/store/turn-execution-records.ts:180、packages/server/src/store/repos/tasks-repo.ts:5531。

执行位置 / scope:generation：16 / 1:2。参数见相邻 JSON。

### task.fail-012 · 1 次 · 校验

```sql
SELECT target.*,owner.current_attempt_id AS mutation_current_attempt_id, owner.session_id AS mutation_session_id,owner.agent_id AS mutation_agent_id, owner.reply_message_id AS mutation_reply_message_id,owner.started_at AS mutation_started_at FROM (SELECT id,turn_id,('failed') AS mutation_0,(?) AS mutation_1,(?) AS mutation_2,(COALESCE(?, session_id)) AS mutation_3,(COALESCE(?, work_dir)) AS mutation_4,(NULL) AS mutation_5,(?) AS mutation_6,(?) AS mutation_7,(?) AS mutation_8 FROM multiremi_turn_execution_records WHERE id = ? AND status IN ('dispatched', 'running', 'waiting_local_directory', 'awaiting_human')) target JOIN multiremi_turns owner ON owner.id=target.turn_id
```

在 turn 锁内读取 mutation target 和 current_attempt_id；防止被替换/终态的 attempt 回写新轮。

来源：packages/server/src/store/turn-execution-records.ts:189、packages/server/src/store/repos/tasks-repo.ts:5531。

执行位置 / scope:generation：17 / 1:2。参数见相邻 JSON。

### task.fail-013 · 1 次 · 必要写入

```sql
UPDATE multiremi_turn_attempts SET status=?,error=?,failure_reason=?,session_id=?,work_dir=?,wait_reason=?,ended_at=?,updated_at=? WHERE id=?
```

持久化 attempt 终态、输入收据/offer 水位或最终 trace 事实；后续重放必须读取持久化的新值。

来源：packages/server/src/store/turn-execution-records.ts:158、packages/server/src/store/turn-execution-records.ts:236。

执行位置 / scope:generation：18 / 1:2。参数见相邻 JSON。

### task.fail-014 · 1 次 · 必要写入

```sql
UPDATE multiremi_turns SET status=?,ended_at=?,ended_reason=? WHERE id=?
```

持久化 turn 终态、规范回复链接与轮卡状态。

来源：packages/server/src/store/turn-execution-records.ts:158、packages/server/src/store/turn-execution-records.ts:237。

执行位置 / scope:generation：19 / 1:2。参数见相邻 JSON。

### task.fail-015 · 1 次 · 必要写入

```sql
INSERT INTO multiremi_task_traces (task_id, location, updated_at) VALUES (?, 'none', ?) ON CONFLICT(task_id) DO UPDATE SET location = 'none', runtime_id = NULL, updated_at = excluded.updated_at WHERE multiremi_task_traces.location = 'daemon'
```

持久化 trace 的终态位置，后续读取不能继续等待 daemon。

来源：packages/server/src/store/repos/task-traces-repo.ts:55、packages/server/src/store/store.ts:1093。

执行位置 / scope:generation：20 / 1:2。参数见相邻 JSON。

### task.fail-016 · 1 次 · 校验

```sql
SELECT id FROM multiremi_message_question_records WHERE task_id = ? AND status IN ('pending','responded')
```

检查待答/已答 Q、provider 等待和提醒截止，防止终态后丢卡或重复提醒。

来源：packages/server/src/store/repos/tasks-repo.ts:6986、packages/server/src/store/repos/tasks-repo.ts:6572。

执行位置 / scope:generation：22 / 1:2。参数见相邻 JSON。

### task.fail-017 · 1 次 · 校验

```sql
SELECT t.id, t.status, t.current_attempt_id FROM multiremi_turns t JOIN multiremi_turn_attempts a ON a.turn_id = t.id WHERE a.id = ?
```

核对 turn/current attempt、终态状态、输入水位或派生轮卡；写入后、取得新锁后及异步新快照必须重读。

来源：packages/server/src/store/repos/tasks-repo.ts:6637、packages/server/src/store/repos/tasks-repo.ts:5547。

执行位置 / scope:generation：24 / 1:2。参数见相邻 JSON。

### task.fail-018 · 1 次 · 必要写入

```sql
UPDATE multiremi_access_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE type = 'task' AND task_id = ? AND revoked_at IS NULL
```

撤销终态任务凭据，避免完成后继续写业务状态。

来源：packages/server/src/store/repos/access-tokens-repo.ts:243、packages/server/src/store/repos/tasks-repo.ts:6662。

执行位置 / scope:generation：25 / 1:2。参数见相邻 JSON。

### task.fail-019 · 1 次 · 校验

```sql
SELECT reply_message_id FROM multiremi_turns WHERE current_attempt_id=?
```

核对 turn/current attempt、终态状态、输入水位或派生轮卡；写入后、取得新锁后及异步新快照必须重读。

来源：packages/server/src/store/repos/chat-repo.ts:552、packages/server/src/store/repos/tasks-repo.ts:6672。

执行位置 / scope:generation：26 / 1:2。参数见相邻 JSON。

### task.fail-020 · 2 次 · 校验

```sql
SELECT * FROM multiremi_turn_attempts WHERE id=?
```

核对 turn/current attempt、终态状态、输入水位或派生轮卡；写入后、取得新锁后及异步新快照必须重读。

来源：packages/server/src/store/request-read-cache.ts:182、packages/server/src/store/execution-reads.ts:18。

执行位置 / scope:generation：27 / 1:2, 61 / 1:2。参数见相邻 JSON。

### task.fail-021 · 1 次 · 校验

```sql
SELECT member.* FROM multiremi_workspace_members member JOIN multiremi_workspaces workspace ON workspace.id = member.workspace_id WHERE member.workspace_id = ? AND member.user_id = 'local' ORDER BY CASE WHEN member.id = ? THEN 0 ELSE 1 END, member.created_at, member.id LIMIT 1
```

确定共享操作者、作者与通知收件人，不能用 agent 或缓存的用户身份替代。

来源：packages/server/src/store/repos/workspaces-repo.ts:138、packages/server/src/store/repos/workspaces-repo.ts:144。

执行位置 / scope:generation：28 / 1:2。参数见相邻 JSON。

### task.fail-022 · 1 次 · 校验

```sql
SELECT * FROM multiremi_workspace_members WHERE id = ?
```

确定共享操作者、作者与通知收件人，不能用 agent 或缓存的用户身份替代。

来源：packages/server/src/store/request-read-cache.ts:182、packages/server/src/store/repos/workspaces-repo.ts:189。

执行位置 / scope:generation：29 / 1:2。参数见相邻 JSON。

### task.fail-023 · 2 次 · 校验

```sql
SELECT s.*, ( SELECT COUNT(*) FROM multiremi_conversation_log e WHERE e.session_id = s.parent_session_id AND e.kind <> 'head' AND e.seq > 0 AND ((s.inherit_mode = 'follow' AND (s.follow_frozen_seq IS NULL OR e.seq <= s.follow_frozen_seq)) OR (s.inherit_mode <> 'follow' AND e.seq <= s.inherit_cutoff_seq)) ) AS inherited_event_count FROM multiremi_issue_sessions s WHERE id = ?
```

读取规范消息/回复/决策事实和可见范围；输入连续性、回复来源及通知投影都依赖这些列。

来源：packages/server/src/store/request-read-cache.ts:182、packages/server/src/store/repos/issue-sessions-repo.ts:433。

执行位置 / scope:generation：30 / 1:2, 63 / 1:2。参数见相邻 JSON。

### task.fail-024 · 1 次 · 校验

```sql
SELECT workspace_id FROM multiremi_autopilots WHERE session_id=?
```

解析 autopilot Session 的所属工作区；消息统一入口不能只支持 Issue/Chat。

来源：packages/server/src/store/request-read-cache.ts:182、packages/server/src/store/inbox/send-message.ts:77。

执行位置 / scope:generation：31 / 1:2。参数见相邻 JSON。

### task.fail-025 · 2 次 · 校验

```sql
SELECT * FROM multiremi_conversation_log WHERE id=? AND kind='message'
```

读取规范消息/回复/决策事实和可见范围；输入连续性、回复来源及通知投影都依赖这些列。

来源：packages/server/src/store/request-read-cache.ts:182、packages/server/src/store/inbox/send-message.ts:22。

执行位置 / scope:generation：32 / 1:2, 46 / 1:2。参数见相邻 JSON。

### task.fail-026 · 2 次 · 校验

```sql
SELECT * FROM multiremi_turns WHERE id=?
```

核对 turn/current attempt、终态状态、输入水位或派生轮卡；写入后、取得新锁后及异步新快照必须重读。

来源：packages/server/src/store/request-read-cache.ts:182、packages/server/src/store/execution-reads.ts:12。

执行位置 / scope:generation：33 / 1:2, 62 / 1:2。参数见相邻 JSON。

### task.fail-027 · 1 次 · 校验

```sql
SELECT * FROM multiremi_agents WHERE id = ?
```

验证 agent 未归档及其执行配置，供回复身份校验和后续派活。

来源：packages/server/src/store/request-read-cache.ts:182、packages/server/src/store/repos/agents-skills-repo.ts:756。

执行位置 / scope:generation：34 / 1:2。参数见相邻 JSON。

### task.fail-028 · 1 次 · 其他

```sql
SELECT s.* FROM multiremi_skills s JOIN multiremi_agent_skills aks ON aks.skill_id = s.id WHERE aks.agent_id = ? AND s.archived_at IS NULL ORDER BY aks.created_at ASC, s.name ASC
```

读取当前可用 Skill 配置，避免派发已归档或过期能力。

来源：packages/server/src/store/request-read-cache.ts:182、packages/server/src/store/repos/agents-skills-repo.ts:897。

执行位置 / scope:generation：35 / 1:2。参数见相邻 JSON。

### task.fail-029 · 1 次 · 必要写入

```sql
UPDATE multiremi_chat_sessions SET updated_at=updated_at WHERE id=?
```

保存 chat_sessions 的业务变更，后续通知、回放和派活必须观察提交后的事实。

来源：packages/server/src/store/inbox/send-message.ts:157、packages/server/src/store/request-read-cache.ts:203。

执行位置 / scope:generation：36 / 1:2。参数见相邻 JSON。

### task.fail-030 · 1 次 · 校验

```sql
SELECT * FROM multiremi_conversation_heads WHERE session_id = ?
```

读取提交后的 seq/log_version，保证读取回执、轮卡与下行水位一致。

来源：packages/server/src/store/request-read-cache.ts:182、packages/server/src/store/repos/conversation-log-repo.ts:575。

执行位置 / scope:generation：37 / 1:2。参数见相邻 JSON。

### task.fail-031 · 1 次 · 必要写入

```sql
UPDATE multiremi_conversation_heads SET workspace_id=COALESCE(workspace_id,?),updated_at=updated_at WHERE session_id=?
```

原子分配消息 seq 或递增 log_version，不能用进程内计数替代。

来源：packages/server/src/store/inbox/send-message.ts:159、packages/server/src/store/repos/chat-repo.ts:557。

执行位置 / scope:generation：38 / 1:2。参数见相邻 JSON。

### task.fail-032 · 1 次 · 校验

```sql
SELECT MAX(created_at) AS at FROM multiremi_conversation_log WHERE session_id=? AND sender_type='member'
```

读取规范消息/回复/决策事实和可见范围；输入连续性、回复来源及通知投影都依赖这些列。

来源：packages/server/src/store/inbox/send-message.ts:66、packages/server/src/store/inbox/send-message.ts:189。

执行位置 / scope:generation：39 / 1:2。参数见相邻 JSON。

### task.fail-033 · 1 次 · 校验

```sql
SELECT task_id FROM multiremi_conversation_log WHERE id=?
```

读取规范消息/回复/决策事实和可见范围；输入连续性、回复来源及通知投影都依赖这些列。

来源：packages/server/src/store/inbox/send-message.ts:62、packages/server/src/store/inbox/send-message.ts:67。

执行位置 / scope:generation：40 / 1:2。参数见相邻 JSON。

### task.fail-034 · 1 次 · 校验

```sql
SELECT 1 FROM multiremi_squads s JOIN multiremi_squad_members m ON m.squad_id=s.id WHERE s.leader_id=? AND m.member_id=? AND m.member_type='agent' AND s.workspace_id=? AND s.archived_at IS NULL
```

核对当前 leader/成员关系，保证委派回程按实际负责人路由。

来源：packages/server/src/store/inbox/send-message.ts:191、packages/server/src/store/repos/chat-repo.ts:557。

执行位置 / scope:generation：41 / 1:2。参数见相邻 JSON。

### task.fail-035 · 2 次 · 校验

```sql
SELECT * FROM multiremi_conversation_log WHERE id = ?
```

读取规范消息/回复/决策事实和可见范围；输入连续性、回复来源及通知投影都依赖这些列。

来源：packages/server/src/store/repos/conversation-log-repo.ts:599、packages/server/src/store/repos/conversation-log-repo.ts:474、packages/server/src/store/repos/chat-repo.ts:565。

执行位置 / scope:generation：42 / 1:2, 48 / 1:2。参数见相邻 JSON。

### task.fail-036 · 1 次 · 必要写入

```sql
INSERT INTO multiremi_conversation_heads (session_id, head_seq, log_version, updated_at) VALUES (?, 1, 1, ?) ON CONFLICT(session_id) DO UPDATE SET head_seq = multiremi_conversation_heads.head_seq + 1, log_version = multiremi_conversation_heads.log_version + 1, updated_at = excluded.updated_at RETURNING head_seq
```

原子分配消息 seq 或递增 log_version，不能用进程内计数替代。

来源：packages/server/src/store/repos/conversation-log-repo.ts:553、packages/server/src/store/repos/conversation-log-repo.ts:486。

执行位置 / scope:generation：43 / 1:2。参数见相邻 JSON。

### task.fail-037 · 1 次 · 必要写入

```sql
INSERT INTO multiremi_conversation_log ( session_id, seq, id, kind, visibility, sender_type, sender_id, task_id, body_md, body_html, render_version, reply_to_id, resolved_at, resolved_by_type, resolved_by_id, metadata, revision, created_at, updated_at, deleted_at, to_type,to_ref,to_agent_id,to_member_id,message_kind,wake_requested,wake_applied,wake_reason,dedupe_key, options,card_token_hash,card_token_recipient,card_token_consumed_at ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
```

持久化规范回复/可见性/决策元数据或递增 revision，供重放及浏览器补读。

来源：packages/server/src/store/repos/conversation-log-repo.ts:493、packages/server/src/store/inbox/send-message.ts:236。

执行位置 / scope:generation：44 / 1:2。参数见相邻 JSON。

### task.fail-038 · 3 次 · 校验

```sql
SELECT * FROM multiremi_conversation_log WHERE session_id = ? AND seq = ?
```

读取规范消息/回复/决策事实和可见范围；输入连续性、回复来源及通知投影都依赖这些列。

来源：packages/server/src/store/request-read-cache.ts:182、packages/server/src/store/repos/conversation-log-repo.ts:592。

执行位置 / scope:generation：45 / 1:2, 77 / 1:2, 81 / 1:2。参数见相邻 JSON。

### task.fail-039 · 1 次 · 必要写入

```sql
INSERT INTO multiremi_session_lanes(session_id,reader_type,reader_id,execution_scope,created_at,updated_at) VALUES(?,'member',?,'',?,?) ON CONFLICT DO NOTHING
```

创建/推进 lane 或保存暂停状态；既是并发边界也是可恢复的消费水位。

来源：packages/server/src/store/inbox/send-message.ts:244、packages/server/src/store/repos/chat-repo.ts:557。

执行位置 / scope:generation：47 / 1:2。参数见相邻 JSON。

### task.fail-040 · 1 次 · 必要写入

```sql
UPDATE multiremi_turns SET reply_message_id=? WHERE current_attempt_id=?
```

持久化 turn 终态、规范回复链接与轮卡状态。

来源：packages/server/src/store/repos/chat-repo.ts:566、packages/server/src/store/repos/tasks-repo.ts:6672。

执行位置 / scope:generation：49 / 1:2。参数见相邻 JSON。

### task.fail-041 · 1 次 · 必要写入

```sql
UPDATE multiremi_turn_attempts SET failure_reason=? WHERE id=?
```

持久化 attempt 终态、输入收据/offer 水位或最终 trace 事实；后续重放必须读取持久化的新值。

来源：packages/server/src/store/repos/conversation-log-repo.ts:829、packages/server/src/store/repos/tasks-repo.ts:6683。

执行位置 / scope:generation：50 / 1:2。参数见相邻 JSON。

### task.fail-042 · 1 次 · 其他

```sql
SELECT issue_id FROM multiremi_feishu_bot_chat_bindings WHERE chat_session_id = ? AND issue_id IS NOT NULL ORDER BY created_at ASC, id ASC LIMIT 1
```

验证 Chat/Issue/bot 的绑定及外部投递目标，不能把普通私聊误判为 Topic。

来源：packages/server/src/store/request-read-cache.ts:182、packages/server/src/store/repos/feishu-bot-repo.ts:1285。

执行位置 / scope:generation：52 / 1:2。参数见相邻 JSON。

### task.fail-043 · 1 次 · 校验

```sql
SELECT p.*, COUNT(i.id) AS issue_count, COALESCE(SUM(CASE WHEN i.status IN ('done', 'completed', 'closed') THEN 1 ELSE 0 END), 0) AS done_count, ( SELECT COUNT(*) FROM multiremi_project_resources pr WHERE pr.project_id = p.id ) AS resource_count FROM multiremi_projects p LEFT JOIN multiremi_issues i ON i.project_id = p.id WHERE p.id = ? GROUP BY p.id
```

核对 Chat 固定的 Project 目录分配及 lineage，防止沿用已移走的本地目录。

来源：packages/server/src/store/request-read-cache.ts:182、packages/server/src/store/repos/projects-repo.ts:181。

执行位置 / scope:generation：53 / 1:2。参数见相邻 JSON。

### task.fail-044 · 1 次 · 校验

```sql
SELECT * FROM multiremi_project_resources WHERE project_id = ? ORDER BY position ASC, created_at ASC, id ASC
```

核对 Chat 固定的 Project 目录分配及 lineage，防止沿用已移走的本地目录。

来源：packages/server/src/store/request-read-cache.ts:182、packages/server/src/store/repos/projects-repo.ts:457。

执行位置 / scope:generation：54 / 1:2。参数见相邻 JSON。

### task.fail-045 · 1 次 · 校验

```sql
SELECT execution_fingerprint, work_dir, runtime_id FROM multiremi_turn_execution_records WHERE chat_session_id = ? AND issue_id IS NULL AND execution_fingerprint IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 1
```

读取规范 turn/attempt 执行投影的身份、状态、lineage 或通知事实；窄 guard 与完整 task/终态投影使用不同列和提交时刻。

来源：packages/server/src/store/chat-workspace.ts:39、packages/server/src/store/chat-workspace.ts:62。

执行位置 / scope:generation：55 / 1:2。参数见相邻 JSON。

### task.fail-046 · 1 次 · 校验

```sql
WITH selected AS (SELECT id FROM multiremi_runtimes WHERE id=?), owners AS ( SELECT t.runtime_id,t.turn_id AS task_id FROM multiremi_turn_execution_records t WHERE t.runtime_id IN (SELECT id FROM selected) UNION SELECT u.runtime_id,t.turn_id AS task_id FROM multiremi_usage_units u JOIN multiremi_turn_execution_records t ON t.id=u.task_id WHERE u.runtime_id IN (SELECT id FROM selected) ), counts AS (SELECT runtime_id,COUNT(*) AS task_count FROM owners GROUP BY runtime_id), lifecycle AS ( SELECT runtime_id,SUM(CASE WHEN status IN (?,?,?,?) THEN 1 ELSE 0 END) AS active_task_count, SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed_task_count, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed_task_count FROM multiremi_turn_execution_records t WHERE t.id=(SELECT current_attempt_id FROM multiremi_turns WHERE id=t.turn_id) AND runtime_id IN (SELECT id FROM selected) GROUP BY runtime_id ), tokens AS (SELECT u.runtime_id,SUM(COALESCE(u.input_tokens,0)) AS input_tokens,SUM(COALESCE(u.output_tokens,0)) AS output_tokens, SUM(COALESCE(u.cache_read_tokens,0)) AS cache_read_tokens,SUM(COALESCE(u.cache_write_tokens,0)) AS cache_write_tokens FROM multiremi_usage_units u JOIN multiremi_turn_execution_records t ON t.id=u.task_id WHERE u.runtime_id IN (SELECT id FROM selected) GROUP BY u.runtime_id) SELECT selected.id,counts.task_count,lifecycle.active_task_count,lifecycle.completed_task_count,lifecycle.failed_task_count, tokens.input_tokens,tokens.output_tokens,tokens.cache_read_tokens,tokens.cache_write_tokens FROM selected LEFT JOIN counts ON counts.runtime_id=selected.id LEFT JOIN lifecycle ON lifecycle.runtime_id=selected.id LEFT JOIN tokens ON tokens.runtime_id=selected.id
```

读取规范 turn/attempt 执行投影的身份、状态、lineage 或通知事实；窄 guard 与完整 task/终态投影使用不同列和提交时刻。

来源：packages/server/src/store/repos/runtimes-repo.ts:3082、packages/server/src/store/repos/runtimes-repo.ts:3060。

执行位置 / scope:generation：56 / 1:2。参数见相邻 JSON。

### task.fail-047 · 1 次 · 校验

```sql
SELECT status, error FROM multiremi_runtime_update_requests WHERE runtime_id = ? AND scope = 'cli' ORDER BY CASE WHEN status IN ('pending', 'running', 'restarting', 'verifying') THEN 0 ELSE 1 END, created_at DESC, updated_at DESC, id DESC LIMIT 1
```

判断待发更新/重启与协议资格，保持 CLI 更新任务的下发条件。

来源：packages/server/src/store/repos/runtimes-repo.ts:2917、packages/server/src/store/repos/runtimes-repo.ts:2904。

执行位置 / scope:generation：57 / 1:2。参数见相邻 JSON。

### task.fail-048 · 1 次 · 校验

```sql
SELECT group_id FROM multiremi_execution_group_members WHERE runtime_id = ? ORDER BY provider
```

读取 runtime 的执行能力组，供完整 Runtime 投影的契约消费者。

来源：packages/server/src/store/repos/runtimes-repo.ts:2905、packages/server/src/store/repos/runtimes-repo.ts:526。

执行位置 / scope:generation：58 / 1:2。参数见相邻 JSON。

### task.fail-049 · 1 次 · 其他

```sql
SELECT * FROM multiremi_runtime_models WHERE runtime_id = ? ORDER BY is_default DESC, label ASC
```

读取 runtime 当前模型目录，保留完整 Runtime 投影的模型能力契约。

来源：packages/server/src/store/repos/runtimes-repo.ts:3019、packages/server/src/store/repos/runtimes-repo.ts:2906。

执行位置 / scope:generation：59 / 1:2。参数见相邻 JSON。

### task.fail-050 · 1 次 · 必要写入

```sql
UPDATE multiremi_chat_sessions SET session_id = CASE WHEN ? = 1 THEN ? ELSE session_id END, work_dir = CASE WHEN ? = 1 THEN ? ELSE work_dir END, session_runtime_id = CASE WHEN ? = 1 THEN ? ELSE session_runtime_id END, session_provider = CASE WHEN ? = 1 THEN ? ELSE session_provider END, session_execution_fingerprint = CASE WHEN ? = 1 THEN ? ELSE session_execution_fingerprint END, latest_task_id = ?, unread_since = COALESCE(unread_since, ?), updated_at = ? WHERE id = ?
```

保存 chat_sessions 的业务变更，后续通知、回放和派活必须观察提交后的事实。

来源：packages/server/src/store/repos/tasks-repo.ts:6712、packages/server/src/store/repos/tasks-repo.ts:5547。

执行位置 / scope:generation：60 / 1:2。参数见相邻 JSON。

### task.fail-051 · 1 次 · 必要写入

```sql
INSERT INTO multiremi_session_lanes(session_id,reader_type,reader_id,execution_scope,created_at,updated_at) VALUES(?,'agent',?,?,?,?) ON CONFLICT(session_id,reader_type,reader_id,execution_scope) DO UPDATE SET updated_at=multiremi_session_lanes.updated_at
```

创建/推进 lane 或保存暂停状态；既是并发边界也是可恢复的消费水位。

来源：packages/server/src/store/inbox/lane-machine.ts:20、packages/server/src/store/request-read-cache.ts:203。

执行位置 / scope:generation：65 / 1:2。参数见相邻 JSON。

### task.fail-052 · 1 次 · 校验

```sql
SELECT 1 FROM multiremi_queued_messages WHERE session_id=? AND agent_id=? AND execution_scope=? AND status IN ('queued','failed') LIMIT 1
```

确定下一条排队消息及失败暂停状态，不能在终态时丢弃后续请求。

来源：packages/server/src/store/inbox/queued-messages.ts:102、packages/server/src/store/inbox/queued-messages.ts:234。

执行位置 / scope:generation：66 / 1:2。参数见相邻 JSON。

### task.fail-053 · 1 次 · 校验

```sql
SELECT queue_paused_at,queue_pause_reason FROM multiremi_session_lanes WHERE session_id=? AND reader_type='agent' AND reader_id=? AND execution_scope=?
```

核对 lane 游标、暂停与排队状态；决定 ACK、补铃和下一轮输入范围。

来源：packages/server/src/store/inbox/queued-messages.ts:80、packages/server/src/store/inbox/queued-messages.ts:235。

执行位置 / scope:generation：67 / 1:2。参数见相邻 JSON。

### task.fail-054 · 1 次 · 必要写入

```sql
UPDATE multiremi_session_lanes SET queue_paused_at=?,queue_pause_reason=? WHERE session_id=? AND reader_type='agent' AND reader_id=? AND execution_scope=? AND queue_paused_at IS NULL
```

创建/推进 lane 或保存暂停状态；既是并发边界也是可恢复的消费水位。

来源：packages/server/src/store/inbox/queued-messages.ts:87、packages/server/src/store/inbox/queued-messages.ts:237。

执行位置 / scope:generation：68 / 1:2。参数见相邻 JSON。

### task.fail-055 · 1 次 · 校验

```sql
SELECT cursor_seq FROM multiremi_session_lanes WHERE session_id=? AND reader_type='agent' AND reader_id=? AND execution_scope=?
```

核对 lane 游标、暂停与排队状态；决定 ACK、补铃和下一轮输入范围。

来源：packages/server/src/store/inbox/lane-machine.ts:93、packages/server/src/store/repos/tasks-repo.ts:7176。

执行位置 / scope:generation：69 / 1:2。参数见相邻 JSON。

### task.fail-056 · 1 次 · 校验

```sql
SELECT seq FROM multiremi_conversation_log WHERE id=?
```

读取规范消息/回复/决策事实和可见范围；输入连续性、回复来源及通知投影都依赖这些列。

来源：packages/server/src/store/inbox/lane-machine.ts:97、packages/server/src/store/repos/tasks-repo.ts:7176。

执行位置 / scope:generation：70 / 1:2。参数见相邻 JSON。

### task.fail-057 · 1 次 · 校验

```sql
SELECT id FROM multiremi_conversation_log WHERE session_id=? AND kind='message' AND to_agent_id=? AND seq>? AND wake_applied='now' AND deleted_at IS NULL AND COALESCE(json_extract(metadata,'$.execution_scope'),'')=? ORDER BY seq DESC LIMIT 1
```

读取规范消息/回复/决策事实和可见范围；输入连续性、回复来源及通知投影都依赖这些列。

来源：packages/server/src/store/inbox/lane-machine.ts:102、packages/server/src/store/repos/tasks-repo.ts:7176。

执行位置 / scope:generation：71 / 1:2。参数见相邻 JSON。

### task.fail-058 · 1 次 · 校验

```sql
SELECT event_count, tool_call_count, type_histogram, model, context_usage, worked_ms, process_item_count, late_subagents FROM multiremi_turn_attempts WHERE id = ?
```

核对 turn/current attempt、终态状态、输入水位或派生轮卡；写入后、取得新锁后及异步新快照必须重读。

来源：packages/server/src/store/store.ts:4698、packages/server/src/store/repos/tasks-repo.ts:5548。

执行位置 / scope:generation：72 / 1:2。参数见相邻 JSON。

### task.fail-059 · 1 次 · 必要写入

```sql
UPDATE multiremi_turn_attempts SET tool_call_count=?,event_count=?,type_histogram=?,model=?,context_usage=?,worked_ms=?,process_item_count=?,late_subagents=? WHERE id=?
```

持久化 attempt 终态、输入收据/offer 水位或最终 trace 事实；后续重放必须读取持久化的新值。

来源：packages/server/src/store/repos/conversation-log-repo.ts:829、packages/server/src/store/store.ts:4730。

执行位置 / scope:generation：73 / 1:2。参数见相邻 JSON。

### task.fail-060 · 1 次 · 校验

```sql
SELECT session_id,seq FROM multiremi_turns WHERE id=?
```

核对 turn/current attempt、终态状态、输入水位或派生轮卡；写入后、取得新锁后及异步新快照必须重读。

来源：packages/server/src/store/repos/conversation-log-repo.ts:134、packages/server/src/store/turn-execution-records.ts:144。

执行位置 / scope:generation：74 / 1:2。参数见相邻 JSON。

### task.fail-061 · 1 次 · 必要写入

```sql
UPDATE multiremi_conversation_log SET revision=revision+?,updated_at=? WHERE session_id=? AND seq=?
```

持久化规范回复/可见性/决策元数据或递增 revision，供重放及浏览器补读。

来源：packages/server/src/store/repos/conversation-log-repo.ts:136、packages/server/src/store/turn-execution-records.ts:144。

执行位置 / scope:generation：75 / 1:2。参数见相邻 JSON。

### task.fail-062 · 1 次 · 必要写入

```sql
UPDATE multiremi_conversation_heads SET log_version=log_version+?,updated_at=? WHERE session_id=?
```

原子分配消息 seq 或递增 log_version，不能用进程内计数替代。

来源：packages/server/src/store/repos/conversation-log-repo.ts:137、packages/server/src/store/turn-execution-records.ts:144。

执行位置 / scope:generation：76 / 1:2。参数见相邻 JSON。

### task.fail-063 · 1 次 · 校验

```sql
SELECT t.*,a.status AS attempt_status,a.attempt_no,a.failure_reason,a.progress_summary,a.event_count, a.tool_call_count,a.type_histogram,a.model,a.trace_ref,a.usage,a.started_at AS attempt_started_at,a.ended_at AS attempt_ended_at, a.context_usage,a.worked_ms,a.process_item_count,a.late_subagents FROM multiremi_turns t LEFT JOIN multiremi_turn_attempts a ON a.id=t.current_attempt_id WHERE t.id=?
```

核对 turn/current attempt、终态状态、输入水位或派生轮卡；写入后、取得新锁后及异步新快照必须重读。

来源：packages/server/src/store/turn-attempts.ts:82、packages/server/src/store/repos/conversation-log-repo.ts:139。

执行位置 / scope:generation：78 / 1:2。参数见相邻 JSON。

### task.fail-064 · 1 次 · 校验

```sql
SELECT body_md FROM multiremi_conversation_log WHERE id=?
```

读取规范消息/回复/决策事实和可见范围；输入连续性、回复来源及通知投影都依赖这些列。

来源：packages/server/src/store/turn-attempts.ts:84、packages/server/src/store/repos/conversation-log-repo.ts:139。

执行位置 / scope:generation：79 / 1:2。参数见相邻 JSON。

### task.fail-065 · 1 次 · 校验

```sql
SELECT a.turn_id AS task_id,u.provider,COALESCE(u.model,u.requested_model,'unknown') AS model, SUM(COALESCE(input_tokens,0)) AS input_tokens,SUM(COALESCE(output_tokens,0)) AS output_tokens, SUM(COALESCE(cache_read_tokens,0)) AS cache_read_tokens,SUM(COALESCE(cache_write_tokens,0)) AS cache_write_tokens, SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)+COALESCE(cache_read_tokens,0)+COALESCE(cache_write_tokens,0)+COALESCE(actual_unsplit_tokens,0)) AS total_tokens FROM multiremi_usage_units u JOIN multiremi_turn_attempts a ON a.id=u.task_id WHERE a.turn_id IN (?) AND source<>'context_snapshot' AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL OR cache_read_tokens IS NOT NULL OR cache_write_tokens IS NOT NULL OR actual_unsplit_tokens IS NOT NULL) GROUP BY a.turn_id,u.provider,COALESCE(u.model,u.requested_model,'unknown') ORDER BY task_id,u.provider,model
```

核对 turn/current attempt、终态状态、输入水位或派生轮卡；写入后、取得新锁后及异步新快照必须重读。

来源：packages/server/src/store/request-read-cache.ts:182、packages/server/src/store/usage-projection.ts:21。

执行位置 / scope:generation：80 / 1:2。参数见相邻 JSON。

### task.fail-066 · 1 次 · 其他

```sql
SELECT id FROM multiremi_feishu_bot_outbound_deliveries WHERE task_id = ? AND kind = 'cot' AND delivery_mode = 'split'
```

检查出站租约、重试、去重及待投递实体，保持重放、消息顺序与最终状态。

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3055、packages/server/src/store/store.ts:2477。

执行位置 / scope:generation：82 / 1:2。参数见相邻 JSON。

### task.fail-067 · 1 次 · 校验

```sql
SELECT id, workspace_id, runtime_id, status, agent_id, chat_session_id, issue_id, issue_session_id FROM multiremi_turn_execution_records WHERE id = ?
```

读取规范 turn/attempt 执行投影的身份、状态、lineage 或通知事实；窄 guard 与完整 task/终态投影使用不同列和提交时刻。

来源：packages/server/src/store/repos/tasks-repo.ts:2701、packages/server/src/api/daemon-protocol/task-offers.ts:249。

执行位置 / scope:generation：83 / 1:2。参数见相邻 JSON。

### task.fail-068 · 1 次 · 其他

```sql
SELECT DISTINCT runtime_id FROM multiremi_turn_execution_records WHERE workspace_id = ? AND status IN ('queued', 'dispatched')
```

集合计算有待派任务的宿主；没有待派任务的宿主不唤醒，不能删掉资格筛选。

来源：packages/server/src/store/repos/tasks-repo.ts:3341、packages/server/src/store/request-read-cache.ts:182。

执行位置 / scope:generation：84 / 1:2。参数见相邻 JSON。

### task.fail-069 · 1 次 · 校验

```sql
SELECT runtime.*, profile.display_name AS daemon_display_name, drain.daemon_id AS draining_daemon_id FROM multiremi_runtimes runtime LEFT JOIN multiremi_daemon_drains drain ON drain.workspace_id = COALESCE(runtime.workspace_id, 'local') AND drain.daemon_id = COALESCE(runtime.daemon_id, runtime.id) LEFT JOIN multiremi_daemon_profiles profile ON profile.workspace_id = COALESCE(runtime.workspace_id, 'local') AND profile.daemon_id = runtime.daemon_id WHERE runtime.id IN (?)
```

确认当前宿主身份、物理 daemon 和 drain fence；异步下行每次同步段重新取快照。

来源：packages/server/src/store/request-read-cache.ts:182、packages/server/src/store/repos/runtimes-repo.ts:553。

执行位置 / scope:generation：85 / 1:2。参数见相邻 JSON。

### task.fail-070 · 1 次 · 其他

```sql
SELECT runtime_id FROM multiremi_turn_execution_records WHERE workspace_id=? AND runtime_id IS NOT NULL AND status IN ('dispatched','running','waiting_local_directory','awaiting_human') UNION SELECT runtime_id FROM multiremi_feishu_bot_configs WHERE workspace_id=? AND runtime_id IS NOT NULL UNION SELECT runtime_id FROM multiremi_feishu_bot_runtime_states WHERE workspace_id=? AND (state<>'stopped' OR release_pending=1) UNION SELECT runtime_id FROM multiremi_background_tasks WHERE workspace_id=? AND lane_state<>'closed' UNION SELECT r.id AS runtime_id FROM multiremi_runtimes r JOIN multiremi_daemon_drains d ON d.workspace_id=COALESCE(r.workspace_id,'local') AND d.daemon_id=COALESCE(r.daemon_id,r.id) WHERE d.workspace_id=?
```

一次集合查询计算活跃 attempt、bot、驻留任务和 drain 的消费者；保留跨宿主通知而避免全 runtime 派活。

来源：packages/server/src/store/repos/runtimes-repo.ts:584、packages/server/src/store/request-read-cache.ts:182。

执行位置 / scope:generation：86 / 1:2。参数见相邻 JSON。

### task.fail-071 · 4 次 · 其他

```sql
SELECT bot_id FROM multiremi_feishu_bot_configs WHERE workspace_id = ? AND runtime_id = ?
```

读取 bot 配置和所有权；下行快照与终态卡片/文本均须采用当前绑定。

来源：packages/server/src/store/repos/feishu-bot-repo.ts:277、packages/server/src/store/store.ts:2510、packages/server/src/store/store.ts:2505。

执行位置 / scope:generation：88 / None:None, 96 / None:None, 115 / 4:0, 138 / 5:0。参数见相邻 JSON。

### task.fail-072 · 2 次 · 其他

```sql
SELECT bot_id FROM multiremi_feishu_bot_runtime_states WHERE workspace_id = ? AND runtime_id = ? AND (state <> 'stopped' OR release_pending = 1) ORDER BY reported_at DESC LIMIT 1
```

确定 bot 的真实宿主与在线状态，保留旧宿主停止确认和接管边界。

来源：packages/server/src/store/repos/feishu-bot-repo.ts:285、packages/server/src/store/store.ts:2510、packages/server/src/store/store.ts:2505。

执行位置 / scope:generation：89 / None:None, 139 / 5:0。参数见相邻 JSON。

### task.fail-073 · 4 次 · 其他

```sql
SELECT * FROM multiremi_feishu_bot_configs WHERE workspace_id = ? AND bot_id = ?
```

读取 bot 配置和所有权；下行快照与终态卡片/文本均须采用当前绑定。

来源：packages/server/src/store/repos/feishu-bot-repo.ts:435、packages/server/src/store/repos/feishu-bot-repo.ts:3542、packages/server/src/store/request-read-cache.ts:182。

执行位置 / scope:generation：90 / None:None, 97 / None:None, 116 / 4:0, 140 / 5:0。参数见相邻 JSON。

### task.fail-074 · 2 次 · 校验

```sql
SELECT drain.deadline FROM multiremi_runtimes runtime JOIN multiremi_daemon_drains drain ON drain.workspace_id = COALESCE(runtime.workspace_id, 'local') AND drain.daemon_id = COALESCE(runtime.daemon_id, runtime.id) WHERE runtime.id = ?
```

确认当前宿主身份、物理 daemon 和 drain fence；异步下行每次同步段重新取快照。

来源：packages/server/src/store/store.ts:3507、packages/server/src/api/server.ts:1241。

执行位置 / scope:generation：91 / None:None, 101 / None:None。参数见相邻 JSON。

### task.fail-075 · 2 次 · 校验

```sql
SELECT id, status, runtime_id, agent_id FROM multiremi_turn_execution_records WHERE status IN (?, ?, ?, ?) AND runtime_id = ? ORDER BY created_at DESC
```

读取规范 turn/attempt 执行投影的身份、状态、lineage 或通知事实；窄 guard 与完整 task/终态投影使用不同列和提交时刻。

来源：packages/server/src/store/repos/tasks-repo.ts:3160、packages/server/src/api/daemon-protocol/task-input-snapshot.ts:9。

执行位置 / scope:generation：93 / 2:0, 103 / 3:0。参数见相邻 JSON。

### task.fail-076 · 2 次 · 校验

```sql
SELECT id, workspace_id, runtime_id, status, agent_id, chat_session_id, issue_id, issue_session_id FROM multiremi_turn_execution_records WHERE id IN (SELECT value FROM json_each(?))
```

读取规范 turn/attempt 执行投影的身份、状态、lineage 或通知事实；窄 guard 与完整 task/终态投影使用不同列和提交时刻。

来源：packages/server/src/store/repos/tasks-repo.ts:2714、packages/server/src/api/daemon-protocol/task-input-snapshot.ts:13。

执行位置 / scope:generation：94 / 2:0, 104 / 3:0。参数见相邻 JSON。

### task.fail-077 · 1 次 · 其他

```sql
SELECT MIN(wake_at) AS wake_at FROM ( SELECT available_at AS wake_at FROM multiremi_feishu_bot_outbound_deliveries WHERE workspace_id = ? AND status = 'pending' AND available_at > ? UNION ALL SELECT leased_until AS wake_at FROM multiremi_feishu_bot_outbound_deliveries WHERE workspace_id = ? AND status = 'sending' AND leased_until > ? ) deadlines
```

检查出站租约、重试、去重及待投递实体，保持重放、消息顺序与最终状态。

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3551、packages/server/src/api/server.ts:1241。

执行位置 / scope:generation：98 / None:None。参数见相邻 JSON。

### task.fail-078 · 1 次 · 校验

```sql
SELECT request.created_at, request.expires_at FROM multiremi_message_question_records request JOIN multiremi_turn_execution_records task ON task.id = request.task_id WHERE task.workspace_id = ? AND task.issue_id IS NOT NULL AND request.status = 'pending' AND request.reminder_sent_at IS NULL AND request.expires_at IS NOT NULL AND EXISTS (SELECT 1 FROM multiremi_feishu_bot_outbound_deliveries delivery WHERE delivery.human_request_id = request.id AND delivery.kind = 'decision_card' AND delivery.status = 'sent' AND delivery.external_message_id IS NOT NULL AND delivery.degraded IS NULL)
```

读取规范 turn/attempt 执行投影的身份、状态、lineage 或通知事实；窄 guard 与完整 task/终态投影使用不同列和提交时刻。

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3560、packages/server/src/api/server.ts:1241。

执行位置 / scope:generation：99 / None:None。参数见相邻 JSON。

### task.fail-079 · 1 次 · 校验

```sql
SELECT MAX(delivery.sent_at) AS sent_at FROM multiremi_message_question_records request JOIN multiremi_turn_execution_records task ON task.id=request.task_id JOIN multiremi_conversation_log message ON message.id=request.id JOIN multiremi_feishu_bot_outbound_deliveries delivery ON delivery.human_request_id=request.id JOIN multiremi_feishu_bot_chat_bindings binding ON binding.id=delivery.binding_id AND binding.workspace_id=delivery.workspace_id WHERE task.workspace_id=? AND task.issue_id IS NOT NULL AND request.status='pending' AND binding.bot_id=? AND binding.app_id=? AND request.reminder_sent_at IS NULL AND request.expires_at IS NULL AND CAST(json_extract(CASE WHEN json_valid(message.metadata) THEN message.metadata ELSE '{}' END,'$.question.version') AS TEXT)='1' AND delivery.kind='decision_card' AND delivery.status='sent' AND delivery.external_message_id IS NOT NULL AND delivery.degraded IS NULL GROUP BY request.id
```

读取规范 turn/attempt 执行投影的身份、状态、lineage 或通知事实；窄 guard 与完整 task/终态投影使用不同列和提交时刻。

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3578、packages/server/src/api/server.ts:1241。

执行位置 / scope:generation：100 / None:None。参数见相邻 JSON。

### task.fail-080 · 1 次 · 必要写入

```sql
INSERT INTO multiremi_session_lanes (session_id,reader_type,reader_id,execution_scope,created_at,updated_at) SELECT t.session_id,'agent',t.agent_id,t.execution_scope,?,? FROM multiremi_turns t JOIN multiremi_turn_attempts a ON a.turn_id=t.id WHERE a.id IN (SELECT value FROM json_each(?)) AND t.current_attempt_id=a.id AND t.workspace_id=? AND a.runtime_id=? AND t.status IN ('running','awaiting_human') ORDER BY t.session_id,t.agent_id,t.execution_scope ON CONFLICT(session_id,reader_type,reader_id,execution_scope) DO UPDATE SET updated_at=multiremi_session_lanes.updated_at
```

创建/推进 lane 或保存暂停状态；既是并发边界也是可恢复的消费水位。

来源：packages/server/src/store/inbox/daemon-turn-bridge.ts:126、packages/server/src/store/request-read-cache.ts:293。

执行位置 / scope:generation：107 / 3:2。参数见相邻 JSON。

### task.fail-081 · 1 次 · 其他

```sql
SELECT t.*,a.id AS snapshot_attempt_id, a.input_ack_seq,a.input_read_seq,a.session_id AS provider_session_id, l.cursor_seq AS lane_cursor,COALESCE(h.head_seq,0) AS snapshot_head FROM multiremi_turns t JOIN multiremi_turn_attempts a ON a.turn_id=t.id JOIN multiremi_session_lanes l ON l.session_id=t.session_id AND l.reader_type='agent' AND l.reader_id=t.agent_id AND l.execution_scope=t.execution_scope LEFT JOIN multiremi_conversation_heads h ON h.session_id=t.session_id WHERE a.id IN (SELECT value FROM json_each(?)) AND t.current_attempt_id=a.id AND t.workspace_id=? AND a.runtime_id=? AND t.status IN ('running','awaiting_human')
```

集合生成全部活 attempt 的输入快照，关联 lane/head/日志窗口；删除会遗漏并发轮的中断输入或 wrap-up。

来源：packages/server/src/store/inbox/daemon-turn-bridge.ts:140、packages/server/src/store/request-read-cache.ts:293。

执行位置 / scope:generation：108 / 3:2。参数见相邻 JSON。

### task.fail-082 · 1 次 · 必要写入

```sql
UPDATE multiremi_turn_attempts SET input_ack_seq=CASE WHEN COALESCE(session_id,'')='' THEN 0 ELSE COALESCE((SELECT l.cursor_seq FROM multiremi_session_lanes l JOIN multiremi_turns t ON t.session_id=l.session_id AND t.agent_id=l.reader_id AND t.execution_scope=l.execution_scope WHERE t.id=multiremi_turn_attempts.turn_id AND l.reader_type='agent'),0) END, input_read_seq=CASE WHEN COALESCE(session_id,'')='' THEN 0 ELSE COALESCE((SELECT l.cursor_seq FROM multiremi_session_lanes l JOIN multiremi_turns t ON t.session_id=l.session_id AND t.agent_id=l.reader_id AND t.execution_scope=l.execution_scope WHERE t.id=multiremi_turn_attempts.turn_id AND l.reader_type='agent'),0) END, input_read_offset=0 WHERE id IN (SELECT value FROM json_each(?)) AND input_ack_seq IS NULL
```

持久化 attempt 终态、输入收据/offer 水位或最终 trace 事实；后续重放必须读取持久化的新值。

来源：packages/server/src/store/inbox/daemon-turn-bridge.ts:145、packages/server/src/store/request-read-cache.ts:293。

执行位置 / scope:generation：109 / 3:2。参数见相邻 JSON。

### task.fail-083 · 1 次 · 其他

```sql
SELECT e.*,a.id AS snapshot_attempt_id FROM multiremi_turn_attempts a JOIN multiremi_turns t ON t.id=a.turn_id JOIN multiremi_conversation_log e ON e.session_id=t.session_id WHERE a.id IN (SELECT value FROM json_each(?)) AND e.seq>a.input_ack_seq AND e.seq<=COALESCE((SELECT h.head_seq FROM multiremi_conversation_heads h WHERE h.session_id=t.session_id),0) AND e.kind='message' AND e.deleted_at IS NULL AND e.visibility='shown' ORDER BY a.id,e.seq
```

集合生成全部活 attempt 的输入快照，关联 lane/head/日志窗口；删除会遗漏并发轮的中断输入或 wrap-up。

来源：packages/server/src/store/inbox/daemon-turn-bridge.ts:162、packages/server/src/store/request-read-cache.ts:293。

执行位置 / scope:generation：110 / 3:2。参数见相邻 JSON。

### task.fail-084 · 1 次 · 必要写入

```sql
UPDATE multiremi_turn_attempts SET projection_to_seq=CASE WHEN COALESCE(projection_to_seq,0)<COALESCE((SELECT h.head_seq FROM multiremi_turns t JOIN multiremi_conversation_heads h ON h.session_id=t.session_id WHERE t.id=multiremi_turn_attempts.turn_id),0) THEN (SELECT h.head_seq FROM multiremi_turns t JOIN multiremi_conversation_heads h ON h.session_id=t.session_id WHERE t.id=multiremi_turn_attempts.turn_id) ELSE projection_to_seq END WHERE id IN (SELECT value FROM json_each(?))
```

持久化 attempt 终态、输入收据/offer 水位或最终 trace 事实；后续重放必须读取持久化的新值。

来源：packages/server/src/store/inbox/daemon-turn-bridge.ts:175、packages/server/src/store/request-read-cache.ts:293。

执行位置 / scope:generation：111 / 3:2。参数见相邻 JSON。

### task.fail-085 · 2 次 · 其他

```sql
SELECT 'update' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_update_requests WHERE runtime_id = ? AND status = 'pending' AND updated_at >= '2026-11-17T11:58:00.000Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_runtime_update_requests WHERE runtime_id = ? AND ((status = 'pending' AND updated_at < '2026-11-17T11:58:00.000Z') OR (status IN ('running', 'restarting', 'verifying') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T11:40:00.000Z'))) AS sweep, FALSE AS housekeeping UNION ALL SELECT 'model_list' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_model_list_requests WHERE runtime_id = ? AND status = 'pending' AND created_at >= '2026-11-17T11:59:30.000Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_runtime_model_list_requests WHERE runtime_id = ? AND ((status = 'pending' AND created_at < '2026-11-17T11:59:30.000Z') OR (status IN ('running') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T11:59:00.000Z'))) AS sweep, FALSE AS housekeeping UNION ALL SELECT 'command' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_command_requests WHERE runtime_id = ? AND status = 'pending' AND created_at >= '2026-11-17T11:57:00.000Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_runtime_command_requests WHERE runtime_id = ? AND ((status = 'pending' AND created_at < '2026-11-17T11:57:00.000Z') OR (status IN ('running') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T11:40:00.000Z'))) AS sweep, EXISTS (SELECT 1 FROM multiremi_runtime_command_requests WHERE runtime_id = ? AND status IN ('completed', 'failed', 'timeout') AND (command <> '' OR args <> '[]')) AS housekeeping UNION ALL SELECT 'local_skills' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_local_skill_list_requests WHERE runtime_id = ? AND status = 'pending' AND created_at >= '2026-11-17T11:57:00.000Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_runtime_local_skill_list_requests WHERE runtime_id = ? AND ((status = 'pending' AND created_at < '2026-11-17T11:57:00.000Z') OR (status IN ('running') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T11:59:00.000Z'))) AS sweep, FALSE AS housekeeping UNION ALL SELECT 'local_skill_import' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_local_skill_import_requests WHERE runtime_id = ? AND status = 'pending' AND created_at >= '2026-11-17T11:57:00.000Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_runtime_local_skill_import_requests WHERE runtime_id = ? AND ((status = 'pending' AND created_at < '2026-11-17T11:57:00.000Z') OR (status IN ('running') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T11:59:00.000Z'))) AS sweep, FALSE AS housekeeping UNION ALL SELECT 'gc_run' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_gc_run_requests WHERE runtime_id = ? AND status = 'pending' AND created_at >= '2026-11-17T11:50:00.000Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_runtime_gc_run_requests WHERE runtime_id = ? AND ((status = 'pending' AND created_at < '2026-11-17T11:50:00.000Z') OR (status IN ('running') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T11:50:00.000Z'))) AS sweep, FALSE AS housekeeping UNION ALL SELECT 'bot_menu' AS family, EXISTS (SELECT 1 FROM multiremi_bot_menu_publish_requests WHERE runtime_id = ? AND status = 'pending' AND created_at >= '2026-11-17T11:57:00.000Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_bot_menu_publish_requests WHERE runtime_id = ? AND ((status = 'pending' AND created_at < '2026-11-17T11:57:00.000Z') OR (status IN ('running') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T11:55:00.000Z'))) AS sweep, FALSE AS housekeeping UNION ALL SELECT 'directory_scan' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_directory_scan_requests WHERE runtime_id = ? AND status = 'pending' AND created_at >= '2026-11-17T11:57:00.000Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_runtime_directory_scan_requests WHERE runtime_id = ? AND ((status = 'pending' AND created_at < '2026-11-17T11:57:00.000Z') OR (status IN ('running') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T11:59:00.000Z'))) AS sweep, FALSE AS housekeeping
```

一次 union/EXISTS 读取所有 runtime 命令族的可领取状态；查询含当前时间边界，不与不同时间的快照合并。

来源：packages/server/src/store/repos/runtimes-repo.ts:2750、packages/server/src/store/repos/runtimes-repo.ts:2418。

执行位置 / scope:generation：113 / 4:0, 136 / 5:0。参数见相邻 JSON。

### task.fail-086 · 2 次 · 校验

```sql
SELECT * FROM multiremi_platform_maintenance WHERE id = 'platform'
```

每个下行同步段检查维护闸门；维护期间不得发出更新/外部投递。

来源：packages/server/src/store/repos/platform-maintenance-repo.ts:192、packages/server/src/store/repos/platform-maintenance-repo.ts:41。

执行位置 / scope:generation：114 / 4:0, 137 / 5:0。参数见相邻 JSON。

### task.fail-087 · 2 次 · 其他

```sql
SELECT * FROM multiremi_feishu_bot_runtime_states WHERE workspace_id = ? AND bot_id = ? AND runtime_id = ?
```

确定 bot 的真实宿主与在线状态，保留旧宿主停止确认和接管边界。

来源：packages/server/src/store/repos/feishu-bot-repo.ts:4182、packages/server/src/store/repos/feishu-bot-repo.ts:3302。

执行位置 / scope:generation：117 / 4:0, 141 / 5:0。参数见相邻 JSON。

### task.fail-088 · 1 次 · 其他

```sql
SELECT id, operation FROM multiremi_feishu_bot_outbound_operations WHERE workspace_id = ? AND ((status = 'pending' AND available_at <= ?) OR (status = 'processing' AND leased_until <= ?)) ORDER BY created_at, CASE kind WHEN 'topic' THEN 0 WHEN 'round' THEN 1 WHEN 'retarget' THEN 2 WHEN 'human_request' THEN 3 WHEN 'round_delivery' THEN 4 ELSE 5 END, id LIMIT 32
```

读取可执行或租约过期的外部操作，保留可靠出站操作的恢复。

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3123、packages/server/src/store/repos/feishu-bot-repo.ts:3309。

执行位置 / scope:generation：118 / 4:0。参数见相邻 JSON。

### task.fail-089 · 1 次 · 校验

```sql
SELECT decision.id, decision.issue_id FROM multiremi_message_decision_records decision JOIN multiremi_issues issue ON issue.id = decision.issue_id WHERE decision.status = 'escalated' AND decision.reminder_sent_at IS NULL AND issue.workspace_id = ? AND ( SELECT o.sent_at FROM multiremi_feishu_bot_outbound_deliveries o JOIN multiremi_feishu_bot_chat_bindings b ON b.id = o.binding_id WHERE o.kind = 'decision_card' AND o.decision_id = decision.id AND b.bot_id = ? AND o.status = 'sent' AND o.external_message_id IS NOT NULL AND o.degraded IS NULL AND o.sent_at IS NOT NULL ORDER BY o.created_at DESC, o.id DESC LIMIT 1 ) <= ? ORDER BY decision.id ASC
```

确定需要更新/提醒的决策记录，保留升级链和决策状态。

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3318、packages/server/src/store/request-read-cache.ts:293。

执行位置 / scope:generation：120 / 4:2。参数见相邻 JSON。

### task.fail-090 · 1 次 · 其他

```sql
SELECT id, kind FROM multiremi_feishu_bot_outbound_deliveries WHERE workspace_id = ? AND delivery_mode = 'split' AND attempt_count >= 6 AND binding_id IN (SELECT id FROM multiremi_feishu_bot_chat_bindings WHERE workspace_id = ? AND bot_id = ?) AND ((status = 'pending' AND available_at <= ?) OR (status = 'sending' AND leased_until <= ?))
```

检查出站租约、重试、去重及待投递实体，保持重放、消息顺序与最终状态。

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3325、packages/server/src/store/request-read-cache.ts:293。

执行位置 / scope:generation：121 / 4:2。参数见相邻 JSON。

### task.fail-091 · 1 次 · 校验

```sql
SELECT request.id, request.task_id, request.expires_at, request.created_at, (SELECT MAX(card.sent_at) FROM multiremi_feishu_bot_outbound_deliveries card WHERE card.human_request_id=request.id AND card.kind='decision_card' AND card.status='sent' AND card.external_message_id IS NOT NULL AND card.degraded IS NULL) AS card_sent_at FROM multiremi_message_question_records request JOIN multiremi_turn_execution_records task ON task.id = request.task_id JOIN multiremi_conversation_log message ON message.id=request.id WHERE request.status = 'pending' AND request.reminder_sent_at IS NULL -- A reminder is worth sending only while it still leaves the reader -- time to act: under a minute of lifetime left, the nudge would arrive -- as the request expires. The bound is the same expression the CAS and -- the claim use, so SQLite and Postgres agree. AND (request.expires_at >= ? OR (request.expires_at IS NULL AND CAST(json_extract(CASE WHEN json_valid(message.metadata) THEN message.metadata ELSE '{}' END,'$.question.version') AS TEXT)='1' AND EXISTS (SELECT 1 FROM multiremi_feishu_bot_outbound_deliveries card WHERE card.human_request_id=request.id AND card.kind='decision_card' AND card.status='sent' AND card.external_message_id IS NOT NULL AND card.degraded IS NULL AND card.sent_at<=?))) AND task.issue_id IS NOT NULL AND task.workspace_id = ? AND ( SELECT COUNT(*) FROM multiremi_feishu_bot_outbound_deliveries o JOIN multiremi_feishu_bot_chat_bindings b ON b.id = o.binding_id WHERE o.kind = 'decision_card' AND o.human_request_id = request.id AND b.bot_id = ? AND o.status = 'sent' AND o.external_message_id IS NOT NULL AND o.degraded IS NULL ) > 0 ORDER BY request.expires_at ASC, request.id ASC
```

读取规范 turn/attempt 执行投影的身份、状态、lineage 或通知事实；窄 guard 与完整 task/终态投影使用不同列和提交时刻。

来源：packages/server/src/store/repos/feishu-bot-repo.ts:2519、packages/server/src/store/repos/feishu-bot-repo.ts:3334。

执行位置 / scope:generation：122 / 4:2。参数见相邻 JSON。

### task.fail-092 · 1 次 · 其他

```sql
SELECT d.*, COALESCE(d.outbound_task_id, d.task_id) AS target_task_id, b.chat_id, b.thread_id, s.open_id FROM multiremi_feishu_bot_deliveries d JOIN multiremi_feishu_bot_chat_bindings b ON b.id = d.binding_id AND b.workspace_id = d.workspace_id LEFT JOIN multiremi_feishu_bot_senders s ON s.id = d.sender_id WHERE d.workspace_id = ? AND d.outbound_requested = 1 AND b.chat_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM multiremi_feishu_bot_outbound_deliveries carrier WHERE carrier.task_id = COALESCE(d.outbound_task_id, d.task_id) AND (carrier.kind IS NULL OR carrier.kind = 'cot') AND carrier.unit_key = '') AND NOT EXISTS (SELECT 1 FROM multiremi_feishu_bot_deliveries earlier WHERE COALESCE(earlier.outbound_task_id, earlier.task_id) = COALESCE(d.outbound_task_id, d.task_id) AND earlier.outbound_requested = 1 AND (earlier.created_at < d.created_at OR (earlier.created_at = d.created_at AND earlier.external_message_id < d.external_message_id))) ORDER BY d.created_at, d.external_message_id LIMIT 32
```

读取外部消息来源、reply/thread 和投递任务，不能构造脱离原会话的回复。

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3196、packages/server/src/store/repos/feishu-bot-repo.ts:3336。

执行位置 / scope:generation：123 / 4:2。参数见相邻 JSON。

### task.fail-093 · 1 次 · 校验

```sql
SELECT o.task_id FROM multiremi_feishu_bot_outbound_deliveries o JOIN multiremi_turn_execution_records t ON t.id = o.task_id WHERE o.workspace_id = ? AND o.kind = 'cot' AND o.delivery_mode = 'split' AND (t.status NOT IN ('completed', 'failed', 'cancelled') OR NOT EXISTS ( SELECT 1 FROM multiremi_feishu_bot_outbound_deliveries r WHERE r.task_id = o.task_id AND r.kind = 'result_card'))
```

读取规范 turn/attempt 执行投影的身份、状态、lineage 或通知事实；窄 guard 与完整 task/终态投影使用不同列和提交时刻。

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3213、packages/server/src/store/repos/feishu-bot-repo.ts:3336。

执行位置 / scope:generation：124 / 4:2。参数见相邻 JSON。

### task.fail-094 · 1 次 · 其他

```sql
SELECT o.*, b.bot_id FROM multiremi_feishu_bot_outbound_deliveries o JOIN multiremi_feishu_bot_chat_bindings b ON b.id=o.binding_id AND b.workspace_id=o.workspace_id WHERE o.task_id = ? AND o.kind = 'cot' AND o.delivery_mode = 'split'
```

检查出站租约、重试、去重及待投递实体，保持重放、消息顺序与最终状态。

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3220、packages/server/src/store/repos/feishu-bot-repo.ts:3214。

执行位置 / scope:generation：125 / 4:2。参数见相邻 JSON。

### task.fail-095 · 1 次 · 校验

```sql
SELECT * FROM multiremi_message_question_records WHERE task_id = ? ORDER BY created_at ASC, id ASC
```

检查待答/已答 Q、provider 等待和提醒截止，防止终态后丢卡或重复提醒。

来源：packages/server/src/store/repos/tasks-repo.ts:4911、packages/server/src/store/repos/feishu-bot-repo.ts:3247。

执行位置 / scope:generation：129 / 4:2。参数见相邻 JSON。

### task.fail-096 · 1 次 · 其他

```sql
SELECT d.external_message_id FROM multiremi_feishu_bot_deliveries d JOIN multiremi_feishu_bot_chat_bindings b ON b.id = d.binding_id JOIN multiremi_feishu_bot_configs c ON c.workspace_id = d.workspace_id AND c.bot_id = b.bot_id AND c.app_id = b.app_id WHERE d.workspace_id = ? AND COALESCE(d.outbound_task_id, d.task_id) = ? ORDER BY d.created_at, d.external_message_id
```

读取外部消息来源、reply/thread 和投递任务，不能构造脱离原会话的回复。

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3276、packages/server/src/store/repos/feishu-bot-repo.ts:3214。

执行位置 / scope:generation：130 / 4:2。参数见相邻 JSON。

### task.fail-097 · 1 次 · 必要写入

```sql
INSERT INTO multiremi_feishu_bot_outbound_deliveries (id, workspace_id, binding_id, task_id, chat_id, thread_id, reply_to_message_id, body, kind, unit_key, cascade_failure, delivery_mode, previous_delivery_id, human_request_id, human_request_task_id, target_message_id, mention_snapshot, interaction_open_id, degraded, status, available_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'split', ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?) ON CONFLICT DO NOTHING
```

持久化可靠出站回复及幂等键；内存发送不能代替 outbox。

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3235、packages/server/src/store/repos/feishu-bot-repo.ts:3279。

执行位置 / scope:generation：131 / 4:2。参数见相邻 JSON。

### task.fail-098 · 1 次 · 其他

```sql
SELECT id FROM multiremi_feishu_bot_outbound_deliveries WHERE task_id = ? AND kind = ? AND unit_key = ?
```

检查出站租约、重试、去重及待投递实体，保持重放、消息顺序与最终状态。

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3279、packages/server/src/store/repos/feishu-bot-repo.ts:3214。

执行位置 / scope:generation：132 / 4:2。参数见相邻 JSON。

### task.fail-099 · 1 次 · 其他

```sql
SELECT o.* FROM multiremi_feishu_bot_outbound_deliveries o JOIN multiremi_feishu_bot_chat_bindings b ON b.id = o.binding_id WHERE o.workspace_id = ? AND b.bot_id = ? AND b.app_id = ? AND (o.kind IS NULL OR o.kind NOT IN ('decision_card', 'decision_card_patch', 'decision_reminder') OR o.degraded IS NOT NULL) AND (? = 1 OR o.delivery_mode IS NULL OR o.delivery_mode = 'legacy') AND (o.decision_id IS NULL OR EXISTS ( SELECT 1 FROM multiremi_message_decision_records decision JOIN multiremi_issues target ON target.id = decision.issue_id AND target.workspace_id = decision.workspace_id JOIN multiremi_issues source ON source.id = decision.source_issue_id AND source.workspace_id = decision.workspace_id WHERE decision.id = o.decision_id AND decision.workspace_id = o.workspace_id AND decision.issue_id = o.decision_issue_id AND b.workspace_id = o.workspace_id AND b.issue_id = decision.issue_id )) AND NOT EXISTS ( SELECT 1 FROM multiremi_feishu_bot_round_pushes r WHERE r.wake_task_id = o.task_id AND r.binding_id = b.id AND r.workspace_id = o.workspace_id AND r.delivery_mode = 'proactive' AND (b.issue_id IS NULL OR b.issue_id <> r.issue_id) ) AND NOT EXISTS ( SELECT 1 FROM multiremi_feishu_bot_human_request_pushes h WHERE h.wake_task_id = o.task_id AND h.binding_id = b.id AND h.workspace_id = o.workspace_id AND (b.issue_id IS NULL OR b.issue_id <> h.issue_id) ) AND (o.task_id IS NULL OR ? = 1 OR o.body <> '') AND (? = 1 OR o.presentation_checkpoint IS NULL) AND (? = 1 OR o.attachments IS NULL) AND NOT EXISTS ( SELECT 1 FROM multiremi_feishu_bot_outbound_deliveries received WHERE o.kind = 'receipt' AND o.unit_key <> o.target_message_id || ':received' AND received.task_id = o.task_id AND received.kind = 'receipt' AND received.unit_key = o.target_message_id || ':received' AND received.status IN ('pending', 'sending')) AND (o.previous_delivery_id IS NULL OR EXISTS ( SELECT 1 FROM multiremi_feishu_bot_outbound_deliveries previous WHERE previous.id = o.previous_delivery_id AND previous.workspace_id = o.workspace_id AND (previous.status = 'sent' OR (o.cascade_failure = 0 AND previous.status = 'failed')))) AND ((o.status = 'pending' AND o.available_at <= ?) OR (o.status = 'sending' AND o.leased_until IS NOT NULL AND o.leased_until <= ?)) ORDER BY o.created_at ASC, o.id ASC LIMIT 1
```

检查出站租约、重试、去重及待投递实体，保持重放、消息顺序与最终状态。

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3409、packages/server/src/store/request-read-cache.ts:293。

执行位置 / scope:generation：134 / 4:2。参数见相邻 JSON。

