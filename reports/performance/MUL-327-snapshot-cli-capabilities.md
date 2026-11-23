# MUL-327 / MUL-279 / MUL-330: `agent-task-snapshot` 与 `cli/capabilities` 热路径优化报告

## 范围与实验环境

- **关联单据**：`MUL-327`（性能主线）、`MUL-279`（页面/CLI 热路径）、`MUL-330`（本子单）
- **基线提交**：`d69bc1d46`（`origin/main`）
- **运行环境**：Bun 1.3.14（Linux x64），内存 SQLite（本地环境无 PostgreSQL 服务；真实 PostgreSQL 17 语义与预算验证交由 PR CI 后端分片执行 `tests/unit/multiremi/snapshot-cli-capabilities-cost.test.ts`）。
- **Schema 影响**：零 `dataSchema` 变更，未新增迁移或索引，完全复用既有索引 `idx_turn_attempts_claim_retry(status, next_retry_at)`、`idx_multiremi_turns_workspace_status_created(workspace_id, status, created_at DESC, id DESC)` 与 `idx_multiremi_turn_attempts_turn_no(turn_id, attempt_no)`。
- **测量声明**：下文数据均为同机同夹具的隔离 SQLite 测量结果（含完整 HTTP 路由处理与客户端 `res.json()` 解析），用于对照 SQL 次数、视图扫描次数和同夹具相对开销，不代表生产 PostgreSQL 延迟或吞吐结论。

## 根因与改动摘要

### 1. `GET /api/agent-task-snapshot`（`listWorkspaceAgentTaskSnapshot`）

- **改前根因**（`packages/server/src/store/repos/tasks-repo.ts`）：
  单条 SQL 在 `ranked_outcomes`、`candidates` 活跃分支和主查询中对 `multiremi_turn_execution_records` 视图做 **3 次引用/扫描**。由于活跃分支在视图派生列 `status`（`CASE WHEN ... END`）上过滤，查询计划无法命中 `multiremi_turn_attempts(status, ...)` 或 `multiremi_turns(workspace_id, status, ...)` 索引，被迫对工作区历史表再扫一遍。
- **改后方案**：
  1. 在 `ranked_outcomes` 与 `candidates AS MATERIALIZED (...)` 中直接面向基表 `multiremi_turns` 和 `multiremi_turn_attempts` 计算候选 `attempt.id` 集合：
     - 活跃非等待人工分支：`a.status IN ('offered', 'accepted', 'running', 'waiting_local_directory')` 走 `idx_turn_attempts_claim_retry` + `EXISTS` 主键回查 `multiremi_turns`；
     - 活跃 `awaiting_human` 分支：`t.workspace_id = ? AND t.status = 'awaiting_human'` 走 `idx_multiremi_turns_workspace_status_created` + 主键回查 `multiremi_turn_attempts(id)`；
     - 最新终态分支：`a.status IN ('completed', 'failed', 'lost')` 且 `(t.status <> 'awaiting_human' OR t.current_attempt_id IS NULL OR t.current_attempt_id <> a.id)`（严格处理 SQL 三值逻辑中 `current_attempt_id IS NULL` 情形），按 `COALESCE(a.ended_at, a.updated_at, a.created_at) DESC` 对每个 `t.agent_id` 仅取 `outcome_rank = 1`；
  2. 最后将物化后的少量候选 `candidates` 与 `multiremi_turn_execution_records` 做 **1 次主键连接**（`task.id = candidates.id`），随后应用 `chatAccess` 可见性过滤（确保不可见的最新结果不会把更早的历史结果顶上来）并执行 `withTaskAutopilotRuns`。

### 2. `GET /api/cli/capabilities` 与 `currentTaskIssueCreationRestricted`

- **改前根因**（`packages/server/src/api/routers/cli.ts`、`packages/server/src/api/helpers/issues.ts`）：
  1. 每次请求都对 `CLI_CAPABILITIES_RUNTIME.commands`（当前 538 条命令）执行 `Object.entries(...).map(...).sort((l, r) => l.id.localeCompare(r.id))` 及 82 KB JSON 序列化；
  2. 对 `local` 工作区仍先调用 `store.getWorkspace("local")` 做全列读取；
  3. Task 凭据调用 `Boolean(restrictedTaskIssueCreationAgent(c, deps.store))` 时，依次触发 `store.getTask(taskId)`（视图全列 + usage + autopilot runs = 3 条 SQL）、`store.getAgent(agentId)`（Agent 全列 + skills = 2 条 SQL）、`isFeishuBotTaskIssueCreationRestricted(taskId)`（1 条 SQL），命中受限时还会再次调用 `store.getAgent(agentId)`（再多 2 条 SQL）。
