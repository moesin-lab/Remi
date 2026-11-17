# MUL-191：终态预算与剩余逐语句审计

PR #105 已普通合入 #112 的新夹具及批量快照（两个分支没有同时编辑同一文件）。这是组合版本；不能把 #112 的独立终态数字当成本单数字。

| 帧 | 新夹具 main 小档 读/写=总数 | 新夹具 main stable | #105 小档 | #105 stable | 目标 |
|---|---:|---:|---:|---:|---:|
| turn.complete |366/105=471|610/185=795|197/52=249|197/52=249|≤60|
| task.fail |362/75=437|906/195=1101|141/25=166|141/25=166|≤40|

旧 2/40 上下文夹具同步锁定为 complete 184/48=232、fail 116/27=143，两档相同。新规模预算和旧上下文预算都保留状态/回复、ACK 等行为断言，不能互相替代。

新增维度是 12 个活 attempt、8 个 AUQ/权限请求、20 条待发送飞书记录、12 runtime，历史规模参见 [共享报告](MUL-199-live-dimensions.md)。新 main 夹具已足以覆盖现场 complete 660 的量级，但不是精确重建现场帧。

## 本轮完成

- 同一完成事务内验证 turn/current attempt、宿主、输入 offer 范围；删除独立预检事务。工作区锁和 issue-session/lane 锁保留，完成重放仍返回 committed reply。自动回复失败继续完整回滚并重试；unread-input 和错误分类回归通过。
- 共享批量下行快照消除并发活 attempt 的逐行 SQL；全局 runtime 事件定向、Skill bundle 集合读取等上一轮优化仍保留。
- Windows 实际失败不是 3000 条回放：后者 pass 77.88 s；soft-cap 用例 11.82 s 超过默认 5 s。只把压缩/顺序用例改为内存 SQLite，仍检验 page-count 容量、可靠记录和每分区最后 progress；持久重放由独立用例覆盖。定向 1 pass，26.10 ms；没有放宽超时。
- PG 旧 run backend(1) 的锁探针只识别旧 UPDATE allocator，已增加对原子 upsert allocator 的识别，锁顺序期望不变。backend(4) 维护测试更新为省去无效 ensure-row 写后的准确写集合；golden 只变动创建/更新时间、elapsed_ms、相应 bytes 和 source，字段/消息/权限结构未漂移，64 项相关回归通过。
- PG 两档 seed 期间超过 ACK 期限的夹具问题由共享手动 protocol clock 修复，生产 ACK 15 s 不变。

## 不能宣称达到下限

249/166 是当前实测上界，不是理论下限，也没有达到 60/40。尤其完整完成路径仍有 141 种 SQL、失败路径 100 种 SQL；不能把“跨规模常数”当作“小常数已验收”。已去掉能局部安全收敛的预检和活 attempt 循环，但剩余重复读取仍有进一步整合空间。下面每条列出次数、来源、类别和本轮保留理由；重复读明确标为未证明不可删除，供所有者审阅，不能据此自动接受预算。PR 保持 Draft。

下一步需要按 task/turn/session/runtime 的绑定参数和锁代际做等价读取证明，再让终态 orchestrator 复用规范变更器的已锁定投影；不同事务/回滚后的重读不能通过跨异步缓存删除。读取批量化不能破坏 reply provenance、input_unread、native Q wait、用量和 outbox。

## 每条剩余 SQL

原始 SQL 与 source 见本表及相邻 JSON；相同语句合并次数，包含排队下行/派活。

### turn.complete: 249 executions

**turn.complete-001 ×11 — 重复读/待进一步合并**

```sql
SELECT runtime.*, profile.display_name AS daemon_display_name, drain.daemon_id AS draining_daemon_id FROM multiremi_runtimes runtime LEFT JOIN multiremi_daemon_drains drain ON drain.workspace_id = COALESCE(runtime.workspace_id, 'local') AND drain.daemon_id = COALESCE(runtime.daemon_id, runtime.id) LEFT JOIN multiremi_daemon_profiles profile ON profile.workspace_id = COALESCE(runtime.workspace_id, 'local') AND profile.daemon_id = runtime.daemon_id WHERE runtime.id = ?
```

来源：packages/server/src/store/repos/runtimes-repo.ts:632:7。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。 宿主/当前 attempt/排空资格需在序列化边界内确认。

**turn.complete-002 ×2 — 重复读/待进一步合并**

```sql
SELECT 1 FROM multiremi_daemon_retirements WHERE workspace_id = ? AND daemon_id = ?
```

来源：packages/server/src/store/repos/daemon-retirement-repo.ts:160:7。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。

**turn.complete-003 ×3 — 重复读/待进一步合并**

```sql
SELECT id, workspace_id, runtime_id, status, agent_id, chat_session_id, issue_id, issue_session_id FROM multiremi_turn_execution_records WHERE id = ?
```

来源：packages/server/src/store/repos/tasks-repo.ts:2697:7。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。 宿主/当前 attempt/排空资格需在序列化边界内确认。

**turn.complete-004 ×5 — 锁校验**

```sql
UPDATE multiremi_workspaces SET updated_at = updated_at WHERE id = ?
```

来源：packages/server/src/store/context.ts:1084:15。 保护 workspace/lane/插件串行边界；不同提交事务不能复用锁。本轮批量 lane 仍逐 lane 取得数据库互斥，不能改成无锁读取。

**turn.complete-005 ×4 — 重复读/待进一步合并**

```sql
SELECT * FROM multiremi_turn_execution_records WHERE id = ?
```

来源：packages/server/src/store/repos/tasks-repo.ts:2671:98。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。

**turn.complete-006 ×2 — 重复读/待进一步合并**

```sql
SELECT u.task_id AS task_id,u.provider,COALESCE(u.model,u.requested_model,'unknown') AS model, SUM(COALESCE(input_tokens,0)) AS input_tokens,SUM(COALESCE(output_tokens,0)) AS output_tokens, SUM(COALESCE(cache_read_tokens,0)) AS cache_read_tokens,SUM(COALESCE(cache_write_tokens,0)) AS cache_write_tokens, SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)+COALESCE(cache_read_tokens,0)+COALESCE(cache_write_tokens,0)+COALESCE(actual_unsplit_tokens,0)) AS total_tokens FROM multiremi_usage_units u WHERE u.task_id IN (?) AND source<>'context_snapshot' AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL OR cache_read_tokens IS NOT NULL OR cache_write_tokens IS NOT NULL OR actual_unsplit_tokens IS NOT NULL) GROUP BY u.task_id,u.provider,COALESCE(u.model,u.requested_model,'unknown') ORDER BY task_id,u.provider,model
```

来源：packages/server/src/store/usage-projection.ts:21:18。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。 用量由规范 ledger 投影，不能拿任务旧累计字段代替。

**turn.complete-007 ×3 — 重复读/待进一步合并**

```sql
SELECT id FROM multiremi_autopilot_run_records WHERE task_id = ? ORDER BY created_at DESC LIMIT 1
```

来源：packages/server/src/store/repos/tasks-repo.ts:6847:7, packages/server/src/store/repos/tasks-repo.ts:7351:22。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。

**turn.complete-008 ×2 — 重复读/待进一步合并**

```sql
SELECT * FROM multiremi_workspaces WHERE id = ?
```

来源：packages/server/src/store/repos/workspaces-repo.ts:581:86。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。

**turn.complete-009 ×1 — 校验/派生读取**

```sql
SELECT * FROM multiremi_turns WHERE current_attempt_id=?
```

来源：packages/server/src/store/repos/tasks-repo.ts:5368:69。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**turn.complete-010 ×6 — 重复读/待进一步合并**

```sql
SELECT scoped.*, CASE WHEN scoped.chat_id IS NOT NULL THEN chat.workspace_id ELSE issue.workspace_id END AS owner_workspace_id, head.workspace_id AS head_workspace_id, CASE WHEN scoped.parent_session_id IS NULL OR (parent.id IS NOT NULL AND parent.workspace_id = scoped.workspace_id AND COALESCE(parent.chat_id, '') = COALESCE(scoped.chat_id, '') AND (scoped.chat_id IS NOT NULL OR parent.issue_id = scoped.issue_id)) THEN 1 ELSE 0 END AS parent_owner_valid, CASE WHEN scoped.chat_id IS NULL AND EXISTS (SELECT 1 FROM multiremi_issue_activity activity WHERE activity.issue_id = scoped.issue_id AND activity.type = 'issue_main_session_rotated') THEN 1 ELSE 0 END AS has_rotation FROM (SELECT s.*, ( SELECT COUNT(*) FROM multiremi_conversation_log e WHERE e.session_id = s.parent_session_id AND e.kind <> 'head' AND e.seq > 0 AND ((s.inherit_mode = 'follow' AND (s.follow_frozen_seq IS NULL OR e.seq <= s.follow_frozen_seq)) OR (s.inherit_mode <> 'follow' AND e.seq <= s.inherit_cutoff_seq)) ) AS inherited_event_count FROM multiremi_issue_sessions s WHERE s.id = ?) scoped LEFT JOIN multiremi_chat_sessions chat ON chat.id = scoped.chat_id LEFT JOIN multiremi_issues issue ON issue.id = scoped.issue_id LEFT JOIN multiremi_issue_sessions parent ON parent.id = scoped.parent_session_id LEFT JOIN multiremi_conversation_heads head ON head.session_id = scoped.id
```

来源：packages/server/src/store/repos/issue-sessions-repo.ts:439:17。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。 需保持 reply provenance、可见性、读取回执和通知范围。

**turn.complete-011 ×1 — 锁校验**

```sql
UPDATE multiremi_issue_sessions SET updated_at = updated_at WHERE id = ?
```

来源：packages/server/src/store/repos/tasks-repo.ts:7089:21。 保护 workspace/lane/插件串行边界；不同提交事务不能复用锁。本轮批量 lane 仍逐 lane 取得数据库互斥，不能改成无锁读取。

**turn.complete-012 ×1 — 锁校验**

```sql
INSERT INTO multiremi_session_lanes(session_id,reader_type,reader_id,execution_scope,created_at,updated_at) VALUES(?,'agent',?,?,?,?) ON CONFLICT(session_id,reader_type,reader_id,execution_scope) DO UPDATE SET updated_at=multiremi_session_lanes.updated_at
```

来源：packages/server/src/store/inbox/lane-machine.ts:19:12。 保护 workspace/lane/插件串行边界；不同提交事务不能复用锁。本轮批量 lane 仍逐 lane 取得数据库互斥，不能改成无锁读取。

**turn.complete-013 ×1 — 校验/派生读取**

```sql
SELECT projection_to_seq FROM multiremi_turn_attempts WHERE id=?
```

来源：packages/server/src/store/repos/tasks-repo.ts:5400:111。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**turn.complete-014 ×1 — 校验/派生读取**

```sql
SELECT 1 FROM multiremi_conversation_log WHERE session_id=? AND kind='message' AND visibility='shown' AND deleted_at IS NULL AND to_agent_id=? AND wake_applied='now' AND seq>? AND seq<=? AND COALESCE(json_extract(metadata,'$.execution_scope'),'')=? LIMIT 1
```

来源：packages/server/src/store/repos/tasks-repo.ts:5407:14。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。 需保持 reply provenance、可见性、读取回执和通知范围。

**turn.complete-015 ×1 — 校验/派生读取**

```sql
SELECT * FROM multiremi_turn_attempts WHERE id=?
```

来源：packages/server/src/store/inbox/attempt-input.ts:39:21。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**turn.complete-016 ×1 — 校验/派生读取**

```sql
SELECT seq,sender_type,sender_id,body_md,to_agent_id,wake_applied,metadata FROM multiremi_conversation_log WHERE session_id=? AND seq>? AND seq<=? AND kind='message' AND visibility='shown' AND deleted_at IS NULL
```

来源：packages/server/src/store/inbox/lane-machine.ts:130:245。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。 需保持 reply provenance、可见性、读取回执和通知范围。

**turn.complete-017 ×4 — 重复读/待进一步合并**

```sql
SELECT * FROM multiremi_turns WHERE id=?
```

来源：packages/server/src/store/inbox/lane-machine.ts:139:71, packages/server/src/store/inbox/lane-machine.ts:79:71, packages/server/src/store/inbox/send-message.ts:91:92。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。

**turn.complete-018 ×1 — 校验/派生读取**

```sql
SELECT cursor_seq,cursor_offset FROM multiremi_session_lanes WHERE session_id=? AND reader_type='agent' AND reader_id=? AND execution_scope=?
```

来源：packages/server/src/store/inbox/lane-machine.ts:143:88。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**turn.complete-019 ×3 — 重复读/待进一步合并**

```sql
SELECT * FROM multiremi_conversation_heads WHERE session_id = ?
```

来源：packages/server/src/store/repos/conversation-log-repo.ts:574:9。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。

**turn.complete-020 ×1 — 必要写（当前契约）**

```sql
UPDATE multiremi_turn_attempts SET input_ack_seq=?,input_read_seq=?,input_read_offset=?,input_trigger_ack=1 WHERE id=?
```

来源：packages/server/src/store/inbox/attempt-input.ts:60:12。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。

**turn.complete-021 ×3 — 重复读/待进一步合并**

```sql
SELECT 1 AS present FROM multiremi_conversation_log log JOIN multiremi_issue_sessions s ON s.id = log.session_id WHERE s.issue_id = ? AND log.sender_type = 'agent' AND log.sender_id = ? AND log.kind = 'message' AND log.message_kind IN ('request', 'reply', 'final') AND log.to_type = 'none' AND SUBSTR(log.id, 1, 4) = 'cmt_' AND log.visibility='shown' AND log.deleted_at IS NULL AND log.task_id = (SELECT turn_id FROM multiremi_turn_attempts WHERE id=?) AND log.created_at >= ? LIMIT 1
```

来源：packages/server/src/store/repos/tasks-repo.ts:7258:70。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。 需保持 reply provenance、可见性、读取回执和通知范围。

**turn.complete-022 ×1 — 必要写（当前契约）**

```sql
UPDATE multiremi_turns SET current_attempt_id=current_attempt_id WHERE id IN (SELECT turn_id FROM multiremi_turn_execution_records WHERE id = ? AND status IN ('dispatched', 'running', 'waiting_local_directory', 'awaiting_human'))
```

来源：packages/server/src/store/turn-execution-records.ts:179:8。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。

**turn.complete-023 ×1 — 校验/派生读取**

```sql
SELECT target.*,owner.current_attempt_id AS mutation_current_attempt_id, owner.session_id AS mutation_session_id,owner.agent_id AS mutation_agent_id, owner.reply_message_id AS mutation_reply_message_id,owner.started_at AS mutation_started_at FROM (SELECT id,turn_id,('completed') AS mutation_0,(?) AS mutation_1,(?) AS mutation_2,(COALESCE(?, session_id)) AS mutation_3,(COALESCE(?, work_dir)) AS mutation_4,(NULL) AS mutation_5,(NULL) AS mutation_6,(?) AS mutation_7,(?) AS mutation_8 FROM multiremi_turn_execution_records WHERE id = ? AND status IN ('dispatched', 'running', 'waiting_local_directory', 'awaiting_human')) target JOIN multiremi_turns owner ON owner.id=target.turn_id
```

来源：packages/server/src/store/turn-execution-records.ts:188:63。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**turn.complete-024 ×1 — 校验/派生读取**

```sql
SELECT id FROM multiremi_turns WHERE id=?
```

来源：packages/server/src/store/repos/conversation-log-repo.ts:126:92。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**turn.complete-025 ×4 — 重复读/待进一步合并**

```sql
SELECT s.*, ( SELECT COUNT(*) FROM multiremi_conversation_log e WHERE e.session_id = s.parent_session_id AND e.kind <> 'head' AND e.seq > 0 AND ((s.inherit_mode = 'follow' AND (s.follow_frozen_seq IS NULL OR e.seq <= s.follow_frozen_seq)) OR (s.inherit_mode <> 'follow' AND e.seq <= s.inherit_cutoff_seq)) ) AS inherited_event_count FROM multiremi_issue_sessions s WHERE id = ?
```

来源：packages/server/src/store/repos/issue-sessions-repo.ts:433:17。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。 需保持 reply provenance、可见性、读取回执和通知范围。

**turn.complete-026 ×3 — 重复读/待进一步合并**

```sql
SELECT chat.id, chat.workspace_id, chat.creator_id, chat.agent_id, chat.runtime_workspace_id, chat.project_id, chat.title, chat.status, chat.session_id, chat.work_dir, chat.session_runtime_id, chat.session_provider, chat.session_execution_fingerprint, chat.latest_task_id, chat.pinned, chat.origin_autopilot_id, chat.origin_run_id, chat.created_at, chat.updated_at, (SELECT COUNT(*) FROM multiremi_conversation_log m LEFT JOIN multiremi_session_lanes legacy ON legacy.session_id = m.session_id AND legacy.reader_type = 'member' AND legacy.reader_id = m.to_member_id AND legacy.execution_scope = '' LEFT JOIN multiremi_workspace_read_cursors shared ON shared.session_id = m.session_id AND shared.workspace_id = chat.workspace_id WHERE m.session_id = chat.id AND m.kind = 'message' AND m.visibility = 'shown' AND m.to_member_id IS NOT NULL AND m.deleted_at IS NULL AND m.seq > COALESCE(legacy.cursor_seq, 0) AND m.seq > COALESCE(shared.cursor_seq, 0)) AS unread_count, (SELECT MIN(m.created_at) FROM multiremi_conversation_log m LEFT JOIN multiremi_session_lanes legacy ON legacy.session_id = m.session_id AND legacy.reader_type = 'member' AND legacy.reader_id = m.to_member_id AND legacy.execution_scope = '' LEFT JOIN multiremi_workspace_read_cursors shared ON shared.session_id = m.session_id AND shared.workspace_id = chat.workspace_id WHERE m.session_id = chat.id AND m.kind = 'message' AND m.visibility = 'shown' AND m.to_member_id IS NOT NULL AND m.deleted_at IS NULL AND m.seq > COALESCE(legacy.cursor_seq, 0) AND m.seq > COALESCE(shared.cursor_seq, 0)) AS reader_unread_since, (SELECT SUBSTR(m.body, 1, 240) FROM multiremi_chat_message_records m WHERE m.chat_session_id = chat.id ORDER BY m.sequence DESC, m.id DESC LIMIT 1) AS last_message_content, (SELECT m.role FROM multiremi_chat_message_records m WHERE m.chat_session_id = chat.id ORDER BY m.sequence DESC, m.id DESC LIMIT 1) AS last_message_role, (SELECT m.created_at FROM multiremi_chat_message_records m WHERE m.chat_session_id = chat.id ORDER BY m.sequence DESC, m.id DESC LIMIT 1) AS last_message_created_at FROM multiremi_chat_sessions chat WHERE chat.id = ?
```

