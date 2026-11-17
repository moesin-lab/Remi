# MUL-163：认领候选只选择一次

基线：`d953761add45efd7b957a959d9f6ed7b27751fff`。本报告记录隔离环境验证，不代表 stable 已部署或线上验收完成。

`claimNextTaskForRuntime` 与 stale dispatch recovery 先从 attempts/turns 基表选择 ID，PG 使用 `FOR UPDATE OF claim_turn, claim_attempt SKIP LOCKED`，随后只按 ID 进入既有规范化变更器。保留工作区生命周期锁、插件配置锁、全部资格谓词和状态守卫；SQLite 仍由写事务串行化。VIEW 的通用变更器未改动。

索引候选集仍不足以避免逐候选扫描历史活跃记录。因此 `executionClaimBaseSql` 还物化一次活跃/租约 attempt ID 集合，由 attempt 的 accepted/running/waiting_local_directory、offered 且 offered_at 非空，以及 awaiting_human turn 的 current_attempt_id 取并集，供 runtime 容量、Agent 并发、lane 与共享目录探针复用；各探针仍自行过滤状态。保留 VIEW 对当前 awaiting_human 的覆盖，以及 unknown offer 重排后仍持有的共享 Chat 目录租约，未简单地用 attempt.status 代替 VIEW.status。回归覆盖全部 8 种 attempt 状态与 awaiting_human 覆盖的组合。

新增 expand-only 索引：attempt `(status, created_at, next_retry_at, turn_id)`、`(status, next_retry_at)`；turn `(status, current_attempt_id)`、`(chat_session_id, issue_session_id, priority, chat_queue_order)`。沿用既有 attempt `(runtime_id, status)` 和 turn `(agent_id, status)` 索引。两条启动迁移链在 Chat queue 列就绪后创建索引。migrations.ts 属于平台 dataSchema 指纹输入，因此源码变更会改变指纹；普通源码 PR 不提交指纹文件，发布仍须按既有流程取得跨指纹 rollbackSafeFrom 人工审核。

offer 生产默认保留 60 s 兜底扫描，防止漏接事件后任务长期排队；泵忙、等待或冷却中跳过扫描。扫描派出任务记 warn 和 `ws_minute_summary.offer_sweep_recovered`，用于定位并补齐遗漏的事件入口。ack/drain 只恢复有背压等待的泵，消除高频空认领。hello、入队、终态、容量/配置变化、冷却/重试/租约期限继续立即唤醒；测试环境默认禁用分钟扫描，可显式传入 `sweepMs`。

同一工作区锁内，未冻结任务的 Agent/runtime 执行组就绪事实按 Agent 缓存，避免对同一 Agent 的每条排队任务读取相同配置。缓存不跨认领或事务。

## EXPLAIN 证据

工具：`tests/manual/bench-claim-base-selection.ts`，创建并销毁独立数据库；PG 17.12、Bun 1.3.14、Linux x64、本地 TCP。10,201 turns/attempts，其中 10,000 终态、201 offered，单一可执行 Agent，不含真实用户 prompt。每条 EXPLAIN 在事务内运行后回滚，先 ANALYZE；比较双方均已安装新增索引，旧 SQL 来自独立 MUL-449 golden，新 SQL/参数从真实 claim 捕获。单次测量，顺序为旧 lock、旧 snapshot、新 selection，非吞吐或 p95 基准。

| 语句 | Execution Time (ms) | Shared hits | Shared reads |
|---|---:|---:|---:|
| 旧 VIEW lock + 重资格谓词 | 4851.525 | 142709 | 0 |
| 旧 VIEW mutation snapshot + 同一谓词 | 4424.958 | 142677 | 0 |
| 新基表 selection + 一次活跃 ID 集合 | 2.732 | 827 | 0 |