- **改后方案**：
  1. 在 `cli.ts` 模块加载期按 `id.localeCompare` 排序一次并预构建、预序列化 5 份只读 JSON 响应（`human` / `daemon` / `share` / `task` 未受限 / `task` 受限），请求期仅按身份与受限布尔值直接返回；
  2. 非 `local` 工作区存在性校验改用 `deps.store.hasWorkspace(resolved.workspaceId)`（`local` 直接短路，零 `SELECT * FROM multiremi_workspaces`）；
  3. 在 `TasksRepo`（并委托到 `MultiremiStore`）提供单次轻量查询 `getTaskIssueCreationRestrictionState(taskId, agentId)`（及委托方法 `getTaskIssueCreationRestrictionCode`），在单条 SQL 中同时返回 `restriction_code`（保持 `agent.issue_creation_requires_proposal` / `task.issue_creation_restricted` 优先于飞书发送者白名单 `WITH RECURSIVE lineage` 检查，且先按当前工作区是否存在未批准 allowlist 投递短路）与 `agent_exists`（通过单次主键 `LEFT JOIN multiremi_agents` 判定），零全量实体/skills/usage/autopilot 水合；写入路径（`currentTaskIssueCreationRestricted` / `denyRestrictedTaskIssueCreation`）继续严格按 `code !== null` 拦截，而 `cli.ts` 调用 `hasRestrictedTaskIssueCreationAgent(c, deps.store)`（`code !== null && agentExists`），在零额外 SQL（仍 ≤ 4 reads）下 100% 保持与原 `Boolean(restrictedTaskIssueCreationAgent)` 的历史语义一致。

## 同夹具改前/改后实测对照（SQLite）

夹具规模：12 个 Agent（各自带 16 KiB `instructions`）、1,500 条历史 turn（含每 5 条 1 次重试共 1,800 条历史 attempt，覆盖 `completed`、`failed`、`lost`、`cancelled`，每条携带 8 KiB `legacy_prompt` 与 8 KiB 回复正文）、8 条活跃任务（含 `offered`、`accepted`、`running`、`waiting_local_directory`、`awaiting_human` 及 `a.status='failed'` 的 `awaiting_human` 覆盖）、1 个开启 `allowlist` 的飞书机器人与未批准发送者。每项均先预热 5 次，再记录单次请求稳态 SQL 条数及连续采样耗时（snapshot 40 次、capabilities 100 次，均含客户端 `res.json()`）。