来源：packages/server/src/store/repos/chat-repo.ts:252:79。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。 需保持 reply provenance、可见性、读取回执和通知范围。 宿主/当前 attempt/排空资格需在序列化边界内确认。

**turn.complete-027 ×2 — 重复读/待进一步合并**

```sql
SELECT workspace_id FROM multiremi_autopilots WHERE session_id=?
```

来源：packages/server/src/store/inbox/send-message.ts:74:95。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。

**turn.complete-028 ×5 — 重复读/待进一步合并**

```sql
SELECT * FROM multiremi_conversation_log WHERE id=? AND kind='message'
```

来源：packages/server/src/store/inbox/send-message.ts:20:100。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。 需保持 reply provenance、可见性、读取回执和通知范围。

**turn.complete-029 ×7 — 重复读/待进一步合并**

```sql
SELECT i.*, w.id AS existing_workspace_id FROM multiremi_issues i LEFT JOIN multiremi_workspaces w ON w.id = i.workspace_id WHERE i.id = ?
```

来源：packages/server/src/store/repos/issues-repo.ts:849:17。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。

**turn.complete-030 ×2 — 重复读/待进一步合并**

```sql
SELECT l.* FROM multiremi_issue_labels l JOIN multiremi_issue_to_labels il ON il.label_id = l.id WHERE il.issue_id = ? ORDER BY lower(l.name) ASC
```

来源：packages/server/src/store/repos/issues-repo.ts:5398:18。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。

**turn.complete-031 ×1 — 校验/派生读取**

```sql
SELECT * FROM multiremi_agents WHERE id = ?
```

来源：packages/server/src/store/repos/agents-skills-repo.ts:756:17。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**turn.complete-032 ×1 — 校验/派生读取**

```sql
SELECT s.* FROM multiremi_skills s JOIN multiremi_agent_skills aks ON aks.skill_id = s.id WHERE aks.agent_id = ? AND s.archived_at IS NULL ORDER BY aks.created_at ASC, s.name ASC
```

来源：packages/server/src/store/repos/agents-skills-repo.ts:897:18。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**turn.complete-033 ×2 — 必要写（当前契约）**

```sql
UPDATE multiremi_conversation_heads SET workspace_id=COALESCE(workspace_id,?),updated_at=updated_at WHERE session_id=?
```

来源：packages/server/src/store/inbox/send-message.ts:155:10。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。

**turn.complete-034 ×3 — 重复读/待进一步合并**

```sql
SELECT id,workspace_id,parent_issue_id,assignee_type,assignee_id FROM multiremi_issues WHERE id=?
```

来源：packages/server/src/store/issue-responsibility.ts:20:131。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。

**turn.complete-035 ×3 — 重复读/待进一步合并**

```sql
SELECT * FROM multiremi_conversation_log WHERE id = ?
```

来源：packages/server/src/store/repos/conversation-log-repo.ts:598:92。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。 需保持 reply provenance、可见性、读取回执和通知范围。

**turn.complete-036 ×2 — 必要写（当前契约）**

```sql
INSERT INTO multiremi_conversation_heads (session_id, head_seq, log_version, updated_at) VALUES (?, 1, 1, ?) ON CONFLICT(session_id) DO UPDATE SET head_seq = multiremi_conversation_heads.head_seq + 1, log_version = multiremi_conversation_heads.log_version + 1, updated_at = excluded.updated_at RETURNING head_seq
```

来源：packages/server/src/store/repos/conversation-log-repo.ts:552:28。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。

**turn.complete-037 ×7 — 重复读/待进一步合并**

```sql
SELECT turn_id FROM multiremi_turn_attempts WHERE id=?
```

来源：packages/server/src/store/repos/conversation-log-repo.ts:488:107, packages/server/src/store/repos/conversation-log-repo.ts:820:95, packages/server/src/store/repos/issues-repo.ts:4429:105, packages/server/src/store/repos/tasks-repo.ts:7172:92。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。

**turn.complete-038 ×2 — 必要写（当前契约）**

```sql
INSERT INTO multiremi_conversation_log ( session_id, seq, id, kind, visibility, sender_type, sender_id, task_id, body_md, body_html, render_version, reply_to_id, resolved_at, resolved_by_type, resolved_by_id, metadata, revision, created_at, updated_at, deleted_at, to_type,to_ref,to_agent_id,to_member_id,message_kind,wake_requested,wake_applied,wake_reason,dedupe_key, options,card_token_hash,card_token_recipient,card_token_consumed_at ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
```

来源：packages/server/src/store/repos/conversation-log-repo.ts:492:17。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。 需保持 reply provenance、可见性、读取回执和通知范围。

**turn.complete-039 ×7 — 重复读/待进一步合并**

```sql
SELECT * FROM multiremi_conversation_log WHERE session_id = ? AND seq = ?
```

来源：packages/server/src/store/repos/conversation-log-repo.ts:593:7。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。 需保持 reply provenance、可见性、读取回执和通知范围。

**turn.complete-040 ×1 — 必要写（当前契约）**

```sql
UPDATE multiremi_turn_attempts SET status=?,branch_name=?,session_id=?,work_dir=?,wait_reason=?,failure_reason=?,ended_at=?,updated_at=? WHERE id=?
```

来源：packages/server/src/store/turn-execution-records.ts:157:6。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。

**turn.complete-041 ×1 — 必要写（当前契约）**

```sql
UPDATE multiremi_turns SET status=?,ended_at=?,reply_message_id=? WHERE id=?
```

来源：packages/server/src/store/turn-execution-records.ts:157:6。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。

**turn.complete-042 ×1 — 必要写（当前契约）**

```sql
INSERT INTO multiremi_task_traces (task_id, location, updated_at) VALUES (?, 'none', ?) ON CONFLICT(task_id) DO UPDATE SET location = 'none', runtime_id = NULL, updated_at = excluded.updated_at WHERE multiremi_task_traces.location = 'daemon'
```

来源：packages/server/src/store/repos/task-traces-repo.ts:55:17。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。 宿主/当前 attempt/排空资格需在序列化边界内确认。

**turn.complete-043 ×1 — 校验/派生读取**

```sql
SELECT id FROM multiremi_message_question_records WHERE task_id = ? AND status IN ('pending','responded')
```

来源：packages/server/src/store/repos/tasks-repo.ts:6983:7。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。 需保留业务 Q 与 provider wait 分离、退出时 detachment。

**turn.complete-044 ×1 — 校验/派生读取**

```sql
SELECT reply_message_id FROM multiremi_turns WHERE current_attempt_id = ?
```

来源：packages/server/src/store/repos/tasks-repo.ts:6575:10。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**turn.complete-045 ×1 — 校验/派生读取**

```sql
SELECT t.id, t.status, t.current_attempt_id FROM multiremi_turns t JOIN multiremi_turn_attempts a ON a.turn_id = t.id WHERE a.id = ?
```

来源：packages/server/src/store/repos/tasks-repo.ts:6632:24。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**turn.complete-046 ×1 — 必要写（当前契约）**

```sql
UPDATE multiremi_access_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE type = 'task' AND task_id = ? AND revoked_at IS NULL
```

来源：packages/server/src/store/repos/access-tokens-repo.ts:243:28。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。

**turn.complete-047 ×3 — 重复读/待进一步合并**

```sql
SELECT workspace_id FROM multiremi_issues WHERE id = ?
```

来源：packages/server/src/store/context.ts:1586:89。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。

**turn.complete-048 ×2 — 必要写（当前契约）**

```sql
INSERT INTO multiremi_issue_activity (id, issue_id, workspace_id, actor_type, actor_id, type, body, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
```

来源：packages/server/src/store/context.ts:1448:13。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。

**turn.complete-049 ×1 — 校验/派生读取**

```sql
SELECT log.*,log.sender_type AS author_type,log.sender_id AS author_id,log.reply_to_id AS parent_id, s.issue_id, log.session_id AS issue_session_id, log.body_md AS body, CASE WHEN log.sender_type = 'platform' THEN 'system' ELSE 'comment' END AS type FROM multiremi_conversation_log log JOIN multiremi_issue_sessions s ON s.id = log.session_id WHERE log.id = ? AND log.kind IN ('message', 'system') AND log.deleted_at IS NULL
```

来源：packages/server/src/store/context.ts:1579:91。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。 需保持 reply provenance、可见性、读取回执和通知范围。

**turn.complete-050 ×1 — 锁校验**

```sql
UPDATE multiremi_workspaces SET updated_at = updated_at WHERE id = (SELECT workspace_id FROM multiremi_issues WHERE id = ?)
```

来源：packages/server/src/store/repos/issues-repo.ts:4366:17。 保护 workspace/lane/插件串行边界；不同提交事务不能复用锁。本轮批量 lane 仍逐 lane 取得数据库互斥，不能改成无锁读取。

**turn.complete-051 ×1 — 必要写（当前契约）**

```sql
UPDATE multiremi_issues SET id = id WHERE id = ?
```

来源：packages/server/src/store/issue-row-lock.ts:5:19。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。

**turn.complete-052 ×3 — 重复读/待进一步合并**

```sql
SELECT cmt.*, log.id AS log_id, log.body_md AS log_body_md, log.updated_at AS log_updated_at, log.resolved_at AS log_resolved_at, log.resolved_by_type AS log_resolved_by_type, log.resolved_by_id AS log_resolved_by_id FROM multiremi_issue_message_records cmt LEFT JOIN multiremi_conversation_log log ON log.id = cmt.id WHERE cmt.id = ?
```

来源：packages/server/src/store/repos/issues-repo.ts:4906:7。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。 需保持 reply provenance、可见性、读取回执和通知范围。

**turn.complete-053 ×3 — 重复读/待进一步合并**

```sql
SELECT * FROM multiremi_comment_reactions WHERE comment_id IN (?) ORDER BY created_at ASC
```

来源：packages/server/src/store/repos/issues-repo.ts:5690:7。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。

**turn.complete-054 ×3 — 重复读/待进一步合并**

```sql
SELECT * FROM multiremi_attachments WHERE comment_id IN (?) ORDER BY created_at ASC
```

来源：packages/server/src/store/repos/issues-repo.ts:5844:7。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。

**turn.complete-055 ×1 — 校验/派生读取**

```sql
SELECT * FROM multiremi_skill_files WHERE skill_id IN (SELECT value FROM json_each(?)) ORDER BY skill_id ASC, path ASC
```

来源：packages/server/src/store/repos/agents-skills-repo.ts:906:57。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**turn.complete-056 ×1 — 必要写（当前契约）**

```sql
UPDATE multiremi_issues SET updated_at = ? WHERE id = ?
```

来源：packages/server/src/store/repos/issues-repo.ts:4409:17。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。

**turn.complete-057 ×1 — 校验/派生读取**

```sql
SELECT * FROM multiremi_issue_message_records WHERE id = ?
```

来源：packages/server/src/store/context.ts:1568:93。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**turn.complete-058 ×1 — 必要写（当前契约）**

```sql
INSERT INTO multiremi_session_participants ( id, session_id, participant_type, participant_id, role, status, joined_at, updated_at ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?) ON CONFLICT(session_id, participant_type, participant_id) DO UPDATE SET role = excluded.role, status = 'active', updated_at = excluded.updated_at
```

来源：packages/server/src/store/repos/issue-sessions-repo.ts:607:17。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。

**turn.complete-059 ×1 — 锁校验**

```sql
INSERT INTO multiremi_session_lanes ( session_id, reader_id, execution_scope, cursor_seq, generation, status, created_at, updated_at ) VALUES (?, ?, ?, 0, 1, 'active', ?, ?) ON CONFLICT(session_id, reader_type, reader_id, execution_scope) DO NOTHING
```

来源：packages/server/src/store/repos/issue-sessions-repo.ts:788:17。 保护 workspace/lane/插件串行边界；不同提交事务不能复用锁。本轮批量 lane 仍逐 lane 取得数据库互斥，不能改成无锁读取。

**turn.complete-060 ×1 — 校验/派生读取**

```sql
SELECT * FROM multiremi_agent_lane_records WHERE session_id = ? AND agent_id = ? AND execution_scope = ?
```

来源：packages/server/src/store/repos/issue-sessions-repo.ts:797:7。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**turn.complete-061 ×1 — 校验/派生读取**

```sql
SELECT * FROM multiremi_session_participants WHERE session_id = ? AND participant_type = ? AND participant_id = ?
```

来源：packages/server/src/store/repos/issue-sessions-repo.ts:619:7。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**turn.complete-062 ×1 — 必要写（当前契约）**

```sql
UPDATE multiremi_conversation_log SET to_type=?,to_ref=?,to_agent_id=?,to_member_id=?,message_kind=?,reply_to_id=?, wake_requested=?,wake_applied=?,wake_reason=?,dedupe_key=?,options=?,task_id=COALESCE(?,task_id) WHERE id=?
```

来源：packages/server/src/store/inbox/send-message.ts:224:12。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。 需保持 reply provenance、可见性、读取回执和通知范围。

**turn.complete-063 ×1 — 必要写（当前契约）**

```sql
UPDATE multiremi_conversation_heads SET log_version = log_version + 1, updated_at = ? WHERE session_id = ?
```

来源：packages/server/src/store/repos/conversation-log-repo.ts:671:19。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。

**turn.complete-064 ×1 — 必要写（当前契约）**

```sql
UPDATE multiremi_conversation_log SET metadata = ?, updated_at = ?, revision = revision + 1 WHERE session_id = ? AND seq = ?
```

来源：packages/server/src/store/repos/conversation-log-repo.ts:676:17。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。 需保持 reply provenance、可见性、读取回执和通知范围。

**turn.complete-065 ×1 — 必要写（当前契约）**

```sql
UPDATE multiremi_conversation_log SET visibility='shown' WHERE id=?
```

来源：packages/server/src/store/inbox/send-message.ts:229:12。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。 需保持 reply provenance、可见性、读取回执和通知范围。

**turn.complete-066 ×2 — 重复读/待进一步合并**

```sql
SELECT * FROM multiremi_workspace_members WHERE workspace_id = ? AND archived_at IS NULL ORDER BY name ASC
```

来源：packages/server/src/store/repos/workspaces-repo.ts:218:131。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。

**turn.complete-067 ×1 — 必要写（当前契约）**

```sql
INSERT INTO multiremi_system_events (id, workspace_id, resource, event, resource_id, project_id, payload, status, attempt_count, available_at, created_at) VALUES (?, ?, 'issue_comment', ?, ?, ?, ?, 'pending', 0, ?, ?)
```

来源：packages/server/src/store/repos/issues-repo.ts:4523:17。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。

**turn.complete-068 ×2 — 必要写（当前契约）**

```sql
UPDATE multiremi_turns SET reply_message_id=? WHERE id=? AND current_attempt_id=?
```

来源：packages/server/src/store/repos/conversation-log-repo.ts:829:80。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。

**turn.complete-069 ×1 — 必要写（当前契约）**

```sql
UPDATE multiremi_issue_sessions SET updated_at = ? WHERE id = ?
```

来源：packages/server/src/store/repos/issue-sessions-repo.ts:721:17。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。

**turn.complete-070 ×1 — 校验/派生读取**

```sql
SELECT seq FROM multiremi_conversation_log WHERE session_id = ? AND task_id = ? AND kind = 'turn' ORDER BY seq ASC LIMIT 1
```

来源：packages/server/src/store/repos/issue-sessions-repo.ts:750:11。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。 需保持 reply provenance、可见性、读取回执和通知范围。

**turn.complete-071 ×1 — 必要写（当前契约）**

```sql
UPDATE multiremi_turn_attempts SET failure_reason=? WHERE id=?
```

来源：packages/server/src/store/repos/conversation-log-repo.ts:828:32。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。

**turn.complete-072 ×1 — 校验/派生读取**

```sql
SELECT cursor_seq FROM multiremi_session_lanes WHERE session_id=? AND reader_type='agent' AND reader_id=? AND execution_scope=?
```

来源：packages/server/src/store/inbox/lane-machine.ts:92:88。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**turn.complete-073 ×1 — 校验/派生读取**

```sql
SELECT id FROM multiremi_conversation_log WHERE session_id=? AND kind='message' AND to_agent_id=? AND seq>? AND wake_applied='now' AND deleted_at IS NULL AND COALESCE(json_extract(metadata,'$.execution_scope'),'')=? ORDER BY seq DESC LIMIT 1
```

来源：packages/server/src/store/inbox/lane-machine.ts:101:33。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。 需保持 reply provenance、可见性、读取回执和通知范围。

**turn.complete-074 ×1 — 校验/派生读取**

```sql
SELECT task.*,snapshot.id AS terminal_report_id,snapshot.metadata AS terminal_report_metadata, (SELECT MAX(seq) FROM multiremi_conversation_log e WHERE e.session_id=task.issue_session_id AND e.task_id=t.id) AS terminal_event_seq FROM multiremi_turn_execution_records task JOIN multiremi_turns t ON t.id=task.turn_id AND t.current_attempt_id=task.id LEFT JOIN multiremi_conversation_log snapshot ON snapshot.session_id=? AND snapshot.dedupe_key='delegation_terminal:'||task.id WHERE COALESCE(t.delegated_from_issue_session_id,t.session_id)=? AND t.status IN ('completed','failed','cancelled') AND t.delegation_id IS NOT NULL AND t.delegated_by_agent_id IS NOT NULL AND t.agent_id<>t.delegated_by_agent_id AND t.delegation_return_turn_id IS NULL AND t.delegation_skip_reason IS NULL ORDER BY t.ended_at,t.created_at,t.id
```

来源：packages/server/src/store/repos/tasks-repo.ts:6356:47。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。 需保持 reply provenance、可见性、读取回执和通知范围。

**turn.complete-075 ×1 — 必要写（当前契约）**

```sql
UPDATE multiremi_issues SET id=id WHERE id=?
```

来源：packages/server/src/store/inbox/issue-status.ts:9:14。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。