新选择后仍执行按主键的锁、快照和两张基表写入；表中的新耗时只覆盖 selection，不代表完整 claim API。旧查询虽然能使用新增队列索引，其 CASE 状态探针仍反复扫描历史；新查询将活跃集合从历史记录中按索引提取一次。原始 `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` 已附 Issue Session 消息 `cmt_khbojcbhftu9`，附件 `MUL-163-plans.txt`（内容为 JSON；平台不允许 json 扩展名附件）。

复跑（连接必须有创建/删除测试数据库权限）：

```sh
MULTIREMI_TEST_POSTGRES_URL=postgres://... bun tests/manual/bench-claim-base-selection.ts
```

## 其它变更器调用审计与边界

TasksRepo 的 offered/accepted、start、progress、usage、complete/fail、affinity 更新均已有具体 task ID。stale reclaim 是另一个候选子查询，已一并收敛。以下非认领批量路径仍保留两次通用谓词求值：runtime 合并时 `runtimes-repo.ts` 的 `WHERE runtime_id=?`，Issue 取消时 `issues-repo.ts` 的 `WHERE issue_id=? AND status NOT IN (...)`，以及退休/会话/知识清理等批量状态变更；本次不改批量锁定与快照语义。通用变更器的两阶段机制本身没有被移除。

本次查询数回归针对固定 Agent/执行目标、队列规模 1/10/50 的正常认领。不同 Agent/冻结 profile 的资格检查、affinity 修复和过时 wake 退休仍可随需检查/实际修复的记录增长；本次没有证明所有输入下整个 claim API 的 SQL 数均为常数。

上线验收仍由合并部署方完成：stable 上 8+ 并行轮次，确认热点不再居前、event_loop_lag_max 持续低于 1s、连续一小时没有 daemon_timeout。首次建索引沿用启动迁移锁，较大真实表可能增加启动时间。

## 实跑验证

Bun 均为 1.3.14。命令前将该版本加入 PATH，以确保派生进程也能找到 `bun`；PG 连接指向本轮自建 PG17.12（127.0.0.1:55464），测试自行创建/清理数据库。

```sh
bun test --timeout 30000 tests/unit/multiremi/multiremi-postgres-store.test.ts
# MULTIREMI_TEST_POSTGRES_URL 已设置：115 pass / 0 fail；含多连接认领、并发守卫与进程崩溃回滚。
bun test --timeout 120000 tests/unit/multiremi/multiremi-store-task-routing.test.ts tests/unit/multiremi/daemon-heartbeat-fanout-cost.test.ts tests/unit/multiremi/daemon-task-offers-pg.test.ts
# MULTIREMI_TEST_POSTGRES_URL 已设置：86 pass / 0 fail；SQLite 304 组、PG 99 组路由矩阵。
bun test --timeout 30000 tests/unit/multiremi/daemon-task-offers.test.ts tests/unit/multiremi/task-offer-routing.test.ts tests/unit/multiremi/multiremi-claim-hydrate-selected.test.ts tests/unit/multiremi/claim-queued-chat-query-count.test.ts
# SQLite：45 pass / 0 fail；后续新增 awaiting-human 矩阵另跑 cost 文件。
bun test --timeout 30000 tests/unit/multiremi/claim-queued-chat-query-count.test.ts
# SQLite 与设置 MULTIREMI_TEST_POSTGRES_URL 的 PG 各跑一次：3 pass / 0 fail。
bun x tsc --noEmit
npm run docs:test
npm run docs:check
```

SQL 次数回归在 statement.get/all/run 执行时计数（不将 prepare 视为执行），同时拦截 db.run；空 claim 队列 1/10/50 下 SELECT 计数为 22/22/22，成功 claim 队列 1/50 下 query/run 调用计数为 78/78，重候选选择均仅执行 1 次。常数范围如上节所述，不覆盖不同 Agent/profile 和需要逐条修复的历史坏状态。