| 场景 | 改前 SQL | 改后 SQL | SQL 变化 | 改前视图扫描 | 改后视图扫描 | 改前 mean / p50 / p95 (ms) | 改后 mean / p50 / p95 (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `GET /api/agent-task-snapshot` (`human`) | 5 | 5 | 0 | 3 | 1 | 6.328 / 5.696 / 7.921 | 4.856 / 4.398 / 6.418 |
| `GET /api/agent-task-snapshot` (`task`) | 6 | 6 | 0 | 3 | 1 | 6.067 / 5.758 / 6.614 | 4.813 / 4.452 / 6.282 |
| `GET /api/cli/capabilities` (`human`, `local`) | 3 | 2 | -33% | 0 | 0 | 0.731 / 0.632 / 1.266 | 0.457 / 0.389 / 0.573 |
| `GET /api/cli/capabilities` (`daemon`, `local`) | 2 | 1 | -50% | 0 | 0 | 0.675 / 0.592 / 0.655 | 0.394 / 0.356 / 0.395 |
| `GET /api/cli/capabilities` (`share`, `local`) | 2 | 1 | -50% | 0 | 0 | 0.508 / 0.507 / 0.548 | 0.265 / 0.258 / 0.315 |
| `GET /api/cli/capabilities` (`task` 未受限，含 allowlist 飞书) | 10 | 4 | -60% | 1 | 0 | 2.578 / 2.441 / 2.954 | 1.850 / 1.737 / 2.489 |
| `GET /api/cli/capabilities` (`task` 任务受限标志) | 9\* | 4 | -56% | 1 | 0 | —\* | 0.541 / 0.482 / 0.617 |
| `GET /api/cli/capabilities` (`task` Agent 提案策略受限) | 9 | 4 | -56% | 1 | 0 | 1.136 / 1.091 / 1.134 | 0.514 / 0.483 / 0.517 |
| `GET /api/cli/capabilities` (`task` 飞书白名单受限) | 12 | 4 | -67% | 1 | 0 | 2.502 / 2.447 / 2.774 | 1.726 / 1.654 / 1.963 |

> \* 注：改前采集脚本中 `task` 任务受限用例误与未受限任务复用了同一 `issueSessionId` 导致 pending turn 合并，故表中标注其对应原代码路径确定性 SQL 次数（鉴权 2 + `hasWorkspace` 1 + `getWorkspace` 1 + `getTask` 3 + 第二次 `getAgent` 2 = 9，与 `agent` 受限路径完全一致），不虚报改前耗时；改后在独立 session 上实测为 4 条 SQL、mean 0.541 ms。此外，当仅读取响应文本（不含客户端 `res.json()` 解析 82 KiB JSON）时，预序列化后 `human`/`daemon`/`share`/`task_flag`/`agent_flag` 耗时分别为 `0.228` / `0.194` / `0.072` / `0.275` / `0.277 ms`，无飞书 allowlist 工作区的未受限 `task` 耗时为 `0.343 ms`。

### SQLite `EXPLAIN QUERY PLAN` 核对

- **改前 `listWorkspaceAgentTaskSnapshot`**：
  - 活跃候选分支对 `multiremi_turns` 走 `idx_multiremi_turns_workspace_status_created (workspace_id=?)` 全工作区扫描 + `multiremi_turn_attempts`；
  - `ranked_outcomes` 再对 `multiremi_turns` 走全工作区扫描 + `multiremi_turn_attempts`；
  - 主查询扫描 `candidates` 并按主键回查 `multiremi_turn_attempts` 与 `multiremi_turns`。
- **改后 `listWorkspaceAgentTaskSnapshot`**：
  - 活跃非等待分支：`SEARCH a USING INDEX idx_turn_attempts_claim_retry (status=?)` + `SEARCH t EXISTS USING INDEX sqlite_autoindex_multiremi_turns_1 (id=?)`（仅触及活跃 attempt）；
  - 活跃 `awaiting_human` 分支：`SEARCH t USING INDEX idx_multiremi_turns_workspace_status_created (workspace_id=? AND status=?)` + `SEARCH a USING INDEX sqlite_autoindex_multiremi_turn_attempts_1 (id=?)`；
  - `ranked_outcomes`：仅在基表 `multiremi_turns` + `multiremi_turn_attempts` 上扫描一次并计算 `ROW_NUMBER()`；
  - `candidates` 物化后，主查询仅对命中的少量 ID 通过主键 `id=?` 连接 `multiremi_turn_execution_records` 一次。

## 自动化验证覆盖

- 新增单测：`tests/unit/multiremi/snapshot-cli-capabilities-cost.test.ts`（接入 `useMigratedHotspotDatabases` / `openHotspotDatabase`，本地运行 SQLite，CI 自动运行真实 PostgreSQL 17）：
  1. `listWorkspaceAgentTaskSnapshot` 新旧实现逐字段严格等价测试：覆盖同一 Agent 多轮与多 attempt 重试、`lost`、`offered`/`accepted`/`waiting_local_directory`、`awaiting_human`（含 `a.status='failed'` 覆盖、同 turn 旧失败 attempt 仍参与终态排名、`current_attempt_id IS NULL` 三值逻辑）、`ended_at IS NULL` 回退、私密 Chat 隐藏最新结果不顶出旧结果、受损 `chat_session_id=NULL` 投影私密 Session、Task token 本人/他任务/错 Agent/错 Workspace 访问控制、跨工作区隔离与 `autopilotRunId` 挂载。
  2. `GET /api/cli/capabilities` 与 `getTaskIssueCreationRestrictionState` / `getTaskIssueCreationRestrictionCode` 等价测试：覆盖 `human`/`daemon`/`share`/`task` 全部身份，以及未受限、任务受限标志、孤立历史数据（移除 `multiremi_agents` 行后 capabilities 返回 `allowed: true` 且写入端仍 403 拦截）、Agent 提案策略、飞书白名单直达任务、飞书委派子任务血缘、多限制优先级、批准发送者后实时解除受限、非 `local` 工作区 200/404。
  3. 同一夹具的 SQL 次数、单次视图引用与耗时预算测试（所有既有测试与预算未放宽）。

## 遗留边界与说明

- 本机环境未安装 PostgreSQL，未在本地执行真实 PostgreSQL 实测；真实 PG 17 下的 SQL 执行与预算断言将由 PR CI 后端分片验证。
- `ranked_outcomes` 在工作区存在海量历史终态记录时仍需在基表扫描该工作区终态行以按 `agent_id` 求最新 1 条；本次遵守零 `dataSchema` 变更原则未新增索引，若线上 PG 采样显示单次基表扫描仍构成热点，可在后续独立 B1 `expand` 迁移中评估按 `(workspace_id, agent_id)` 或 `(turn_id, status, ended_at)` 覆盖索引。
- 按并行协作边界，本次未修改 `packages/server/src/store/repos/issues-repo.ts` 与 `docs/dev/performance.md`。