**turn.complete-076 ×1 — 校验/派生读取**

```sql
SELECT t.*,m.sender_type AS trigger_sender,m.wake_reason AS trigger_reason,m.message_kind AS trigger_kind, (SELECT COUNT(*) FROM multiremi_conversation_log merged WHERE merged.kind='message' AND merged.deleted_at IS NULL AND json_extract(CASE WHEN json_valid(merged.metadata) THEN merged.metadata ELSE '{}' END,'$.delivery_turn_id')=t.id AND merged.wake_reason IN ('human_sender','agent_dispatch')) AS merged_work_triggers FROM multiremi_turns t LEFT JOIN multiremi_conversation_log m ON m.id=t.trigger_message_id LEFT JOIN multiremi_issue_sessions owned_session ON owned_session.id=t.session_id WHERE t.issue_id=? AND COALESCE(owned_session.chat_id,t.chat_session_id) IS NULL AND (owned_session.id IS NULL OR owned_session.issue_id=t.issue_id) ORDER BY t.created_at DESC,t.seq DESC,t.id DESC
```

来源：packages/server/src/store/inbox/issue-status.ts:20:125。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。 需保持 reply provenance、可见性、读取回执和通知范围。

**turn.complete-077 ×1 — 校验/派生读取**

```sql
SELECT 1 FROM multiremi_conversation_log d JOIN multiremi_issue_sessions s ON s.id=d.session_id WHERE s.issue_id=? AND s.chat_id IS NULL AND d.kind='message' AND d.message_kind='decision' AND d.sender_type='agent' AND d.sender_id=? AND d.deleted_at IS NULL AND d.resolved_at IS NULL AND NOT EXISTS(SELECT 1 FROM multiremi_conversation_log r WHERE r.reply_to_id=d.id AND r.message_kind='reply' AND r.deleted_at IS NULL) LIMIT 1
```

来源：packages/server/src/store/inbox/issue-status.ts:25:95。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。 需保持 reply provenance、可见性、读取回执和通知范围。

**turn.complete-078 ×1 — 校验/派生读取**

```sql
SELECT m.id FROM multiremi_turns t JOIN multiremi_conversation_log m ON m.task_id = t.id WHERE t.issue_id = ? AND m.kind = 'message' AND m.message_kind = 'decision' AND m.deleted_at IS NULL AND m.resolved_at IS NULL UNION SELECT m.id FROM multiremi_issue_sessions s JOIN multiremi_conversation_log m ON m.session_id = s.id WHERE s.issue_id = ? AND m.kind = 'message' AND m.message_kind = 'decision' AND m.deleted_at IS NULL AND m.resolved_at IS NULL
```

来源：packages/server/src/store/repos/issues-repo.ts:579:7。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。 需保持 reply provenance、可见性、读取回执和通知范围。

**turn.complete-079 ×1 — 校验/派生读取**

```sql
SELECT COUNT(*) AS open_children FROM multiremi_issues child JOIN multiremi_issues parent ON parent.id = child.parent_issue_id AND parent.workspace_id = child.workspace_id WHERE child.parent_issue_id = ? AND child.status NOT IN ('done', 'cancelled')
```

来源：packages/server/src/store/repos/issues-repo.ts:1490:7。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**turn.complete-080 ×1 — 必要写（当前契约）**

```sql
UPDATE multiremi_issues SET status=?,completed_at=?,archived_at=NULL,updated_at=? WHERE id=?
```

来源：packages/server/src/store/inbox/issue-status.ts:51:10。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。

**turn.complete-081 ×1 — 必要写（当前契约）**

```sql
INSERT INTO multiremi_system_events ( id, workspace_id, resource, event, resource_id, project_id, payload, status, attempt_count, available_at, lease_until, last_error, created_at, processed_at ) VALUES (?, ?, 'issue', 'status_changed', ?, ?, ?, 'pending', 0, ?, NULL, NULL, ?, NULL)
```

来源：packages/server/src/store/repos/autopilots-repo.ts:1012:17。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。

**turn.complete-082 ×2 — 重复读/待进一步合并**

```sql
SELECT * FROM multiremi_system_events WHERE id = ?
```

来源：packages/server/src/store/repos/autopilots-repo.ts:1042:89。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。

**turn.complete-083 ×1 — 校验/派生读取**

```sql
SELECT 1 AS present FROM multiremi_turns turns JOIN multiremi_issue_sessions sessions ON sessions.id = turns.session_id WHERE turns.issue_id = ? AND sessions.issue_id = turns.issue_id AND sessions.chat_id IS NULL AND turns.status IN ('pending', 'running', 'awaiting_human') LIMIT 1
```

来源：packages/server/src/store/repos/tasks-repo.ts:7340:7。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**turn.complete-084 ×1 — 必要写（当前契约）**

```sql
UPDATE multiremi_issues SET lifecycle_state = lifecycle_state WHERE id = ?
```

来源：packages/server/src/store/context.ts:1102:13。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。

**turn.complete-085 ×1 — 校验/派生读取**

```sql
SELECT s.*, ( SELECT COUNT(*) FROM multiremi_conversation_log e WHERE e.session_id = s.parent_session_id AND e.kind <> 'head' AND e.seq > 0 AND ((s.inherit_mode = 'follow' AND (s.follow_frozen_seq IS NULL OR e.seq <= s.follow_frozen_seq)) OR (s.inherit_mode <> 'follow' AND e.seq <= s.inherit_cutoff_seq)) ) AS inherited_event_count FROM multiremi_issue_sessions s WHERE s.chat_id IS NULL AND s.issue_id = ? AND s.is_default = 1 LIMIT 1
```

来源：packages/server/src/store/repos/issue-sessions-repo.ts:304:7。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。 需保持 reply provenance、可见性、读取回执和通知范围。

**turn.complete-086 ×1 — 校验/派生读取**

```sql
SELECT c.id, c.agent_id, b.id AS binding_id FROM multiremi_feishu_bot_chat_bindings b JOIN multiremi_chat_sessions c ON c.id = b.chat_session_id WHERE b.issue_id = ? AND b.workspace_id = ? AND c.workspace_id = ? AND c.status <> 'archived' ORDER BY b.updated_at DESC, b.created_at DESC, b.id DESC
```

来源：packages/server/src/store/repos/inbox-repo.ts:155:70。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**turn.complete-087 ×1 — 校验/派生读取**

```sql
SELECT * FROM multiremi_feishu_bot_configs WHERE workspace_id = ? ORDER BY created_at, bot_id
```

来源：packages/server/src/store/repos/feishu-bot-repo.ts:265:8。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**turn.complete-088 ×5 — 重复读/待进一步合并**

```sql
SELECT * FROM multiremi_feishu_bot_configs WHERE workspace_id = ? AND bot_id = ?
```

来源：packages/server/src/store/repos/feishu-bot-repo.ts:434:17。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。

**turn.complete-089 ×1 — 校验/派生读取**

```sql
SELECT turn_id FROM multiremi_turn_attempts WHERE id = ?
```

来源：packages/server/src/store/repos/feishu-bot-repo.ts:2846:102。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**turn.complete-090 ×1 — 校验/派生读取**

```sql
SELECT b.* FROM multiremi_feishu_bot_chat_bindings b JOIN multiremi_chat_sessions c ON c.id = b.chat_session_id WHERE b.workspace_id = ? AND b.bot_id = ? AND b.app_id = ? AND b.issue_id = ? AND c.status = 'active' AND b.chat_id IS NOT NULL AND b.reply_to_message_id IS NOT NULL ORDER BY b.updated_at DESC, b.created_at DESC, b.id DESC
```

来源：packages/server/src/store/repos/feishu-bot-repo.ts:2856:7。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**turn.complete-091 ×1 — 校验/派生读取**

```sql
SELECT DISTINCT sessions.issue_id FROM multiremi_conversation_log messages JOIN multiremi_issue_sessions sessions ON sessions.id = messages.session_id WHERE messages.task_id = ? AND messages.kind = 'message' AND messages.sender_type = 'agent' AND messages.sender_id = ? AND messages.message_kind IN ('request', 'reply', 'final') AND messages.deleted_at IS NULL AND sessions.chat_id IS NULL AND sessions.issue_id <> ? ORDER BY sessions.issue_id
```

来源：packages/server/src/store/repos/tasks-repo.ts:6836:9。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。 需保持 reply provenance、可见性、读取回执和通知范围。

**turn.complete-092 ×1 — 必要写（当前契约）**

```sql
UPDATE multiremi_conversation_log SET message_kind=? WHERE id=(SELECT reply_message_id FROM multiremi_turns WHERE id=?)
```

来源：packages/server/src/store/repos/tasks-repo.ts:5454:44。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。 需保持 reply provenance、可见性、读取回执和通知范围。

**turn.complete-093 ×1 — 校验/派生读取**

```sql
SELECT event_count, tool_call_count, type_histogram, model, context_usage, worked_ms, process_item_count, late_subagents FROM multiremi_turn_attempts WHERE id = ?
```

来源：packages/server/src/store/store.ts:4697:7。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**turn.complete-094 ×1 — 必要写（当前契约）**

```sql
UPDATE multiremi_turn_attempts SET tool_call_count=?,event_count=?,type_histogram=?,model=?,context_usage=?,worked_ms=?,process_item_count=?,late_subagents=? WHERE id=?
```

来源：packages/server/src/store/repos/conversation-log-repo.ts:828:32。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。

**turn.complete-095 ×1 — 校验/派生读取**

```sql
SELECT session_id,seq FROM multiremi_turns WHERE id=?
```

来源：packages/server/src/store/repos/conversation-log-repo.ts:133:87。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**turn.complete-096 ×1 — 必要写（当前契约）**

```sql
UPDATE multiremi_conversation_log SET revision=revision+?,updated_at=? WHERE session_id=? AND seq=?
```

来源：packages/server/src/store/repos/conversation-log-repo.ts:135:14。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。 需保持 reply provenance、可见性、读取回执和通知范围。

**turn.complete-097 ×1 — 必要写（当前契约）**

```sql
UPDATE multiremi_conversation_heads SET log_version=log_version+?,updated_at=? WHERE session_id=?
```

来源：packages/server/src/store/repos/conversation-log-repo.ts:136:14。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。

**turn.complete-098 ×1 — 校验/派生读取**

```sql
SELECT t.*,a.status AS attempt_status,a.attempt_no,a.failure_reason,a.progress_summary,a.event_count, a.tool_call_count,a.type_histogram,a.model,a.trace_ref,a.usage,a.started_at AS attempt_started_at,a.ended_at AS attempt_ended_at, a.context_usage,a.worked_ms,a.process_item_count,a.late_subagents FROM multiremi_turns t LEFT JOIN multiremi_turn_attempts a ON a.id=t.current_attempt_id WHERE t.id=?
```

来源：packages/server/src/store/turn-attempts.ts:82:58。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**turn.complete-099 ×1 — 校验/派生读取**

```sql
SELECT body_md FROM multiremi_conversation_log WHERE id=?
```

来源：packages/server/src/store/turn-attempts.ts:84:108。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。 需保持 reply provenance、可见性、读取回执和通知范围。

**turn.complete-100 ×1 — 校验/派生读取**

```sql
SELECT a.turn_id AS task_id,u.provider,COALESCE(u.model,u.requested_model,'unknown') AS model, SUM(COALESCE(input_tokens,0)) AS input_tokens,SUM(COALESCE(output_tokens,0)) AS output_tokens, SUM(COALESCE(cache_read_tokens,0)) AS cache_read_tokens,SUM(COALESCE(cache_write_tokens,0)) AS cache_write_tokens, SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)+COALESCE(cache_read_tokens,0)+COALESCE(cache_write_tokens,0)+COALESCE(actual_unsplit_tokens,0)) AS total_tokens FROM multiremi_usage_units u JOIN multiremi_turn_attempts a ON a.id=u.task_id WHERE a.turn_id IN (?) AND source<>'context_snapshot' AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL OR cache_read_tokens IS NOT NULL OR cache_write_tokens IS NOT NULL OR actual_unsplit_tokens IS NOT NULL) GROUP BY a.turn_id,u.provider,COALESCE(u.model,u.requested_model,'unknown') ORDER BY task_id,u.provider,model
```

来源：packages/server/src/store/usage-projection.ts:21:18。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。 用量由规范 ledger 投影，不能拿任务旧累计字段代替。

**turn.complete-101 ×5 — 重复读/待进一步合并**

```sql
SELECT runtime_id FROM multiremi_turn_execution_records WHERE workspace_id=? AND runtime_id IS NOT NULL AND status IN ('dispatched','running','waiting_local_directory','awaiting_human') UNION SELECT runtime_id FROM multiremi_feishu_bot_configs WHERE workspace_id=? AND runtime_id IS NOT NULL UNION SELECT runtime_id FROM multiremi_feishu_bot_runtime_states WHERE workspace_id=? AND (state<>'stopped' OR release_pending=1) UNION SELECT runtime_id FROM multiremi_background_tasks WHERE workspace_id=? AND lane_state<>'closed' UNION SELECT r.id AS runtime_id FROM multiremi_runtimes r JOIN multiremi_daemon_drains d ON d.workspace_id=COALESCE(r.workspace_id,'local') AND d.daemon_id=COALESCE(r.daemon_id,r.id) WHERE d.workspace_id=?
```

来源：packages/server/src/store/repos/runtimes-repo.ts:581:34。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。 宿主/当前 attempt/排空资格需在序列化边界内确认。

**turn.complete-102 ×1 — 校验/派生读取**

```sql
SELECT * FROM multiremi_issue_subscribers WHERE issue_id = ? ORDER BY created_at ASC
```

来源：packages/server/src/store/repos/issues-repo.ts:5250:7。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**turn.complete-103 ×1 — 校验/派生读取**

```sql
SELECT member.* FROM multiremi_workspace_members member JOIN multiremi_workspaces workspace ON workspace.id = member.workspace_id WHERE member.workspace_id = ? AND member.user_id = 'local' ORDER BY CASE WHEN member.id = ? THEN 0 ELSE 1 END, member.created_at, member.id LIMIT 1
```

来源：packages/server/src/store/repos/workspaces-repo.ts:138:8。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**turn.complete-104 ×1 — 校验/派生读取**

```sql
SELECT workspace_id FROM multiremi_system_events WHERE id = ?
```

来源：packages/server/src/store/repos/issues-repo.ts:4558:106。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**turn.complete-105 ×1 — 必要写（当前契约）**

```sql
UPDATE multiremi_system_events SET status = 'processed', processed_at = ?, lease_until = NULL WHERE id = ? AND status = 'pending'
```

来源：packages/server/src/store/repos/issues-repo.ts:4564:23。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。

**turn.complete-106 ×1 — 校验/派生读取**

```sql
SELECT seq FROM multiremi_conversation_log WHERE id = ? AND kind IN ('message', 'system') LIMIT 1
```

来源：packages/server/src/store/repos/issues-repo.ts:6244:7。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。 需保持 reply provenance、可见性、读取回执和通知范围。

**turn.complete-107 ×1 — 校验/派生读取**

```sql
SELECT * FROM multiremi_turns WHERE id=? OR current_attempt_id=?
```

来源：packages/server/src/store/repos/issues-repo.ts:6400:119。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**turn.complete-108 ×1 — 必要写（当前契约）**

```sql
UPDATE multiremi_system_events SET last_error = NULL WHERE id = ?
```

来源：packages/server/src/store/repos/issues-repo.ts:4598:19。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。

**turn.complete-109 ×2 — 重复读/待进一步合并**

```sql
SELECT DISTINCT runtime_id FROM multiremi_turn_execution_records WHERE workspace_id = ? AND status IN ('queued', 'dispatched')
```

来源：packages/server/src/store/repos/tasks-repo.ts:3336:71。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。 宿主/当前 attempt/排空资格需在序列化边界内确认。

**turn.complete-110 ×2 — 重复读/待进一步合并**

```sql
SELECT runtime.*, profile.display_name AS daemon_display_name, drain.daemon_id AS draining_daemon_id FROM multiremi_runtimes runtime LEFT JOIN multiremi_daemon_drains drain ON drain.workspace_id = COALESCE(runtime.workspace_id, 'local') AND drain.daemon_id = COALESCE(runtime.daemon_id, runtime.id) LEFT JOIN multiremi_daemon_profiles profile ON profile.workspace_id = COALESCE(runtime.workspace_id, 'local') AND profile.daemon_id = runtime.daemon_id WHERE runtime.id IN (?)
```

来源：packages/server/src/store/repos/runtimes-repo.ts:562:67。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。 宿主/当前 attempt/排空资格需在序列化边界内确认。

**turn.complete-111 ×1 — 校验/派生读取**

```sql
SELECT id FROM multiremi_feishu_bot_outbound_deliveries WHERE task_id = ? AND kind = 'cot' AND delivery_mode = 'split'
```

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3055:72。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**turn.complete-112 ×1 — 校验/派生读取**

```sql
SELECT reply_message_id FROM multiremi_turns WHERE id=?
```

来源：packages/server/src/store/inbox/daemon-turn-bridge.ts:249:95。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**turn.complete-113 ×4 — 重复读/待进一步合并**

```sql
SELECT bot_id FROM multiremi_feishu_bot_configs WHERE workspace_id = ? AND runtime_id = ?
```

来源：packages/server/src/store/repos/feishu-bot-repo.ts:276:10。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。 宿主/当前 attempt/排空资格需在序列化边界内确认。

**turn.complete-114 ×1 — 校验/派生读取**

```sql
SELECT MIN(wake_at) AS wake_at FROM ( SELECT available_at AS wake_at FROM multiremi_feishu_bot_outbound_deliveries WHERE workspace_id = ? AND status = 'pending' AND available_at > ? UNION ALL SELECT leased_until AS wake_at FROM multiremi_feishu_bot_outbound_deliveries WHERE workspace_id = ? AND status = 'sending' AND leased_until > ? ) deadlines
```

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3551:19。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**turn.complete-115 ×1 — 校验/派生读取**

```sql
SELECT request.created_at, request.expires_at FROM multiremi_message_question_records request JOIN multiremi_turn_execution_records task ON task.id = request.task_id WHERE task.workspace_id = ? AND task.issue_id IS NOT NULL AND request.status = 'pending' AND request.reminder_sent_at IS NULL AND request.expires_at IS NOT NULL AND EXISTS (SELECT 1 FROM multiremi_feishu_bot_outbound_deliveries delivery WHERE delivery.human_request_id = request.id AND delivery.kind = 'decision_card' AND delivery.status = 'sent' AND delivery.external_message_id IS NOT NULL AND delivery.degraded IS NULL)
```

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3560:8。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。 需保留业务 Q 与 provider wait 分离、退出时 detachment。