排障中确实出现的失败：PG15 的现有 `IS JSON OBJECT` 迁移语法不支持（改用 PG17）；最初大 payload PG offer 触及默认 5s 测试超时（30s 后通过）；首次 broad PG 五个子进程找不到 PATH 中的 bun（配置 Bun1.3.14 PATH 后全文件 115 项通过）。早期新增成功 claim 成本测试还抓到按 queued task 重读执行组就绪配置，已改为锁内按 Agent 复用并重跑通过。未跳过这些失败来宣称通过。

## 架构复核增量：保留默认兜底扫描

恢复生产默认 `DAEMON_OFFER_SWEEP_MS`（60 s），测试环境默认使用最大计时周期；保留普通 ack/drain 不唤醒非 waiting 泵的回归。新增生产默认构造回归：无直接入队触发的 queued 任务在 59,999 ms 尚未派出，60,000 ms 派出并记 warn，实际 `ws_minute_summary.offer_sweep_recovered` 为 1，下次汇总归零。显式扫描配置的 pending offer 跳过用例仍保留。

Bun 1.3.14 / 本轮隔离 PG 17.12 实跑：

```sh
bun test --timeout 30000 tests/unit/multiremi/daemon-task-offers.test.ts tests/unit/multiremi/claim-queued-chat-query-count.test.ts
# SQLite：36 pass / 0 fail，248 assertions。
MULTIREMI_TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:55464/postgres bun test --timeout 30000 tests/unit/multiremi/daemon-task-offers-pg.test.ts tests/unit/multiremi/claim-queued-chat-query-count.test.ts
# PostgreSQL：8 pass / 0 fail，70 assertions；无跳过。
bun x tsc --noEmit
npm run docs:test
npm run docs:check
# 均退出 0；docs:test 13 pass / 0 fail。
```

此次不改变基表选择或批量变更器范围，EXPLAIN 沿用上节既有测量；线上验收仍未执行。

## 合并后复核修复：unknown offer 共享目录租约

审阅发现原物化集合剔除了 VIEW 中 `queued AND offered_at IS NOT NULL` 的记录，导致 unknown offer 重排后，其他 Session 的高优先级任务可能抢占同一 Chat checkout。修复将基表 `offered AND offered_at IS NOT NULL` ID 纳入集合，各调用点原状态过滤不变。已有 Session 双所有权回归修复前 1 pass / 1 fail，修复后全文件通过；另在可切换双库的 claim 回归文件加入 unknown 保留租约、rejected 释放租约、迟到启动守卫及完成后释放的业务验证。

Bun 1.3.14，本轮独立 PG 18.6（127.0.0.1:55464），实际命令：

```sh
bun test --timeout 30000 tests/unit/multiremi/daemon-task-offers.test.ts tests/unit/multiremi/claim-queued-chat-query-count.test.ts tests/unit/multiremi/session-dual-owner-task.test.ts
# SQLite：60 pass / 0 fail，505 assertions。
MULTIREMI_TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:55464/postgres bun test --timeout 30000 tests/unit/multiremi/daemon-task-offers-pg.test.ts tests/unit/multiremi/claim-queued-chat-query-count.test.ts
# PostgreSQL：10 pass / 0 fail，87 assertions，无跳过。
bun x tsc --noEmit
npm run docs:test
npm run docs:check
# 均退出 0；docs:test 13 pass / 0 fail。
MULTIREMI_TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:55464/postgres MUL163_PLAN_OUTPUT=/tmp/MUL-163-lease-plans.txt bun tests/manual/bench-claim-base-selection.ts
```

相同 10,201 turns / 201 queued 隔离夹具重新 EXPLAIN：旧 lock 5431.145 ms / 142681 shared hits，旧 snapshot 5333.839 ms / 142671 hits，修复后 selection 3.254 ms / 1035 hits；单次暖缓存测量，不代表线上 API 延迟。SQL 执行次数仍为空 claim 22/22/22、成功 claim 78/78，候选仅一次。原始计划随本轮 Session 回复附件交付。批量变更器继续由 MUL-165 跟进，stable 验收与独立复审尚未完成。