**turn.complete-116 ×1 — 校验/派生读取**

```sql
SELECT MAX(delivery.sent_at) AS sent_at FROM multiremi_message_question_records request JOIN multiremi_turn_execution_records task ON task.id=request.task_id JOIN multiremi_conversation_log message ON message.id=request.id JOIN multiremi_feishu_bot_outbound_deliveries delivery ON delivery.human_request_id=request.id JOIN multiremi_feishu_bot_chat_bindings binding ON binding.id=delivery.binding_id AND binding.workspace_id=delivery.workspace_id WHERE task.workspace_id=? AND task.issue_id IS NOT NULL AND request.status='pending' AND binding.bot_id=? AND binding.app_id=? AND request.reminder_sent_at IS NULL AND request.expires_at IS NULL AND CAST(json_extract(CASE WHEN json_valid(message.metadata) THEN message.metadata ELSE '{}' END,'$.question.version') AS TEXT)='1' AND delivery.kind='decision_card' AND delivery.status='sent' AND delivery.external_message_id IS NOT NULL AND delivery.degraded IS NULL GROUP BY request.id
```

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3578:29。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。 需保持 reply provenance、可见性、读取回执和通知范围。 需保留业务 Q 与 provider wait 分离、退出时 detachment。

**turn.complete-117 ×2 — 重复读/待进一步合并**

```sql
SELECT drain.deadline FROM multiremi_runtimes runtime JOIN multiremi_daemon_drains drain ON drain.workspace_id = COALESCE(runtime.workspace_id, 'local') AND drain.daemon_id = COALESCE(runtime.daemon_id, runtime.id) WHERE runtime.id = ?
```

来源：packages/server/src/store/store.ts:3506:30。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。 宿主/当前 attempt/排空资格需在序列化边界内确认。

**turn.complete-118 ×2 — 重复读/待进一步合并**

```sql
SELECT id, status, runtime_id, agent_id FROM multiremi_turn_execution_records WHERE status IN (?, ?, ?, ?) AND runtime_id = ? ORDER BY created_at DESC
```

来源：packages/server/src/store/repos/tasks-repo.ts:3156:7。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。 宿主/当前 attempt/排空资格需在序列化边界内确认。

**turn.complete-119 ×2 — 重复读/待进一步合并**

```sql
SELECT id, workspace_id, runtime_id, status, agent_id, chat_session_id, issue_id, issue_session_id FROM multiremi_turn_execution_records WHERE id IN (SELECT value FROM json_each(?))
```

来源：packages/server/src/store/repos/tasks-repo.ts:2710:33。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。 宿主/当前 attempt/排空资格需在序列化边界内确认。

**turn.complete-120 ×2 — 锁校验**

```sql
INSERT INTO multiremi_session_lanes (session_id,reader_type,reader_id,execution_scope,created_at,updated_at) SELECT t.session_id,'agent',t.agent_id,t.execution_scope,?,? FROM multiremi_turns t JOIN multiremi_turn_attempts a ON a.turn_id=t.id WHERE a.id IN (SELECT value FROM json_each(?)) AND t.current_attempt_id=a.id AND t.workspace_id=? AND a.runtime_id=? AND t.status IN ('running','awaiting_human') ORDER BY t.session_id,t.agent_id,t.execution_scope ON CONFLICT(session_id,reader_type,reader_id,execution_scope) DO UPDATE SET updated_at=multiremi_session_lanes.updated_at
```

来源：packages/server/src/store/inbox/daemon-turn-bridge.ts:124:19。 保护 workspace/lane/插件串行边界；不同提交事务不能复用锁。本轮批量 lane 仍逐 lane 取得数据库互斥，不能改成无锁读取。 宿主/当前 attempt/排空资格需在序列化边界内确认。

**turn.complete-121 ×2 — 重复读/待进一步合并**

```sql
SELECT t.*,a.id AS snapshot_attempt_id, a.input_ack_seq,a.input_read_seq,a.session_id AS provider_session_id, l.cursor_seq AS lane_cursor,COALESCE(h.head_seq,0) AS snapshot_head FROM multiremi_turns t JOIN multiremi_turn_attempts a ON a.turn_id=t.id JOIN multiremi_session_lanes l ON l.session_id=t.session_id AND l.reader_type='agent' AND l.reader_id=t.agent_id AND l.execution_scope=t.execution_scope LEFT JOIN multiremi_conversation_heads h ON h.session_id=t.session_id WHERE a.id IN (SELECT value FROM json_each(?)) AND t.current_attempt_id=a.id AND t.workspace_id=? AND a.runtime_id=? AND t.status IN ('running','awaiting_human')
```

来源：packages/server/src/store/inbox/daemon-turn-bridge.ts:138:26。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。 宿主/当前 attempt/排空资格需在序列化边界内确认。

**turn.complete-122 ×2 — 必要写（当前契约）**

```sql
UPDATE multiremi_turn_attempts SET input_ack_seq=CASE WHEN COALESCE(session_id,'')='' THEN 0 ELSE COALESCE((SELECT l.cursor_seq FROM multiremi_session_lanes l JOIN multiremi_turns t ON t.session_id=l.session_id AND t.agent_id=l.reader_id AND t.execution_scope=l.execution_scope WHERE t.id=multiremi_turn_attempts.turn_id AND l.reader_type='agent'),0) END, input_read_seq=CASE WHEN COALESCE(session_id,'')='' THEN 0 ELSE COALESCE((SELECT l.cursor_seq FROM multiremi_session_lanes l JOIN multiremi_turns t ON t.session_id=l.session_id AND t.agent_id=l.reader_id AND t.execution_scope=l.execution_scope WHERE t.id=multiremi_turn_attempts.turn_id AND l.reader_type='agent'),0) END, input_read_offset=0 WHERE id IN (SELECT value FROM json_each(?)) AND input_ack_seq IS NULL
```

来源：packages/server/src/store/inbox/daemon-turn-bridge.ts:143:19。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。

**turn.complete-123 ×2 — 重复读/待进一步合并**

```sql
SELECT e.*,a.id AS snapshot_attempt_id FROM multiremi_turn_attempts a JOIN multiremi_turns t ON t.id=a.turn_id JOIN multiremi_conversation_log e ON e.session_id=t.session_id WHERE a.id IN (SELECT value FROM json_each(?)) AND e.seq>a.input_ack_seq AND e.seq<=COALESCE((SELECT h.head_seq FROM multiremi_conversation_heads h WHERE h.session_id=t.session_id),0) AND e.kind='message' AND e.deleted_at IS NULL AND e.visibility='shown' ORDER BY a.id,e.seq
```

来源：packages/server/src/store/inbox/daemon-turn-bridge.ts:160:31。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。 需保持 reply provenance、可见性、读取回执和通知范围。

**turn.complete-124 ×2 — 必要写（当前契约）**

```sql
UPDATE multiremi_turn_attempts SET projection_to_seq=CASE WHEN COALESCE(projection_to_seq,0)<COALESCE((SELECT h.head_seq FROM multiremi_turns t JOIN multiremi_conversation_heads h ON h.session_id=t.session_id WHERE t.id=multiremi_turn_attempts.turn_id),0) THEN (SELECT h.head_seq FROM multiremi_turns t JOIN multiremi_conversation_heads h ON h.session_id=t.session_id WHERE t.id=multiremi_turn_attempts.turn_id) ELSE projection_to_seq END WHERE id IN (SELECT value FROM json_each(?))
```

来源：packages/server/src/store/inbox/daemon-turn-bridge.ts:173:19。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。

**turn.complete-125 ×2 — 重复读/待进一步合并**

```sql
SELECT bot_id FROM multiremi_feishu_bot_runtime_states WHERE workspace_id = ? AND runtime_id = ? AND (state <> 'stopped' OR release_pending = 1) ORDER BY reported_at DESC LIMIT 1
```

来源：packages/server/src/store/repos/feishu-bot-repo.ts:284:10。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。 宿主/当前 attempt/排空资格需在序列化边界内确认。

**turn.complete-126 ×1 — 校验/派生读取**

```sql
SELECT 'update' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_update_requests WHERE runtime_id = ? AND status = 'pending' AND updated_at >= '2026-11-17T20:48:35.855Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_runtime_update_requests WHERE runtime_id = ? AND ((status = 'pending' AND updated_at < '2026-11-17T20:48:35.855Z') OR (status IN ('running', 'restarting', 'verifying') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T20:30:35.855Z'))) AS sweep, FALSE AS housekeeping UNION ALL SELECT 'model_list' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_model_list_requests WHERE runtime_id = ? AND status = 'pending' AND created_at >= '2026-11-17T20:50:05.855Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_runtime_model_list_requests WHERE runtime_id = ? AND ((status = 'pending' AND created_at < '2026-11-17T20:50:05.855Z') OR (status IN ('running') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T20:49:35.855Z'))) AS sweep, FALSE AS housekeeping UNION ALL SELECT 'command' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_command_requests WHERE runtime_id = ? AND status = 'pending' AND created_at >= '2026-11-17T20:47:35.855Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_runtime_command_requests WHERE runtime_id = ? AND ((status = 'pending' AND created_at < '2026-11-17T20:47:35.855Z') OR (status IN ('running') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T20:30:35.855Z'))) AS sweep, EXISTS (SELECT 1 FROM multiremi_runtime_command_requests WHERE runtime_id = ? AND status IN ('completed', 'failed', 'timeout') AND (command <> '' OR args <> '[]')) AS housekeeping UNION ALL SELECT 'local_skills' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_local_skill_list_requests WHERE runtime_id = ? AND status = 'pending' AND created_at >= '2026-11-17T20:47:35.855Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_runtime_local_skill_list_requests WHERE runtime_id = ? AND ((status = 'pending' AND created_at < '2026-11-17T20:47:35.855Z') OR (status IN ('running') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T20:49:35.855Z'))) AS sweep, FALSE AS housekeeping UNION ALL SELECT 'local_skill_import' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_local_skill_import_requests WHERE runtime_id = ? AND status = 'pending' AND created_at >= '2026-11-17T20:47:35.855Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_runtime_local_skill_import_requests WHERE runtime_id = ? AND ((status = 'pending' AND created_at < '2026-11-17T20:47:35.855Z') OR (status IN ('running') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T20:49:35.855Z'))) AS sweep, FALSE AS housekeeping UNION ALL SELECT 'gc_run' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_gc_run_requests WHERE runtime_id = ? AND status = 'pending' AND created_at >= '2026-11-17T20:40:35.855Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_runtime_gc_run_requests WHERE runtime_id = ? AND ((status = 'pending' AND created_at < '2026-11-17T20:40:35.855Z') OR (status IN ('running') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T20:40:35.855Z'))) AS sweep, FALSE AS housekeeping UNION ALL SELECT 'bot_menu' AS family, EXISTS (SELECT 1 FROM multiremi_bot_menu_publish_requests WHERE runtime_id = ? AND status = 'pending' AND created_at >= '2026-11-17T20:47:35.855Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_bot_menu_publish_requests WHERE runtime_id = ? AND ((status = 'pending' AND created_at < '2026-11-17T20:47:35.855Z') OR (status IN ('running') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T20:45:35.855Z'))) AS sweep, FALSE AS housekeeping UNION ALL SELECT 'directory_scan' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_directory_scan_requests WHERE runtime_id = ? AND status = 'pending' AND created_at >= '2026-11-17T20:47:35.855Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_runtime_directory_scan_requests WHERE runtime_id = ? AND ((status = 'pending' AND created_at < '2026-11-17T20:47:35.855Z') OR (status IN ('running') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T20:49:35.855Z'))) AS sweep, FALSE AS housekeeping
```

来源：packages/server/src/store/repos/runtimes-repo.ts:2747:68。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。 宿主/当前 attempt/排空资格需在序列化边界内确认。

**turn.complete-127 ×2 — 重复读/待进一步合并**

```sql
SELECT * FROM multiremi_platform_maintenance WHERE id = 'platform'
```

来源：packages/server/src/store/repos/platform-maintenance-repo.ts:192:7。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。

**turn.complete-128 ×2 — 重复读/待进一步合并**

```sql
SELECT * FROM multiremi_feishu_bot_runtime_states WHERE workspace_id = ? AND bot_id = ? AND runtime_id = ?
```

来源：packages/server/src/store/repos/feishu-bot-repo.ts:4182:8。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。 宿主/当前 attempt/排空资格需在序列化边界内确认。

**turn.complete-129 ×1 — 校验/派生读取**

```sql
SELECT 'update' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_update_requests WHERE runtime_id = ? AND status = 'pending' AND updated_at >= '2026-11-17T20:48:35.857Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_runtime_update_requests WHERE runtime_id = ? AND ((status = 'pending' AND updated_at < '2026-11-17T20:48:35.857Z') OR (status IN ('running', 'restarting', 'verifying') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T20:30:35.857Z'))) AS sweep, FALSE AS housekeeping UNION ALL SELECT 'model_list' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_model_list_requests WHERE runtime_id = ? AND status = 'pending' AND created_at >= '2026-11-17T20:50:05.857Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_runtime_model_list_requests WHERE runtime_id = ? AND ((status = 'pending' AND created_at < '2026-11-17T20:50:05.857Z') OR (status IN ('running') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T20:49:35.857Z'))) AS sweep, FALSE AS housekeeping UNION ALL SELECT 'command' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_command_requests WHERE runtime_id = ? AND status = 'pending' AND created_at >= '2026-11-17T20:47:35.857Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_runtime_command_requests WHERE runtime_id = ? AND ((status = 'pending' AND created_at < '2026-11-17T20:47:35.857Z') OR (status IN ('running') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T20:30:35.857Z'))) AS sweep, EXISTS (SELECT 1 FROM multiremi_runtime_command_requests WHERE runtime_id = ? AND status IN ('completed', 'failed', 'timeout') AND (command <> '' OR args <> '[]')) AS housekeeping UNION ALL SELECT 'local_skills' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_local_skill_list_requests WHERE runtime_id = ? AND status = 'pending' AND created_at >= '2026-11-17T20:47:35.857Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_runtime_local_skill_list_requests WHERE runtime_id = ? AND ((status = 'pending' AND created_at < '2026-11-17T20:47:35.857Z') OR (status IN ('running') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T20:49:35.857Z'))) AS sweep, FALSE AS housekeeping UNION ALL SELECT 'local_skill_import' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_local_skill_import_requests WHERE runtime_id = ? AND status = 'pending' AND created_at >= '2026-11-17T20:47:35.857Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_runtime_local_skill_import_requests WHERE runtime_id = ? AND ((status = 'pending' AND created_at < '2026-11-17T20:47:35.857Z') OR (status IN ('running') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T20:49:35.857Z'))) AS sweep, FALSE AS housekeeping UNION ALL SELECT 'gc_run' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_gc_run_requests WHERE runtime_id = ? AND status = 'pending' AND created_at >= '2026-11-17T20:40:35.857Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_runtime_gc_run_requests WHERE runtime_id = ? AND ((status = 'pending' AND created_at < '2026-11-17T20:40:35.857Z') OR (status IN ('running') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T20:40:35.857Z'))) AS sweep, FALSE AS housekeeping UNION ALL SELECT 'bot_menu' AS family, EXISTS (SELECT 1 FROM multiremi_bot_menu_publish_requests WHERE runtime_id = ? AND status = 'pending' AND created_at >= '2026-11-17T20:47:35.857Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_bot_menu_publish_requests WHERE runtime_id = ? AND ((status = 'pending' AND created_at < '2026-11-17T20:47:35.857Z') OR (status IN ('running') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T20:45:35.857Z'))) AS sweep, FALSE AS housekeeping UNION ALL SELECT 'directory_scan' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_directory_scan_requests WHERE runtime_id = ? AND status = 'pending' AND created_at >= '2026-11-17T20:47:35.857Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_runtime_directory_scan_requests WHERE runtime_id = ? AND ((status = 'pending' AND created_at < '2026-11-17T20:47:35.857Z') OR (status IN ('running') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T20:49:35.857Z'))) AS sweep, FALSE AS housekeeping
```

来源：packages/server/src/store/repos/runtimes-repo.ts:2747:68。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。 宿主/当前 attempt/排空资格需在序列化边界内确认。

**turn.complete-130 ×1 — 校验/派生读取**

```sql
SELECT id, operation FROM multiremi_feishu_bot_outbound_operations WHERE workspace_id = ? AND ((status = 'pending' AND available_at <= ?) OR (status = 'processing' AND leased_until <= ?)) ORDER BY created_at, CASE kind WHEN 'topic' THEN 0 WHEN 'round' THEN 1 WHEN 'retarget' THEN 2 WHEN 'human_request' THEN 3 WHEN 'round_delivery' THEN 4 ELSE 5 END, id LIMIT 32
```

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3123:96。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**turn.complete-131 ×1 — 校验/派生读取**

```sql
SELECT decision.id, decision.issue_id FROM multiremi_message_decision_records decision JOIN multiremi_issues issue ON issue.id = decision.issue_id WHERE decision.status = 'escalated' AND decision.reminder_sent_at IS NULL AND issue.workspace_id = ? AND ( SELECT o.sent_at FROM multiremi_feishu_bot_outbound_deliveries o JOIN multiremi_feishu_bot_chat_bindings b ON b.id = o.binding_id WHERE o.kind = 'decision_card' AND o.decision_id = decision.id AND b.bot_id = ? AND o.status = 'sent' AND o.external_message_id IS NOT NULL AND o.degraded IS NULL AND o.sent_at IS NOT NULL ORDER BY o.created_at DESC, o.id DESC LIMIT 1 ) <= ? ORDER BY decision.id ASC
```

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3318:38。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**turn.complete-132 ×1 — 校验/派生读取**

```sql
SELECT id, kind FROM multiremi_feishu_bot_outbound_deliveries WHERE workspace_id = ? AND delivery_mode = 'split' AND attempt_count >= 6 AND binding_id IN (SELECT id FROM multiremi_feishu_bot_chat_bindings WHERE workspace_id = ? AND bot_id = ?) AND ((status = 'pending' AND available_at <= ?) OR (status = 'sending' AND leased_until <= ?))
```

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3325:9。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**turn.complete-133 ×1 — 校验/派生读取**

```sql
SELECT request.id, request.task_id, request.expires_at, request.created_at, (SELECT MAX(card.sent_at) FROM multiremi_feishu_bot_outbound_deliveries card WHERE card.human_request_id=request.id AND card.kind='decision_card' AND card.status='sent' AND card.external_message_id IS NOT NULL AND card.degraded IS NULL) AS card_sent_at FROM multiremi_message_question_records request JOIN multiremi_turn_execution_records task ON task.id = request.task_id JOIN multiremi_conversation_log message ON message.id=request.id WHERE request.status = 'pending' AND request.reminder_sent_at IS NULL -- A reminder is worth sending only while it still leaves the reader -- time to act: under a minute of lifetime left, the nudge would arrive -- as the request expires. The bound is the same expression the CAS and -- the claim use, so SQLite and Postgres agree. AND (request.expires_at >= ? OR (request.expires_at IS NULL AND CAST(json_extract(CASE WHEN json_valid(message.metadata) THEN message.metadata ELSE '{}' END,'$.question.version') AS TEXT)='1' AND EXISTS (SELECT 1 FROM multiremi_feishu_bot_outbound_deliveries card WHERE card.human_request_id=request.id AND card.kind='decision_card' AND card.status='sent' AND card.external_message_id IS NOT NULL AND card.degraded IS NULL AND card.sent_at<=?))) AND task.issue_id IS NOT NULL AND task.workspace_id = ? AND ( SELECT COUNT(*) FROM multiremi_feishu_bot_outbound_deliveries o JOIN multiremi_feishu_bot_chat_bindings b ON b.id = o.binding_id WHERE o.kind = 'decision_card' AND o.human_request_id = request.id AND b.bot_id = ? AND o.status = 'sent' AND o.external_message_id IS NOT NULL AND o.degraded IS NULL ) > 0 ORDER BY request.expires_at ASC, request.id ASC
```

来源：packages/server/src/store/repos/feishu-bot-repo.ts:2519:7。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。 需保持 reply provenance、可见性、读取回执和通知范围。 需保留业务 Q 与 provider wait 分离、退出时 detachment。

**turn.complete-134 ×1 — 校验/派生读取**

```sql
SELECT d.*, COALESCE(d.outbound_task_id, d.task_id) AS target_task_id, b.chat_id, b.thread_id, s.open_id FROM multiremi_feishu_bot_deliveries d JOIN multiremi_feishu_bot_chat_bindings b ON b.id = d.binding_id AND b.workspace_id = d.workspace_id LEFT JOIN multiremi_feishu_bot_senders s ON s.id = d.sender_id WHERE d.workspace_id = ? AND d.outbound_requested = 1 AND b.chat_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM multiremi_feishu_bot_outbound_deliveries carrier WHERE carrier.task_id = COALESCE(d.outbound_task_id, d.task_id) AND (carrier.kind IS NULL OR carrier.kind = 'cot') AND carrier.unit_key = '') AND NOT EXISTS (SELECT 1 FROM multiremi_feishu_bot_deliveries earlier WHERE COALESCE(earlier.outbound_task_id, earlier.task_id) = COALESCE(d.outbound_task_id, d.task_id) AND earlier.outbound_requested = 1 AND (earlier.created_at < d.created_at OR (earlier.created_at = d.created_at AND earlier.external_message_id < d.external_message_id))) ORDER BY d.created_at, d.external_message_id LIMIT 32
```

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3196:63。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**turn.complete-135 ×1 — 校验/派生读取**

```sql
SELECT o.task_id FROM multiremi_feishu_bot_outbound_deliveries o JOIN multiremi_turn_execution_records t ON t.id = o.task_id WHERE o.workspace_id = ? AND o.kind = 'cot' AND o.delivery_mode = 'split' AND (t.status NOT IN ('completed', 'failed', 'cancelled') OR NOT EXISTS ( SELECT 1 FROM multiremi_feishu_bot_outbound_deliveries r WHERE r.task_id = o.task_id AND r.kind = 'result_card'))
```

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3213:8。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**turn.complete-136 ×1 — 校验/派生读取**

```sql
SELECT o.*, b.bot_id FROM multiremi_feishu_bot_outbound_deliveries o JOIN multiremi_feishu_bot_chat_bindings b ON b.id=o.binding_id AND b.workspace_id=o.workspace_id WHERE o.task_id = ? AND o.kind = 'cot' AND o.delivery_mode = 'split'
```

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3220:78。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**turn.complete-137 ×1 — 校验/派生读取**

```sql
SELECT * FROM multiremi_message_question_records WHERE task_id = ? ORDER BY created_at ASC, id ASC
```

来源：packages/server/src/store/repos/tasks-repo.ts:4906:7。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。 需保留业务 Q 与 provider wait 分离、退出时 detachment。

**turn.complete-138 ×1 — 校验/派生读取**

```sql
SELECT d.external_message_id FROM multiremi_feishu_bot_deliveries d JOIN multiremi_feishu_bot_chat_bindings b ON b.id = d.binding_id JOIN multiremi_feishu_bot_configs c ON c.workspace_id = d.workspace_id AND c.bot_id = b.bot_id AND c.app_id = b.app_id WHERE d.workspace_id = ? AND COALESCE(d.outbound_task_id, d.task_id) = ? ORDER BY d.created_at, d.external_message_id
```

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3276:54。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**turn.complete-139 ×1 — 必要写（当前契约）**

```sql
INSERT INTO multiremi_feishu_bot_outbound_deliveries (id, workspace_id, binding_id, task_id, chat_id, thread_id, reply_to_message_id, body, kind, unit_key, cascade_failure, delivery_mode, previous_delivery_id, human_request_id, human_request_task_id, target_message_id, mention_snapshot, interaction_open_id, degraded, status, available_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'split', ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?) ON CONFLICT DO NOTHING
```

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3235:19。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。

**turn.complete-140 ×1 — 校验/派生读取**

```sql
SELECT id FROM multiremi_feishu_bot_outbound_deliveries WHERE task_id = ? AND kind = ? AND unit_key = ?
```

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3279:7。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**turn.complete-141 ×1 — 校验/派生读取**

```sql
SELECT o.* FROM multiremi_feishu_bot_outbound_deliveries o JOIN multiremi_feishu_bot_chat_bindings b ON b.id = o.binding_id WHERE o.workspace_id = ? AND b.bot_id = ? AND b.app_id = ? AND (o.kind IS NULL OR o.kind NOT IN ('decision_card', 'decision_card_patch', 'decision_reminder') OR o.degraded IS NOT NULL) AND (? = 1 OR o.delivery_mode IS NULL OR o.delivery_mode = 'legacy') AND (o.decision_id IS NULL OR EXISTS ( SELECT 1 FROM multiremi_message_decision_records decision JOIN multiremi_issues target ON target.id = decision.issue_id AND target.workspace_id = decision.workspace_id JOIN multiremi_issues source ON source.id = decision.source_issue_id AND source.workspace_id = decision.workspace_id WHERE decision.id = o.decision_id AND decision.workspace_id = o.workspace_id AND decision.issue_id = o.decision_issue_id AND b.workspace_id = o.workspace_id AND b.issue_id = decision.issue_id )) AND NOT EXISTS ( SELECT 1 FROM multiremi_feishu_bot_round_pushes r WHERE r.wake_task_id = o.task_id AND r.binding_id = b.id AND r.workspace_id = o.workspace_id AND r.delivery_mode = 'proactive' AND (b.issue_id IS NULL OR b.issue_id <> r.issue_id) ) AND NOT EXISTS ( SELECT 1 FROM multiremi_feishu_bot_human_request_pushes h WHERE h.wake_task_id = o.task_id AND h.binding_id = b.id AND h.workspace_id = o.workspace_id AND (b.issue_id IS NULL OR b.issue_id <> h.issue_id) ) AND (o.task_id IS NULL OR ? = 1 OR o.body <> '') AND (? = 1 OR o.presentation_checkpoint IS NULL) AND (? = 1 OR o.attachments IS NULL) AND NOT EXISTS ( SELECT 1 FROM multiremi_feishu_bot_outbound_deliveries received WHERE o.kind = 'receipt' AND o.unit_key <> o.target_message_id || ':received' AND received.task_id = o.task_id AND received.kind = 'receipt' AND received.unit_key = o.target_message_id || ':received' AND received.status IN ('pending', 'sending')) AND (o.previous_delivery_id IS NULL OR EXISTS ( SELECT 1 FROM multiremi_feishu_bot_outbound_deliveries previous WHERE previous.id = o.previous_delivery_id AND previous.workspace_id = o.workspace_id AND (previous.status = 'sent' OR (o.cascade_failure = 0 AND previous.status = 'failed')))) AND ((o.status = 'pending' AND o.available_at <= ?) OR (o.status = 'sending' AND o.leased_until IS NOT NULL AND o.leased_until <= ?)) ORDER BY o.created_at ASC, o.id ASC LIMIT 1
```

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3409:9。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。


### task.fail: 166 executions

**task.fail-001 ×4 — 重复读/待进一步合并**

```sql
SELECT * FROM multiremi_turn_execution_records WHERE id = ?
```

来源：packages/server/src/store/repos/tasks-repo.ts:2671:98。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。

**task.fail-002 ×3 — 重复读/待进一步合并**

```sql
SELECT u.task_id AS task_id,u.provider,COALESCE(u.model,u.requested_model,'unknown') AS model, SUM(COALESCE(input_tokens,0)) AS input_tokens,SUM(COALESCE(output_tokens,0)) AS output_tokens, SUM(COALESCE(cache_read_tokens,0)) AS cache_read_tokens,SUM(COALESCE(cache_write_tokens,0)) AS cache_write_tokens, SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)+COALESCE(cache_read_tokens,0)+COALESCE(cache_write_tokens,0)+COALESCE(actual_unsplit_tokens,0)) AS total_tokens FROM multiremi_usage_units u WHERE u.task_id IN (?) AND source<>'context_snapshot' AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL OR cache_read_tokens IS NOT NULL OR cache_write_tokens IS NOT NULL OR actual_unsplit_tokens IS NOT NULL) GROUP BY u.task_id,u.provider,COALESCE(u.model,u.requested_model,'unknown') ORDER BY task_id,u.provider,model
```

来源：packages/server/src/store/usage-projection.ts:21:18。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。 用量由规范 ledger 投影，不能拿任务旧累计字段代替。

**task.fail-003 ×4 — 重复读/待进一步合并**

```sql
SELECT id FROM multiremi_autopilot_run_records WHERE task_id = ? ORDER BY created_at DESC LIMIT 1
```

来源：packages/server/src/store/repos/tasks-repo.ts:6847:7, packages/server/src/store/repos/tasks-repo.ts:7351:22。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。

**task.fail-004 ×10 — 重复读/待进一步合并**

```sql
SELECT runtime.*, profile.display_name AS daemon_display_name, drain.daemon_id AS draining_daemon_id FROM multiremi_runtimes runtime LEFT JOIN multiremi_daemon_drains drain ON drain.workspace_id = COALESCE(runtime.workspace_id, 'local') AND drain.daemon_id = COALESCE(runtime.daemon_id, runtime.id) LEFT JOIN multiremi_daemon_profiles profile ON profile.workspace_id = COALESCE(runtime.workspace_id, 'local') AND profile.daemon_id = runtime.daemon_id WHERE runtime.id = ?
```

来源：packages/server/src/store/repos/runtimes-repo.ts:632:7。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。 宿主/当前 attempt/排空资格需在序列化边界内确认。

**task.fail-005 ×2 — 重复读/待进一步合并**

```sql
SELECT 1 FROM multiremi_daemon_retirements WHERE workspace_id = ? AND daemon_id = ?
```

来源：packages/server/src/store/repos/daemon-retirement-repo.ts:160:7。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。

**task.fail-006 ×3 — 锁校验**

```sql
UPDATE multiremi_workspaces SET updated_at = updated_at WHERE id = ?
```

来源：packages/server/src/store/context.ts:1084:15。 保护 workspace/lane/插件串行边界；不同提交事务不能复用锁。本轮批量 lane 仍逐 lane 取得数据库互斥，不能改成无锁读取。

**task.fail-007 ×1 — 校验/派生读取**

```sql
SELECT * FROM multiremi_workspaces WHERE id = ?
```

来源：packages/server/src/store/repos/workspaces-repo.ts:581:86。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**task.fail-008 ×6 — 重复读/待进一步合并**

```sql
SELECT chat.id, chat.workspace_id, chat.creator_id, chat.agent_id, chat.runtime_workspace_id, chat.project_id, chat.title, chat.status, chat.session_id, chat.work_dir, chat.session_runtime_id, chat.session_provider, chat.session_execution_fingerprint, chat.latest_task_id, chat.pinned, chat.origin_autopilot_id, chat.origin_run_id, chat.created_at, chat.updated_at, (SELECT COUNT(*) FROM multiremi_conversation_log m LEFT JOIN multiremi_session_lanes legacy ON legacy.session_id = m.session_id AND legacy.reader_type = 'member' AND legacy.reader_id = m.to_member_id AND legacy.execution_scope = '' LEFT JOIN multiremi_workspace_read_cursors shared ON shared.session_id = m.session_id AND shared.workspace_id = chat.workspace_id WHERE m.session_id = chat.id AND m.kind = 'message' AND m.visibility = 'shown' AND m.to_member_id IS NOT NULL AND m.deleted_at IS NULL AND m.seq > COALESCE(legacy.cursor_seq, 0) AND m.seq > COALESCE(shared.cursor_seq, 0)) AS unread_count, (SELECT MIN(m.created_at) FROM multiremi_conversation_log m LEFT JOIN multiremi_session_lanes legacy ON legacy.session_id = m.session_id AND legacy.reader_type = 'member' AND legacy.reader_id = m.to_member_id AND legacy.execution_scope = '' LEFT JOIN multiremi_workspace_read_cursors shared ON shared.session_id = m.session_id AND shared.workspace_id = chat.workspace_id WHERE m.session_id = chat.id AND m.kind = 'message' AND m.visibility = 'shown' AND m.to_member_id IS NOT NULL AND m.deleted_at IS NULL AND m.seq > COALESCE(legacy.cursor_seq, 0) AND m.seq > COALESCE(shared.cursor_seq, 0)) AS reader_unread_since, (SELECT SUBSTR(m.body, 1, 240) FROM multiremi_chat_message_records m WHERE m.chat_session_id = chat.id ORDER BY m.sequence DESC, m.id DESC LIMIT 1) AS last_message_content, (SELECT m.role FROM multiremi_chat_message_records m WHERE m.chat_session_id = chat.id ORDER BY m.sequence DESC, m.id DESC LIMIT 1) AS last_message_role, (SELECT m.created_at FROM multiremi_chat_message_records m WHERE m.chat_session_id = chat.id ORDER BY m.sequence DESC, m.id DESC LIMIT 1) AS last_message_created_at FROM multiremi_chat_sessions chat WHERE chat.id = ?
```

来源：packages/server/src/store/repos/chat-repo.ts:252:79。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。 需保持 reply provenance、可见性、读取回执和通知范围。 宿主/当前 attempt/排空资格需在序列化边界内确认。

**task.fail-009 ×2 — 重复读/待进一步合并**

```sql
SELECT id, workspace_id, agent_id, chat_session_id, issue_id FROM multiremi_feishu_bot_chat_bindings WHERE chat_session_id = ?
```

来源：packages/server/src/store/repos/tasks-repo.ts:2847:7。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。

**task.fail-010 ×2 — 重复读/待进一步合并**

```sql
WITH RECURSIVE retry_lineage AS ( SELECT id, parent_task_id, workspace_id, agent_id, chat_session_id, task_kind, attempt FROM multiremi_turn_execution_records WHERE id = ? UNION ALL SELECT parent.id, parent.parent_task_id, parent.workspace_id, parent.agent_id, parent.chat_session_id, parent.task_kind, parent.attempt FROM multiremi_turn_execution_records parent JOIN retry_lineage child ON child.parent_task_id = parent.id AND child.workspace_id = parent.workspace_id AND child.agent_id = parent.agent_id AND child.chat_session_id = parent.chat_session_id AND child.task_kind = parent.task_kind AND child.attempt > 1 AND child.attempt = parent.attempt + 1 AND NOT EXISTS (SELECT 1 FROM multiremi_conversation_log retry_input JOIN multiremi_chat_sessions retry_session ON retry_session.id = retry_input.session_id WHERE retry_input.task_id = child.id AND retry_input.kind = 'message' AND retry_input.sender_type = 'member' AND retry_input.deleted_at IS NULL) ) SELECT push.binding_id, push.workspace_id, push.issue_id FROM multiremi_feishu_bot_round_pushes push JOIN retry_lineage lineage ON lineage.id = push.wake_task_id WHERE push.delivery_mode = 'proactive' UNION ALL SELECT push.binding_id, push.workspace_id, push.issue_id FROM multiremi_feishu_bot_human_request_pushes push JOIN retry_lineage lineage ON lineage.id = push.wake_task_id
```

来源：packages/server/src/store/repos/tasks-repo.ts:2867:72。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。 需保持 reply provenance、可见性、读取回执和通知范围。

**task.fail-011 ×1 — 必要写（当前契约）**

```sql
UPDATE multiremi_turns SET current_attempt_id=current_attempt_id WHERE id IN (SELECT turn_id FROM multiremi_turn_execution_records WHERE id = ? AND status IN ('dispatched', 'running', 'waiting_local_directory', 'awaiting_human'))
```

来源：packages/server/src/store/turn-execution-records.ts:179:8。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。

**task.fail-012 ×1 — 校验/派生读取**

```sql
SELECT target.*,owner.current_attempt_id AS mutation_current_attempt_id, owner.session_id AS mutation_session_id,owner.agent_id AS mutation_agent_id, owner.reply_message_id AS mutation_reply_message_id,owner.started_at AS mutation_started_at FROM (SELECT id,turn_id,('failed') AS mutation_0,(?) AS mutation_1,(?) AS mutation_2,(COALESCE(?, session_id)) AS mutation_3,(COALESCE(?, work_dir)) AS mutation_4,(NULL) AS mutation_5,(?) AS mutation_6,(?) AS mutation_7,(?) AS mutation_8 FROM multiremi_turn_execution_records WHERE id = ? AND status IN ('dispatched', 'running', 'waiting_local_directory', 'awaiting_human')) target JOIN multiremi_turns owner ON owner.id=target.turn_id
```

来源：packages/server/src/store/turn-execution-records.ts:188:63。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**task.fail-013 ×1 — 必要写（当前契约）**

```sql
UPDATE multiremi_turn_attempts SET status=?,error=?,failure_reason=?,session_id=?,work_dir=?,wait_reason=?,ended_at=?,updated_at=? WHERE id=?
```

来源：packages/server/src/store/turn-execution-records.ts:157:6。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。

**task.fail-014 ×1 — 必要写（当前契约）**

```sql
UPDATE multiremi_turns SET status=?,ended_at=?,ended_reason=? WHERE id=?
```

来源：packages/server/src/store/turn-execution-records.ts:157:6。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。

**task.fail-015 ×1 — 必要写（当前契约）**

```sql
INSERT INTO multiremi_task_traces (task_id, location, updated_at) VALUES (?, 'none', ?) ON CONFLICT(task_id) DO UPDATE SET location = 'none', runtime_id = NULL, updated_at = excluded.updated_at WHERE multiremi_task_traces.location = 'daemon'
```

来源：packages/server/src/store/repos/task-traces-repo.ts:55:17。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。 宿主/当前 attempt/排空资格需在序列化边界内确认。

**task.fail-016 ×2 — 重复读/待进一步合并**

```sql
SELECT id, workspace_id, runtime_id, status, agent_id, chat_session_id, issue_id, issue_session_id FROM multiremi_turn_execution_records WHERE id = ?
```

来源：packages/server/src/store/repos/tasks-repo.ts:2697:7。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。 宿主/当前 attempt/排空资格需在序列化边界内确认。

**task.fail-017 ×1 — 校验/派生读取**

```sql
SELECT id FROM multiremi_message_question_records WHERE task_id = ? AND status IN ('pending','responded')
```

来源：packages/server/src/store/repos/tasks-repo.ts:6983:7。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。 需保留业务 Q 与 provider wait 分离、退出时 detachment。

**task.fail-018 ×1 — 校验/派生读取**

```sql
SELECT t.id, t.status, t.current_attempt_id FROM multiremi_turns t JOIN multiremi_turn_attempts a ON a.turn_id = t.id WHERE a.id = ?
```

来源：packages/server/src/store/repos/tasks-repo.ts:6632:24。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**task.fail-019 ×1 — 必要写（当前契约）**

```sql
UPDATE multiremi_access_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE type = 'task' AND task_id = ? AND revoked_at IS NULL
```

来源：packages/server/src/store/repos/access-tokens-repo.ts:243:28。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。

**task.fail-020 ×1 — 校验/派生读取**

```sql
SELECT reply_message_id FROM multiremi_turns WHERE current_attempt_id=?
```

来源：packages/server/src/store/repos/chat-repo.ts:548:150。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**task.fail-021 ×5 — 重复读/待进一步合并**

```sql
SELECT turn_id FROM multiremi_turn_attempts WHERE id=?
```

来源：packages/server/src/store/repos/chat-repo.ts:551:107, packages/server/src/store/repos/conversation-log-repo.ts:488:107, packages/server/src/store/repos/conversation-log-repo.ts:820:95, packages/server/src/store/repos/tasks-repo.ts:7172:92。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。

**task.fail-022 ×1 — 校验/派生读取**

```sql
SELECT member.* FROM multiremi_workspace_members member JOIN multiremi_workspaces workspace ON workspace.id = member.workspace_id WHERE member.workspace_id = ? AND member.user_id = 'local' ORDER BY CASE WHEN member.id = ? THEN 0 ELSE 1 END, member.created_at, member.id LIMIT 1
```

来源：packages/server/src/store/repos/workspaces-repo.ts:138:8。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**task.fail-023 ×2 — 重复读/待进一步合并**

```sql
SELECT * FROM multiremi_workspace_members WHERE id = ?
```

来源：packages/server/src/store/repos/workspaces-repo.ts:189:93。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。

**task.fail-024 ×2 — 重复读/待进一步合并**

```sql
SELECT s.*, ( SELECT COUNT(*) FROM multiremi_conversation_log e WHERE e.session_id = s.parent_session_id AND e.kind <> 'head' AND e.seq > 0 AND ((s.inherit_mode = 'follow' AND (s.follow_frozen_seq IS NULL OR e.seq <= s.follow_frozen_seq)) OR (s.inherit_mode <> 'follow' AND e.seq <= s.inherit_cutoff_seq)) ) AS inherited_event_count FROM multiremi_issue_sessions s WHERE id = ?
```

来源：packages/server/src/store/repos/issue-sessions-repo.ts:433:17。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。 需保持 reply provenance、可见性、读取回执和通知范围。

**task.fail-025 ×1 — 校验/派生读取**

```sql
SELECT workspace_id FROM multiremi_autopilots WHERE session_id=?
```

来源：packages/server/src/store/inbox/send-message.ts:74:95。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**task.fail-026 ×2 — 重复读/待进一步合并**

```sql
SELECT * FROM multiremi_conversation_log WHERE id=? AND kind='message'
```

来源：packages/server/src/store/inbox/send-message.ts:20:100。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。 需保持 reply provenance、可见性、读取回执和通知范围。

**task.fail-027 ×4 — 重复读/待进一步合并**

```sql
SELECT * FROM multiremi_turns WHERE id=?
```

来源：packages/server/src/store/inbox/lane-machine.ts:79:71, packages/server/src/store/inbox/send-message.ts:54:73, packages/server/src/store/inbox/send-message.ts:57:73, packages/server/src/store/inbox/send-message.ts:91:92。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。

**task.fail-028 ×1 — 校验/派生读取**

```sql
SELECT * FROM multiremi_agents WHERE id = ?
```

来源：packages/server/src/store/repos/agents-skills-repo.ts:756:17。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**task.fail-029 ×1 — 校验/派生读取**

```sql
SELECT s.* FROM multiremi_skills s JOIN multiremi_agent_skills aks ON aks.skill_id = s.id WHERE aks.agent_id = ? AND s.archived_at IS NULL ORDER BY aks.created_at ASC, s.name ASC
```

来源：packages/server/src/store/repos/agents-skills-repo.ts:897:18。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**task.fail-030 ×1 — 锁校验**

```sql
UPDATE multiremi_chat_sessions SET updated_at=updated_at WHERE id=?
```

来源：packages/server/src/store/inbox/send-message.ts:153:20。 保护 workspace/lane/插件串行边界；不同提交事务不能复用锁。本轮批量 lane 仍逐 lane 取得数据库互斥，不能改成无锁读取。

**task.fail-031 ×1 — 校验/派生读取**

```sql
SELECT * FROM multiremi_conversation_heads WHERE session_id = ?
```

来源：packages/server/src/store/repos/conversation-log-repo.ts:574:9。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**task.fail-032 ×1 — 必要写（当前契约）**

```sql
UPDATE multiremi_conversation_heads SET workspace_id=COALESCE(workspace_id,?),updated_at=updated_at WHERE session_id=?
```

来源：packages/server/src/store/inbox/send-message.ts:155:10。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。

**task.fail-033 ×1 — 校验/派生读取**

```sql
SELECT MAX(created_at) AS at FROM multiremi_conversation_log WHERE session_id=? AND sender_type='member'
```

来源：packages/server/src/store/inbox/send-message.ts:63:144。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。 需保持 reply provenance、可见性、读取回执和通知范围。

**task.fail-034 ×1 — 校验/派生读取**

```sql
SELECT task_id FROM multiremi_conversation_log WHERE id=?
```

来源：packages/server/src/store/inbox/send-message.ts:59:117。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。 需保持 reply provenance、可见性、读取回执和通知范围。

**task.fail-035 ×1 — 校验/派生读取**

```sql
SELECT 1 FROM multiremi_squads s JOIN multiremi_squad_members m ON m.squad_id=s.id WHERE s.leader_id=? AND m.member_id=? AND m.member_type='agent' AND s.workspace_id=? AND s.archived_at IS NULL
```

来源：packages/server/src/store/inbox/send-message.ts:187:118。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**task.fail-036 ×2 — 重复读/待进一步合并**

```sql
SELECT * FROM multiremi_conversation_log WHERE id = ?
```

来源：packages/server/src/store/repos/conversation-log-repo.ts:598:92。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。 需保持 reply provenance、可见性、读取回执和通知范围。

**task.fail-037 ×1 — 必要写（当前契约）**

```sql
INSERT INTO multiremi_conversation_heads (session_id, head_seq, log_version, updated_at) VALUES (?, 1, 1, ?) ON CONFLICT(session_id) DO UPDATE SET head_seq = multiremi_conversation_heads.head_seq + 1, log_version = multiremi_conversation_heads.log_version + 1, updated_at = excluded.updated_at RETURNING head_seq
```

来源：packages/server/src/store/repos/conversation-log-repo.ts:552:28。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。

**task.fail-038 ×1 — 必要写（当前契约）**

```sql
INSERT INTO multiremi_conversation_log ( session_id, seq, id, kind, visibility, sender_type, sender_id, task_id, body_md, body_html, render_version, reply_to_id, resolved_at, resolved_by_type, resolved_by_id, metadata, revision, created_at, updated_at, deleted_at, to_type,to_ref,to_agent_id,to_member_id,message_kind,wake_requested,wake_applied,wake_reason,dedupe_key, options,card_token_hash,card_token_recipient,card_token_consumed_at ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
```

来源：packages/server/src/store/repos/conversation-log-repo.ts:492:17。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。 需保持 reply provenance、可见性、读取回执和通知范围。

**task.fail-039 ×3 — 重复读/待进一步合并**

```sql
SELECT * FROM multiremi_conversation_log WHERE session_id = ? AND seq = ?
```

来源：packages/server/src/store/repos/conversation-log-repo.ts:593:7。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。 需保持 reply provenance、可见性、读取回执和通知范围。

**task.fail-040 ×1 — 锁校验**

```sql
INSERT INTO multiremi_session_lanes(session_id,reader_type,reader_id,execution_scope,created_at,updated_at) VALUES(?,'member',?,'',?,?) ON CONFLICT DO NOTHING
```

来源：packages/server/src/store/inbox/send-message.ts:240:12。 保护 workspace/lane/插件串行边界；不同提交事务不能复用锁。本轮批量 lane 仍逐 lane 取得数据库互斥，不能改成无锁读取。

**task.fail-041 ×1 — 必要写（当前契约）**

```sql
UPDATE multiremi_turns SET reply_message_id=? WHERE current_attempt_id=?
```

来源：packages/server/src/store/repos/chat-repo.ts:562:59。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。

**task.fail-042 ×1 — 必要写（当前契约）**

```sql
UPDATE multiremi_turn_attempts SET failure_reason=? WHERE id=?
```

来源：packages/server/src/store/repos/conversation-log-repo.ts:828:32。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。

**task.fail-043 ×2 — 重复读/待进一步合并**

```sql
SELECT issue_id FROM multiremi_feishu_bot_chat_bindings WHERE chat_session_id = ? AND issue_id IS NOT NULL ORDER BY created_at ASC, id ASC LIMIT 1
```

来源：packages/server/src/store/repos/feishu-bot-repo.ts:1288:7。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。

**task.fail-044 ×4 — 重复读/待进一步合并**

```sql
SELECT p.*, COUNT(i.id) AS issue_count, COALESCE(SUM(CASE WHEN i.status IN ('done', 'completed', 'closed') THEN 1 ELSE 0 END), 0) AS done_count, ( SELECT COUNT(*) FROM multiremi_project_resources pr WHERE pr.project_id = p.id ) AS resource_count FROM multiremi_projects p LEFT JOIN multiremi_issues i ON i.project_id = p.id WHERE p.id = ? GROUP BY p.id
```

来源：packages/server/src/store/repos/projects-repo.ts:180:68。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。

**task.fail-045 ×2 — 重复读/待进一步合并**

```sql
SELECT * FROM multiremi_project_resources WHERE project_id = ? ORDER BY position ASC, created_at ASC, id ASC
```

来源：packages/server/src/store/repos/projects-repo.ts:457:7。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。

**task.fail-046 ×3 — 重复读/待进一步合并**

```sql
WITH selected AS (SELECT id FROM multiremi_runtimes WHERE id=?), owners AS ( SELECT t.runtime_id,t.turn_id AS task_id FROM multiremi_turn_execution_records t WHERE t.runtime_id IN (SELECT id FROM selected) UNION SELECT u.runtime_id,t.turn_id AS task_id FROM multiremi_usage_units u JOIN multiremi_turn_execution_records t ON t.id=u.task_id WHERE u.runtime_id IN (SELECT id FROM selected) ), counts AS (SELECT runtime_id,COUNT(*) AS task_count FROM owners GROUP BY runtime_id), lifecycle AS ( SELECT runtime_id,SUM(CASE WHEN status IN (?,?,?,?) THEN 1 ELSE 0 END) AS active_task_count, SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed_task_count, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed_task_count FROM multiremi_turn_execution_records t WHERE t.id=(SELECT current_attempt_id FROM multiremi_turns WHERE id=t.turn_id) AND runtime_id IN (SELECT id FROM selected) GROUP BY runtime_id ), tokens AS (SELECT u.runtime_id,SUM(COALESCE(u.input_tokens,0)) AS input_tokens,SUM(COALESCE(u.output_tokens,0)) AS output_tokens, SUM(COALESCE(u.cache_read_tokens,0)) AS cache_read_tokens,SUM(COALESCE(u.cache_write_tokens,0)) AS cache_write_tokens FROM multiremi_usage_units u JOIN multiremi_turn_execution_records t ON t.id=u.task_id WHERE u.runtime_id IN (SELECT id FROM selected) GROUP BY u.runtime_id) SELECT selected.id,counts.task_count,lifecycle.active_task_count,lifecycle.completed_task_count,lifecycle.failed_task_count, tokens.input_tokens,tokens.output_tokens,tokens.cache_read_tokens,tokens.cache_write_tokens FROM selected LEFT JOIN counts ON counts.runtime_id=selected.id LEFT JOIN lifecycle ON lifecycle.runtime_id=selected.id LEFT JOIN tokens ON tokens.runtime_id=selected.id
```

来源：packages/server/src/store/repos/runtimes-repo.ts:3079:57。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。 用量由规范 ledger 投影，不能拿任务旧累计字段代替。 宿主/当前 attempt/排空资格需在序列化边界内确认。

**task.fail-047 ×3 — 重复读/待进一步合并**

```sql
SELECT status, error FROM multiremi_runtime_update_requests WHERE runtime_id = ? AND scope = 'cli' ORDER BY CASE WHEN status IN ('pending', 'running', 'restarting', 'verifying') THEN 0 ELSE 1 END, created_at DESC, updated_at DESC, id DESC LIMIT 1
```

来源：packages/server/src/store/repos/runtimes-repo.ts:2914:7。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。 宿主/当前 attempt/排空资格需在序列化边界内确认。

**task.fail-048 ×3 — 重复读/待进一步合并**

```sql
SELECT group_id FROM multiremi_execution_group_members WHERE runtime_id = ? ORDER BY provider
```

来源：packages/server/src/store/repos/runtimes-repo.ts:2902:142。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。 宿主/当前 attempt/排空资格需在序列化边界内确认。

**task.fail-049 ×3 — 重复读/待进一步合并**

```sql
SELECT * FROM multiremi_runtime_models WHERE runtime_id = ? ORDER BY is_default DESC, label ASC
```

来源：packages/server/src/store/repos/runtimes-repo.ts:3016:135。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。 宿主/当前 attempt/排空资格需在序列化边界内确认。

**task.fail-050 ×1 — 校验/派生读取**

```sql
SELECT execution_fingerprint, work_dir, runtime_id FROM multiremi_turn_execution_records WHERE chat_session_id = ? AND issue_id IS NULL AND execution_fingerprint IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 1
```

来源：packages/server/src/store/chat-workspace.ts:39:51。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。 宿主/当前 attempt/排空资格需在序列化边界内确认。

**task.fail-051 ×1 — 必要写（当前契约）**

```sql
UPDATE multiremi_chat_sessions SET session_id = CASE WHEN ? = 1 THEN ? ELSE session_id END, work_dir = CASE WHEN ? = 1 THEN ? ELSE work_dir END, session_runtime_id = CASE WHEN ? = 1 THEN ? ELSE session_runtime_id END, session_provider = CASE WHEN ? = 1 THEN ? ELSE session_provider END, session_execution_fingerprint = CASE WHEN ? = 1 THEN ? ELSE session_execution_fingerprint END, latest_task_id = ?, unread_since = COALESCE(unread_since, ?), updated_at = ? WHERE id = ?
```

来源：packages/server/src/store/repos/tasks-repo.ts:6707:19。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。 宿主/当前 attempt/排空资格需在序列化边界内确认。

**task.fail-052 ×1 — 锁校验**

```sql
INSERT INTO multiremi_session_lanes(session_id,reader_type,reader_id,execution_scope,created_at,updated_at) VALUES(?,'agent',?,?,?,?) ON CONFLICT(session_id,reader_type,reader_id,execution_scope) DO UPDATE SET updated_at=multiremi_session_lanes.updated_at
```

来源：packages/server/src/store/inbox/lane-machine.ts:19:12。 保护 workspace/lane/插件串行边界；不同提交事务不能复用锁。本轮批量 lane 仍逐 lane 取得数据库互斥，不能改成无锁读取。

**task.fail-053 ×1 — 校验/派生读取**

```sql
SELECT 1 FROM multiremi_queued_messages WHERE session_id=? AND agent_id=? AND execution_scope=? AND status IN ('queued','failed') LIMIT 1
```

来源：packages/server/src/store/inbox/queued-messages.ts:102:106。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**task.fail-054 ×1 — 校验/派生读取**

```sql
SELECT queue_paused_at,queue_pause_reason FROM multiremi_session_lanes WHERE session_id=? AND reader_type='agent' AND reader_id=? AND execution_scope=?
```

来源：packages/server/src/store/inbox/queued-messages.ts:80:6。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**task.fail-055 ×1 — 必要写（当前契约）**

```sql
UPDATE multiremi_session_lanes SET queue_paused_at=?,queue_pause_reason=? WHERE session_id=? AND reader_type='agent' AND reader_id=? AND execution_scope=? AND queue_paused_at IS NULL
```

来源：packages/server/src/store/inbox/queued-messages.ts:87:17。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。

**task.fail-056 ×1 — 校验/派生读取**

```sql
SELECT cursor_seq FROM multiremi_session_lanes WHERE session_id=? AND reader_type='agent' AND reader_id=? AND execution_scope=?
```

来源：packages/server/src/store/inbox/lane-machine.ts:92:88。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**task.fail-057 ×1 — 校验/派生读取**

```sql
SELECT seq FROM multiremi_conversation_log WHERE id=?
```

来源：packages/server/src/store/inbox/lane-machine.ts:96:84。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。 需保持 reply provenance、可见性、读取回执和通知范围。

**task.fail-058 ×1 — 校验/派生读取**

```sql
SELECT id FROM multiremi_conversation_log WHERE session_id=? AND kind='message' AND to_agent_id=? AND seq>? AND wake_applied='now' AND deleted_at IS NULL AND COALESCE(json_extract(metadata,'$.execution_scope'),'')=? ORDER BY seq DESC LIMIT 1
```

来源：packages/server/src/store/inbox/lane-machine.ts:101:33。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。 需保持 reply provenance、可见性、读取回执和通知范围。

**task.fail-059 ×1 — 校验/派生读取**

```sql
SELECT event_count, tool_call_count, type_histogram, model, context_usage, worked_ms, process_item_count, late_subagents FROM multiremi_turn_attempts WHERE id = ?
```

来源：packages/server/src/store/store.ts:4697:7。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**task.fail-060 ×1 — 必要写（当前契约）**

```sql
UPDATE multiremi_turn_attempts SET tool_call_count=?,event_count=?,type_histogram=?,model=?,context_usage=?,worked_ms=?,process_item_count=?,late_subagents=? WHERE id=?
```

来源：packages/server/src/store/repos/conversation-log-repo.ts:828:32。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。

**task.fail-061 ×1 — 校验/派生读取**

```sql
SELECT session_id,seq FROM multiremi_turns WHERE id=?
```

来源：packages/server/src/store/repos/conversation-log-repo.ts:133:87。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**task.fail-062 ×1 — 必要写（当前契约）**

```sql
UPDATE multiremi_conversation_log SET revision=revision+?,updated_at=? WHERE session_id=? AND seq=?
```

来源：packages/server/src/store/repos/conversation-log-repo.ts:135:14。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。 需保持 reply provenance、可见性、读取回执和通知范围。

**task.fail-063 ×1 — 必要写（当前契约）**

```sql
UPDATE multiremi_conversation_heads SET log_version=log_version+?,updated_at=? WHERE session_id=?
```

来源：packages/server/src/store/repos/conversation-log-repo.ts:136:14。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。

**task.fail-064 ×1 — 校验/派生读取**

```sql
SELECT t.*,a.status AS attempt_status,a.attempt_no,a.failure_reason,a.progress_summary,a.event_count, a.tool_call_count,a.type_histogram,a.model,a.trace_ref,a.usage,a.started_at AS attempt_started_at,a.ended_at AS attempt_ended_at, a.context_usage,a.worked_ms,a.process_item_count,a.late_subagents FROM multiremi_turns t LEFT JOIN multiremi_turn_attempts a ON a.id=t.current_attempt_id WHERE t.id=?
```

来源：packages/server/src/store/turn-attempts.ts:82:58。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**task.fail-065 ×1 — 校验/派生读取**

```sql
SELECT body_md FROM multiremi_conversation_log WHERE id=?
```

来源：packages/server/src/store/turn-attempts.ts:84:108。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。 需保持 reply provenance、可见性、读取回执和通知范围。

**task.fail-066 ×1 — 校验/派生读取**

```sql
SELECT a.turn_id AS task_id,u.provider,COALESCE(u.model,u.requested_model,'unknown') AS model, SUM(COALESCE(input_tokens,0)) AS input_tokens,SUM(COALESCE(output_tokens,0)) AS output_tokens, SUM(COALESCE(cache_read_tokens,0)) AS cache_read_tokens,SUM(COALESCE(cache_write_tokens,0)) AS cache_write_tokens, SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)+COALESCE(cache_read_tokens,0)+COALESCE(cache_write_tokens,0)+COALESCE(actual_unsplit_tokens,0)) AS total_tokens FROM multiremi_usage_units u JOIN multiremi_turn_attempts a ON a.id=u.task_id WHERE a.turn_id IN (?) AND source<>'context_snapshot' AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL OR cache_read_tokens IS NOT NULL OR cache_write_tokens IS NOT NULL OR actual_unsplit_tokens IS NOT NULL) GROUP BY a.turn_id,u.provider,COALESCE(u.model,u.requested_model,'unknown') ORDER BY task_id,u.provider,model
```

来源：packages/server/src/store/usage-projection.ts:21:18。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。 用量由规范 ledger 投影，不能拿任务旧累计字段代替。

**task.fail-067 ×1 — 校验/派生读取**

```sql
SELECT id FROM multiremi_feishu_bot_outbound_deliveries WHERE task_id = ? AND kind = 'cot' AND delivery_mode = 'split'
```

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3055:72。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**task.fail-068 ×1 — 校验/派生读取**

```sql
SELECT DISTINCT runtime_id FROM multiremi_turn_execution_records WHERE workspace_id = ? AND status IN ('queued', 'dispatched')
```

来源：packages/server/src/store/repos/tasks-repo.ts:3336:71。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。 宿主/当前 attempt/排空资格需在序列化边界内确认。

**task.fail-069 ×1 — 校验/派生读取**

```sql
SELECT runtime.*, profile.display_name AS daemon_display_name, drain.daemon_id AS draining_daemon_id FROM multiremi_runtimes runtime LEFT JOIN multiremi_daemon_drains drain ON drain.workspace_id = COALESCE(runtime.workspace_id, 'local') AND drain.daemon_id = COALESCE(runtime.daemon_id, runtime.id) LEFT JOIN multiremi_daemon_profiles profile ON profile.workspace_id = COALESCE(runtime.workspace_id, 'local') AND profile.daemon_id = runtime.daemon_id WHERE runtime.id IN (?)
```

来源：packages/server/src/store/repos/runtimes-repo.ts:562:67。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。 宿主/当前 attempt/排空资格需在序列化边界内确认。

**task.fail-070 ×1 — 校验/派生读取**

```sql
SELECT runtime_id FROM multiremi_turn_execution_records WHERE workspace_id=? AND runtime_id IS NOT NULL AND status IN ('dispatched','running','waiting_local_directory','awaiting_human') UNION SELECT runtime_id FROM multiremi_feishu_bot_configs WHERE workspace_id=? AND runtime_id IS NOT NULL UNION SELECT runtime_id FROM multiremi_feishu_bot_runtime_states WHERE workspace_id=? AND (state<>'stopped' OR release_pending=1) UNION SELECT runtime_id FROM multiremi_background_tasks WHERE workspace_id=? AND lane_state<>'closed' UNION SELECT r.id AS runtime_id FROM multiremi_runtimes r JOIN multiremi_daemon_drains d ON d.workspace_id=COALESCE(r.workspace_id,'local') AND d.daemon_id=COALESCE(r.daemon_id,r.id) WHERE d.workspace_id=?
```

来源：packages/server/src/store/repos/runtimes-repo.ts:581:34。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。 宿主/当前 attempt/排空资格需在序列化边界内确认。

**task.fail-071 ×4 — 重复读/待进一步合并**

```sql
SELECT bot_id FROM multiremi_feishu_bot_configs WHERE workspace_id = ? AND runtime_id = ?
```

来源：packages/server/src/store/repos/feishu-bot-repo.ts:276:10。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。 宿主/当前 attempt/排空资格需在序列化边界内确认。

**task.fail-072 ×2 — 重复读/待进一步合并**

```sql
SELECT bot_id FROM multiremi_feishu_bot_runtime_states WHERE workspace_id = ? AND runtime_id = ? AND (state <> 'stopped' OR release_pending = 1) ORDER BY reported_at DESC LIMIT 1
```

来源：packages/server/src/store/repos/feishu-bot-repo.ts:284:10。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。 宿主/当前 attempt/排空资格需在序列化边界内确认。

**task.fail-073 ×4 — 重复读/待进一步合并**

```sql
SELECT * FROM multiremi_feishu_bot_configs WHERE workspace_id = ? AND bot_id = ?
```

来源：packages/server/src/store/repos/feishu-bot-repo.ts:434:17。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。

**task.fail-074 ×2 — 重复读/待进一步合并**

```sql
SELECT drain.deadline FROM multiremi_runtimes runtime JOIN multiremi_daemon_drains drain ON drain.workspace_id = COALESCE(runtime.workspace_id, 'local') AND drain.daemon_id = COALESCE(runtime.daemon_id, runtime.id) WHERE runtime.id = ?
```

来源：packages/server/src/store/store.ts:3506:30。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。 宿主/当前 attempt/排空资格需在序列化边界内确认。

**task.fail-075 ×2 — 重复读/待进一步合并**

```sql
SELECT id, status, runtime_id, agent_id FROM multiremi_turn_execution_records WHERE status IN (?, ?, ?, ?) AND runtime_id = ? ORDER BY created_at DESC
```

来源：packages/server/src/store/repos/tasks-repo.ts:3156:7。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。 宿主/当前 attempt/排空资格需在序列化边界内确认。

**task.fail-076 ×2 — 重复读/待进一步合并**

```sql
SELECT id, workspace_id, runtime_id, status, agent_id, chat_session_id, issue_id, issue_session_id FROM multiremi_turn_execution_records WHERE id IN (SELECT value FROM json_each(?))
```

来源：packages/server/src/store/repos/tasks-repo.ts:2710:33。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。 宿主/当前 attempt/排空资格需在序列化边界内确认。

**task.fail-077 ×1 — 校验/派生读取**

```sql
SELECT MIN(wake_at) AS wake_at FROM ( SELECT available_at AS wake_at FROM multiremi_feishu_bot_outbound_deliveries WHERE workspace_id = ? AND status = 'pending' AND available_at > ? UNION ALL SELECT leased_until AS wake_at FROM multiremi_feishu_bot_outbound_deliveries WHERE workspace_id = ? AND status = 'sending' AND leased_until > ? ) deadlines
```

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3551:19。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**task.fail-078 ×1 — 校验/派生读取**

```sql
SELECT request.created_at, request.expires_at FROM multiremi_message_question_records request JOIN multiremi_turn_execution_records task ON task.id = request.task_id WHERE task.workspace_id = ? AND task.issue_id IS NOT NULL AND request.status = 'pending' AND request.reminder_sent_at IS NULL AND request.expires_at IS NOT NULL AND EXISTS (SELECT 1 FROM multiremi_feishu_bot_outbound_deliveries delivery WHERE delivery.human_request_id = request.id AND delivery.kind = 'decision_card' AND delivery.status = 'sent' AND delivery.external_message_id IS NOT NULL AND delivery.degraded IS NULL)
```

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3560:8。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。 需保留业务 Q 与 provider wait 分离、退出时 detachment。

**task.fail-079 ×1 — 校验/派生读取**

```sql
SELECT MAX(delivery.sent_at) AS sent_at FROM multiremi_message_question_records request JOIN multiremi_turn_execution_records task ON task.id=request.task_id JOIN multiremi_conversation_log message ON message.id=request.id JOIN multiremi_feishu_bot_outbound_deliveries delivery ON delivery.human_request_id=request.id JOIN multiremi_feishu_bot_chat_bindings binding ON binding.id=delivery.binding_id AND binding.workspace_id=delivery.workspace_id WHERE task.workspace_id=? AND task.issue_id IS NOT NULL AND request.status='pending' AND binding.bot_id=? AND binding.app_id=? AND request.reminder_sent_at IS NULL AND request.expires_at IS NULL AND CAST(json_extract(CASE WHEN json_valid(message.metadata) THEN message.metadata ELSE '{}' END,'$.question.version') AS TEXT)='1' AND delivery.kind='decision_card' AND delivery.status='sent' AND delivery.external_message_id IS NOT NULL AND delivery.degraded IS NULL GROUP BY request.id
```

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3578:29。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。 需保持 reply provenance、可见性、读取回执和通知范围。 需保留业务 Q 与 provider wait 分离、退出时 detachment。

**task.fail-080 ×1 — 锁校验**

```sql
INSERT INTO multiremi_session_lanes (session_id,reader_type,reader_id,execution_scope,created_at,updated_at) SELECT t.session_id,'agent',t.agent_id,t.execution_scope,?,? FROM multiremi_turns t JOIN multiremi_turn_attempts a ON a.turn_id=t.id WHERE a.id IN (SELECT value FROM json_each(?)) AND t.current_attempt_id=a.id AND t.workspace_id=? AND a.runtime_id=? AND t.status IN ('running','awaiting_human') ORDER BY t.session_id,t.agent_id,t.execution_scope ON CONFLICT(session_id,reader_type,reader_id,execution_scope) DO UPDATE SET updated_at=multiremi_session_lanes.updated_at
```

来源：packages/server/src/store/inbox/daemon-turn-bridge.ts:124:19。 保护 workspace/lane/插件串行边界；不同提交事务不能复用锁。本轮批量 lane 仍逐 lane 取得数据库互斥，不能改成无锁读取。 宿主/当前 attempt/排空资格需在序列化边界内确认。

**task.fail-081 ×1 — 校验/派生读取**

```sql
SELECT t.*,a.id AS snapshot_attempt_id, a.input_ack_seq,a.input_read_seq,a.session_id AS provider_session_id, l.cursor_seq AS lane_cursor,COALESCE(h.head_seq,0) AS snapshot_head FROM multiremi_turns t JOIN multiremi_turn_attempts a ON a.turn_id=t.id JOIN multiremi_session_lanes l ON l.session_id=t.session_id AND l.reader_type='agent' AND l.reader_id=t.agent_id AND l.execution_scope=t.execution_scope LEFT JOIN multiremi_conversation_heads h ON h.session_id=t.session_id WHERE a.id IN (SELECT value FROM json_each(?)) AND t.current_attempt_id=a.id AND t.workspace_id=? AND a.runtime_id=? AND t.status IN ('running','awaiting_human')
```

来源：packages/server/src/store/inbox/daemon-turn-bridge.ts:138:26。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。 宿主/当前 attempt/排空资格需在序列化边界内确认。

**task.fail-082 ×1 — 必要写（当前契约）**

```sql
UPDATE multiremi_turn_attempts SET input_ack_seq=CASE WHEN COALESCE(session_id,'')='' THEN 0 ELSE COALESCE((SELECT l.cursor_seq FROM multiremi_session_lanes l JOIN multiremi_turns t ON t.session_id=l.session_id AND t.agent_id=l.reader_id AND t.execution_scope=l.execution_scope WHERE t.id=multiremi_turn_attempts.turn_id AND l.reader_type='agent'),0) END, input_read_seq=CASE WHEN COALESCE(session_id,'')='' THEN 0 ELSE COALESCE((SELECT l.cursor_seq FROM multiremi_session_lanes l JOIN multiremi_turns t ON t.session_id=l.session_id AND t.agent_id=l.reader_id AND t.execution_scope=l.execution_scope WHERE t.id=multiremi_turn_attempts.turn_id AND l.reader_type='agent'),0) END, input_read_offset=0 WHERE id IN (SELECT value FROM json_each(?)) AND input_ack_seq IS NULL
```

来源：packages/server/src/store/inbox/daemon-turn-bridge.ts:143:19。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。

**task.fail-083 ×1 — 校验/派生读取**

```sql
SELECT e.*,a.id AS snapshot_attempt_id FROM multiremi_turn_attempts a JOIN multiremi_turns t ON t.id=a.turn_id JOIN multiremi_conversation_log e ON e.session_id=t.session_id WHERE a.id IN (SELECT value FROM json_each(?)) AND e.seq>a.input_ack_seq AND e.seq<=COALESCE((SELECT h.head_seq FROM multiremi_conversation_heads h WHERE h.session_id=t.session_id),0) AND e.kind='message' AND e.deleted_at IS NULL AND e.visibility='shown' ORDER BY a.id,e.seq
```

来源：packages/server/src/store/inbox/daemon-turn-bridge.ts:160:31。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。 需保持 reply provenance、可见性、读取回执和通知范围。

**task.fail-084 ×1 — 必要写（当前契约）**

```sql
UPDATE multiremi_turn_attempts SET projection_to_seq=CASE WHEN COALESCE(projection_to_seq,0)<COALESCE((SELECT h.head_seq FROM multiremi_turns t JOIN multiremi_conversation_heads h ON h.session_id=t.session_id WHERE t.id=multiremi_turn_attempts.turn_id),0) THEN (SELECT h.head_seq FROM multiremi_turns t JOIN multiremi_conversation_heads h ON h.session_id=t.session_id WHERE t.id=multiremi_turn_attempts.turn_id) ELSE projection_to_seq END WHERE id IN (SELECT value FROM json_each(?))
```

来源：packages/server/src/store/inbox/daemon-turn-bridge.ts:173:19。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。

**task.fail-085 ×1 — 校验/派生读取**

```sql
SELECT 'update' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_update_requests WHERE runtime_id = ? AND status = 'pending' AND updated_at >= '2026-11-17T20:48:36.027Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_runtime_update_requests WHERE runtime_id = ? AND ((status = 'pending' AND updated_at < '2026-11-17T20:48:36.027Z') OR (status IN ('running', 'restarting', 'verifying') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T20:30:36.027Z'))) AS sweep, FALSE AS housekeeping UNION ALL SELECT 'model_list' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_model_list_requests WHERE runtime_id = ? AND status = 'pending' AND created_at >= '2026-11-17T20:50:06.027Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_runtime_model_list_requests WHERE runtime_id = ? AND ((status = 'pending' AND created_at < '2026-11-17T20:50:06.027Z') OR (status IN ('running') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T20:49:36.027Z'))) AS sweep, FALSE AS housekeeping UNION ALL SELECT 'command' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_command_requests WHERE runtime_id = ? AND status = 'pending' AND created_at >= '2026-11-17T20:47:36.027Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_runtime_command_requests WHERE runtime_id = ? AND ((status = 'pending' AND created_at < '2026-11-17T20:47:36.027Z') OR (status IN ('running') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T20:30:36.027Z'))) AS sweep, EXISTS (SELECT 1 FROM multiremi_runtime_command_requests WHERE runtime_id = ? AND status IN ('completed', 'failed', 'timeout') AND (command <> '' OR args <> '[]')) AS housekeeping UNION ALL SELECT 'local_skills' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_local_skill_list_requests WHERE runtime_id = ? AND status = 'pending' AND created_at >= '2026-11-17T20:47:36.027Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_runtime_local_skill_list_requests WHERE runtime_id = ? AND ((status = 'pending' AND created_at < '2026-11-17T20:47:36.027Z') OR (status IN ('running') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T20:49:36.027Z'))) AS sweep, FALSE AS housekeeping UNION ALL SELECT 'local_skill_import' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_local_skill_import_requests WHERE runtime_id = ? AND status = 'pending' AND created_at >= '2026-11-17T20:47:36.027Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_runtime_local_skill_import_requests WHERE runtime_id = ? AND ((status = 'pending' AND created_at < '2026-11-17T20:47:36.027Z') OR (status IN ('running') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T20:49:36.027Z'))) AS sweep, FALSE AS housekeeping UNION ALL SELECT 'gc_run' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_gc_run_requests WHERE runtime_id = ? AND status = 'pending' AND created_at >= '2026-11-17T20:40:36.027Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_runtime_gc_run_requests WHERE runtime_id = ? AND ((status = 'pending' AND created_at < '2026-11-17T20:40:36.027Z') OR (status IN ('running') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T20:40:36.027Z'))) AS sweep, FALSE AS housekeeping UNION ALL SELECT 'bot_menu' AS family, EXISTS (SELECT 1 FROM multiremi_bot_menu_publish_requests WHERE runtime_id = ? AND status = 'pending' AND created_at >= '2026-11-17T20:47:36.027Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_bot_menu_publish_requests WHERE runtime_id = ? AND ((status = 'pending' AND created_at < '2026-11-17T20:47:36.027Z') OR (status IN ('running') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T20:45:36.027Z'))) AS sweep, FALSE AS housekeeping UNION ALL SELECT 'directory_scan' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_directory_scan_requests WHERE runtime_id = ? AND status = 'pending' AND created_at >= '2026-11-17T20:47:36.027Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_runtime_directory_scan_requests WHERE runtime_id = ? AND ((status = 'pending' AND created_at < '2026-11-17T20:47:36.027Z') OR (status IN ('running') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T20:49:36.027Z'))) AS sweep, FALSE AS housekeeping
```

来源：packages/server/src/store/repos/runtimes-repo.ts:2747:68。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。 宿主/当前 attempt/排空资格需在序列化边界内确认。

**task.fail-086 ×2 — 重复读/待进一步合并**

```sql
SELECT * FROM multiremi_platform_maintenance WHERE id = 'platform'
```

来源：packages/server/src/store/repos/platform-maintenance-repo.ts:192:7。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。

**task.fail-087 ×2 — 重复读/待进一步合并**

```sql
SELECT * FROM multiremi_feishu_bot_runtime_states WHERE workspace_id = ? AND bot_id = ? AND runtime_id = ?
```

来源：packages/server/src/store/repos/feishu-bot-repo.ts:4182:8。 多个域入口或提交前后重新读取；当前缓存只在同步范围和最近锁之后复用，写入失效/回滚后必须重读。并非不可再删：需携带参数和锁代际进一步证明哪些是同一行同一快照，本轮未证明下限。 宿主/当前 attempt/排空资格需在序列化边界内确认。

**task.fail-088 ×1 — 校验/派生读取**

```sql
SELECT id, operation FROM multiremi_feishu_bot_outbound_operations WHERE workspace_id = ? AND ((status = 'pending' AND available_at <= ?) OR (status = 'processing' AND leased_until <= ?)) ORDER BY created_at, CASE kind WHEN 'topic' THEN 0 WHEN 'round' THEN 1 WHEN 'retarget' THEN 2 WHEN 'human_request' THEN 3 WHEN 'round_delivery' THEN 4 ELSE 5 END, id LIMIT 32
```

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3123:96。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**task.fail-089 ×1 — 校验/派生读取**

```sql
SELECT decision.id, decision.issue_id FROM multiremi_message_decision_records decision JOIN multiremi_issues issue ON issue.id = decision.issue_id WHERE decision.status = 'escalated' AND decision.reminder_sent_at IS NULL AND issue.workspace_id = ? AND ( SELECT o.sent_at FROM multiremi_feishu_bot_outbound_deliveries o JOIN multiremi_feishu_bot_chat_bindings b ON b.id = o.binding_id WHERE o.kind = 'decision_card' AND o.decision_id = decision.id AND b.bot_id = ? AND o.status = 'sent' AND o.external_message_id IS NOT NULL AND o.degraded IS NULL AND o.sent_at IS NOT NULL ORDER BY o.created_at DESC, o.id DESC LIMIT 1 ) <= ? ORDER BY decision.id ASC
```

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3318:38。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**task.fail-090 ×1 — 校验/派生读取**

```sql
SELECT id, kind FROM multiremi_feishu_bot_outbound_deliveries WHERE workspace_id = ? AND delivery_mode = 'split' AND attempt_count >= 6 AND binding_id IN (SELECT id FROM multiremi_feishu_bot_chat_bindings WHERE workspace_id = ? AND bot_id = ?) AND ((status = 'pending' AND available_at <= ?) OR (status = 'sending' AND leased_until <= ?))
```

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3325:9。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**task.fail-091 ×1 — 校验/派生读取**

```sql
SELECT request.id, request.task_id, request.expires_at, request.created_at, (SELECT MAX(card.sent_at) FROM multiremi_feishu_bot_outbound_deliveries card WHERE card.human_request_id=request.id AND card.kind='decision_card' AND card.status='sent' AND card.external_message_id IS NOT NULL AND card.degraded IS NULL) AS card_sent_at FROM multiremi_message_question_records request JOIN multiremi_turn_execution_records task ON task.id = request.task_id JOIN multiremi_conversation_log message ON message.id=request.id WHERE request.status = 'pending' AND request.reminder_sent_at IS NULL -- A reminder is worth sending only while it still leaves the reader -- time to act: under a minute of lifetime left, the nudge would arrive -- as the request expires. The bound is the same expression the CAS and -- the claim use, so SQLite and Postgres agree. AND (request.expires_at >= ? OR (request.expires_at IS NULL AND CAST(json_extract(CASE WHEN json_valid(message.metadata) THEN message.metadata ELSE '{}' END,'$.question.version') AS TEXT)='1' AND EXISTS (SELECT 1 FROM multiremi_feishu_bot_outbound_deliveries card WHERE card.human_request_id=request.id AND card.kind='decision_card' AND card.status='sent' AND card.external_message_id IS NOT NULL AND card.degraded IS NULL AND card.sent_at<=?))) AND task.issue_id IS NOT NULL AND task.workspace_id = ? AND ( SELECT COUNT(*) FROM multiremi_feishu_bot_outbound_deliveries o JOIN multiremi_feishu_bot_chat_bindings b ON b.id = o.binding_id WHERE o.kind = 'decision_card' AND o.human_request_id = request.id AND b.bot_id = ? AND o.status = 'sent' AND o.external_message_id IS NOT NULL AND o.degraded IS NULL ) > 0 ORDER BY request.expires_at ASC, request.id ASC
```

来源：packages/server/src/store/repos/feishu-bot-repo.ts:2519:7。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。 需保持 reply provenance、可见性、读取回执和通知范围。 需保留业务 Q 与 provider wait 分离、退出时 detachment。

**task.fail-092 ×1 — 校验/派生读取**

```sql
SELECT d.*, COALESCE(d.outbound_task_id, d.task_id) AS target_task_id, b.chat_id, b.thread_id, s.open_id FROM multiremi_feishu_bot_deliveries d JOIN multiremi_feishu_bot_chat_bindings b ON b.id = d.binding_id AND b.workspace_id = d.workspace_id LEFT JOIN multiremi_feishu_bot_senders s ON s.id = d.sender_id WHERE d.workspace_id = ? AND d.outbound_requested = 1 AND b.chat_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM multiremi_feishu_bot_outbound_deliveries carrier WHERE carrier.task_id = COALESCE(d.outbound_task_id, d.task_id) AND (carrier.kind IS NULL OR carrier.kind = 'cot') AND carrier.unit_key = '') AND NOT EXISTS (SELECT 1 FROM multiremi_feishu_bot_deliveries earlier WHERE COALESCE(earlier.outbound_task_id, earlier.task_id) = COALESCE(d.outbound_task_id, d.task_id) AND earlier.outbound_requested = 1 AND (earlier.created_at < d.created_at OR (earlier.created_at = d.created_at AND earlier.external_message_id < d.external_message_id))) ORDER BY d.created_at, d.external_message_id LIMIT 32
```

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3196:63。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**task.fail-093 ×1 — 校验/派生读取**

```sql
SELECT o.task_id FROM multiremi_feishu_bot_outbound_deliveries o JOIN multiremi_turn_execution_records t ON t.id = o.task_id WHERE o.workspace_id = ? AND o.kind = 'cot' AND o.delivery_mode = 'split' AND (t.status NOT IN ('completed', 'failed', 'cancelled') OR NOT EXISTS ( SELECT 1 FROM multiremi_feishu_bot_outbound_deliveries r WHERE r.task_id = o.task_id AND r.kind = 'result_card'))
```

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3213:8。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**task.fail-094 ×1 — 校验/派生读取**

```sql
SELECT o.*, b.bot_id FROM multiremi_feishu_bot_outbound_deliveries o JOIN multiremi_feishu_bot_chat_bindings b ON b.id=o.binding_id AND b.workspace_id=o.workspace_id WHERE o.task_id = ? AND o.kind = 'cot' AND o.delivery_mode = 'split'
```

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3220:78。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**task.fail-095 ×1 — 校验/派生读取**

```sql
SELECT * FROM multiremi_message_question_records WHERE task_id = ? ORDER BY created_at ASC, id ASC
```

来源：packages/server/src/store/repos/tasks-repo.ts:4906:7。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。 需保留业务 Q 与 provider wait 分离、退出时 detachment。

**task.fail-096 ×1 — 校验/派生读取**

```sql
SELECT d.external_message_id FROM multiremi_feishu_bot_deliveries d JOIN multiremi_feishu_bot_chat_bindings b ON b.id = d.binding_id JOIN multiremi_feishu_bot_configs c ON c.workspace_id = d.workspace_id AND c.bot_id = b.bot_id AND c.app_id = b.app_id WHERE d.workspace_id = ? AND COALESCE(d.outbound_task_id, d.task_id) = ? ORDER BY d.created_at, d.external_message_id
```

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3276:54。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**task.fail-097 ×1 — 必要写（当前契约）**

```sql
INSERT INTO multiremi_feishu_bot_outbound_deliveries (id, workspace_id, binding_id, task_id, chat_id, thread_id, reply_to_message_id, body, kind, unit_key, cascade_failure, delivery_mode, previous_delivery_id, human_request_id, human_request_task_id, target_message_id, mention_snapshot, interaction_open_id, degraded, status, available_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'split', ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?) ON CONFLICT DO NOTHING
```

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3235:19。 持久化本次状态/回复/序号/输入水位/通知意图；删除会使重放或提交后下行缺少事实。可继续与同事务写合并，但未证明这些 SQL 是最少写法。

**task.fail-098 ×1 — 校验/派生读取**

```sql
SELECT id FROM multiremi_feishu_bot_outbound_deliveries WHERE task_id = ? AND kind = ? AND unit_key = ?
```

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3279:7。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**task.fail-099 ×1 — 校验/派生读取**

```sql
SELECT o.* FROM multiremi_feishu_bot_outbound_deliveries o JOIN multiremi_feishu_bot_chat_bindings b ON b.id = o.binding_id WHERE o.workspace_id = ? AND b.bot_id = ? AND b.app_id = ? AND (o.kind IS NULL OR o.kind NOT IN ('decision_card', 'decision_card_patch', 'decision_reminder') OR o.degraded IS NOT NULL) AND (? = 1 OR o.delivery_mode IS NULL OR o.delivery_mode = 'legacy') AND (o.decision_id IS NULL OR EXISTS ( SELECT 1 FROM multiremi_message_decision_records decision JOIN multiremi_issues target ON target.id = decision.issue_id AND target.workspace_id = decision.workspace_id JOIN multiremi_issues source ON source.id = decision.source_issue_id AND source.workspace_id = decision.workspace_id WHERE decision.id = o.decision_id AND decision.workspace_id = o.workspace_id AND decision.issue_id = o.decision_issue_id AND b.workspace_id = o.workspace_id AND b.issue_id = decision.issue_id )) AND NOT EXISTS ( SELECT 1 FROM multiremi_feishu_bot_round_pushes r WHERE r.wake_task_id = o.task_id AND r.binding_id = b.id AND r.workspace_id = o.workspace_id AND r.delivery_mode = 'proactive' AND (b.issue_id IS NULL OR b.issue_id <> r.issue_id) ) AND NOT EXISTS ( SELECT 1 FROM multiremi_feishu_bot_human_request_pushes h WHERE h.wake_task_id = o.task_id AND h.binding_id = b.id AND h.workspace_id = o.workspace_id AND (b.issue_id IS NULL OR b.issue_id <> h.issue_id) ) AND (o.task_id IS NULL OR ? = 1 OR o.body <> '') AND (? = 1 OR o.presentation_checkpoint IS NULL) AND (? = 1 OR o.attachments IS NULL) AND NOT EXISTS ( SELECT 1 FROM multiremi_feishu_bot_outbound_deliveries received WHERE o.kind = 'receipt' AND o.unit_key <> o.target_message_id || ':received' AND received.task_id = o.task_id AND received.kind = 'receipt' AND received.unit_key = o.target_message_id || ':received' AND received.status IN ('pending', 'sending')) AND (o.previous_delivery_id IS NULL OR EXISTS ( SELECT 1 FROM multiremi_feishu_bot_outbound_deliveries previous WHERE previous.id = o.previous_delivery_id AND previous.workspace_id = o.workspace_id AND (previous.status = 'sent' OR (o.cascade_failure = 0 AND previous.status = 'failed')))) AND ((o.status = 'pending' AND o.available_at <= ?) OR (o.status = 'sending' AND o.leased_until IS NOT NULL AND o.leased_until <= ?)) ORDER BY o.created_at ASC, o.id ASC LIMIT 1
```

来源：packages/server/src/store/repos/feishu-bot-repo.ts:3409:9。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。

**task.fail-100 ×1 — 校验/派生读取**

```sql
SELECT 'update' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_update_requests WHERE runtime_id = ? AND status = 'pending' AND updated_at >= '2026-11-17T20:48:36.047Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_runtime_update_requests WHERE runtime_id = ? AND ((status = 'pending' AND updated_at < '2026-11-17T20:48:36.047Z') OR (status IN ('running', 'restarting', 'verifying') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T20:30:36.047Z'))) AS sweep, FALSE AS housekeeping UNION ALL SELECT 'model_list' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_model_list_requests WHERE runtime_id = ? AND status = 'pending' AND created_at >= '2026-11-17T20:50:06.047Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_runtime_model_list_requests WHERE runtime_id = ? AND ((status = 'pending' AND created_at < '2026-11-17T20:50:06.047Z') OR (status IN ('running') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T20:49:36.047Z'))) AS sweep, FALSE AS housekeeping UNION ALL SELECT 'command' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_command_requests WHERE runtime_id = ? AND status = 'pending' AND created_at >= '2026-11-17T20:47:36.047Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_runtime_command_requests WHERE runtime_id = ? AND ((status = 'pending' AND created_at < '2026-11-17T20:47:36.047Z') OR (status IN ('running') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T20:30:36.047Z'))) AS sweep, EXISTS (SELECT 1 FROM multiremi_runtime_command_requests WHERE runtime_id = ? AND status IN ('completed', 'failed', 'timeout') AND (command <> '' OR args <> '[]')) AS housekeeping UNION ALL SELECT 'local_skills' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_local_skill_list_requests WHERE runtime_id = ? AND status = 'pending' AND created_at >= '2026-11-17T20:47:36.047Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_runtime_local_skill_list_requests WHERE runtime_id = ? AND ((status = 'pending' AND created_at < '2026-11-17T20:47:36.047Z') OR (status IN ('running') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T20:49:36.047Z'))) AS sweep, FALSE AS housekeeping UNION ALL SELECT 'local_skill_import' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_local_skill_import_requests WHERE runtime_id = ? AND status = 'pending' AND created_at >= '2026-11-17T20:47:36.047Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_runtime_local_skill_import_requests WHERE runtime_id = ? AND ((status = 'pending' AND created_at < '2026-11-17T20:47:36.047Z') OR (status IN ('running') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T20:49:36.047Z'))) AS sweep, FALSE AS housekeeping UNION ALL SELECT 'gc_run' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_gc_run_requests WHERE runtime_id = ? AND status = 'pending' AND created_at >= '2026-11-17T20:40:36.047Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_runtime_gc_run_requests WHERE runtime_id = ? AND ((status = 'pending' AND created_at < '2026-11-17T20:40:36.047Z') OR (status IN ('running') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T20:40:36.047Z'))) AS sweep, FALSE AS housekeeping UNION ALL SELECT 'bot_menu' AS family, EXISTS (SELECT 1 FROM multiremi_bot_menu_publish_requests WHERE runtime_id = ? AND status = 'pending' AND created_at >= '2026-11-17T20:47:36.047Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_bot_menu_publish_requests WHERE runtime_id = ? AND ((status = 'pending' AND created_at < '2026-11-17T20:47:36.047Z') OR (status IN ('running') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T20:45:36.047Z'))) AS sweep, FALSE AS housekeeping UNION ALL SELECT 'directory_scan' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_directory_scan_requests WHERE runtime_id = ? AND status = 'pending' AND created_at >= '2026-11-17T20:47:36.047Z') AS claimable, EXISTS (SELECT 1 FROM multiremi_runtime_directory_scan_requests WHERE runtime_id = ? AND ((status = 'pending' AND created_at < '2026-11-17T20:47:36.047Z') OR (status IN ('running') AND run_started_at IS NOT NULL AND run_started_at < '2026-11-17T20:49:36.047Z'))) AS sweep, FALSE AS housekeeping
```

来源：packages/server/src/store/repos/runtimes-repo.ts:2747:68。 按 source 提供当前身份、所有权、派生输入或下行事实；保留现有调用契约，未证明不能并入集合查询。 宿主/当前 attempt/排空资格需在序列化边界内确认。

