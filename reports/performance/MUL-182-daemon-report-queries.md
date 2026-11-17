# MUL-182 daemon 报告与消息读取查询预算

基线：`87fd55c0f`。测试数据库为本地 SQLite；这些数字是 SQL 执行次数，不是生产 PostgreSQL 延迟或线上验收结论。

## 复现和结果

同一份 `tests/unit/multiremi/daemon-report-query-budget.test.ts` 分别在隔离的基线 worktree 和修复工作树实跑。统计 query/prepare/run/exec 的实际执行，包括 WITH 与写语句，并等待 `DaemonProtocolLayer.drain()`，计入排队的下行和 offer。SQLite 的 query 内部调用 prepare，探针去重，避免重复计数。

夹具有 8 个 Runtime、4 个 daemon 连接、一个 Issue 任务和另一个 Runtime 上持续运行的 Chat 任务。小/大夹具分别有 2/40 条上下文，上报任务与 Chat 的 retry ancestry 均为 1/8 个 attempt；飞书用例另外有 2/40 条历史 outbound。终态帧包含真实的空 trace、最终回复和 model 字段。远端 provider/飞书发送不在本地预算测试范围内。

| 路径 | 基线：小 / 大 | 修复：小 / 大 | 固定上限 |
|---|---:|---:|---:|
| task.workspace | 467 / 544 | 38 / 38 | 48 |
| turn.complete | 789 / 828 | 402 / 402 | 416 |
| task.fail | 599 / 638 | 240 / 240 | 256 |
| feishu.outbound_result | 435 / 512 | 64 / 64 | 64 |
| task.usage，1 个 native usage unit | 33 / 33 | 31 / 31 | 40 |
| GET sessions messages，普通分页 | 22 / 106 | 14 / 14 | <50 |
| GET sessions messages，from/to 范围 | 22 / 97 | 14 / 14 | <50 |
| Chat projection，retry ancestry | 41 / 64 | 43 / 45 | 50 |
| GET messages range，窗口外 target_seq 引用 | 20 / 134 | 12 / 12 | <50 |

另有真实 Store 对照测试：20 个任务的 `hydrateTasksByIds` 只执行一次 usage 聚合，并保持输出与逐个 `getTask` 一致；Runtime 身份+drain 批量读取为一次 SQL，并验证 drain/undrain 写入失效与同 daemon 两个 Runtime 的围栏。

2026-11-17 14:42 UTC 用最终加强后的夹具在 `/tmp/mul182-baseline`（detached `87fd55c0f`）重新复现：
`bun test tests/unit/multiremi/daemon-report-query-budget.test.ts -t 'budget|projection batches|range markers|hydration'`
为 5 pass / 14 fail / 1 filtered out（Runtime 批量读取是新增 API，因此不在基线上调用）。其中小夹具 projection 的 SQL 形状断言也失败，不能把 14 个失败全部解释成越过次数上限。修复的完整测试命令见下文。

## 实现边界

- daemon turn 输入从范围查询直接映射完整消息，替代 ID 列表后的逐条 getMessage；保留可见性、删除过滤和 seq 排序。
- 消息列表及范围读取为当前扫描页预取 related messages、窗口外 target_seq 目标和 source subjects，复用已有可见性规则。消息列表仍按原规则继续扫描隐藏行；本报告不是任意多隐藏页、任意多个 Question 权限查询的全局常数证明。
- Chat retry ancestry 在 attempts 基表中一次递归读取，按连续 attempt_no 回溯；Chat 历史只批量读取引用任务的 status，不水合 usage/autopilot。
- 任务批量水合对整个批次调用 usage projection；不再在结果 map 内逐任务聚合。
- offer 工作区扇出批量读取 Runtime 与 daemon drain 围栏。workspace/消息可见性和配置变更仍保留相应权限检查。
- Issue workspace 报告只改变派活条件，继续唤醒 workspace offers；不重建无关 daemon 配置。飞书 sent/failed 只刷新已验证 bot Runtime 的 pending 队列。消息、评论和终态刷新 pending 输入消费者；活跃任务、bot hosts、未关闭的后台 lane 和 drain hosts 都计入，其他配置/维护事件保留完整扇出。
- 每个同步帧及下行阶段使用有失效规则的同步读取范围，范围退出即关闭，后台异步工作不能沿用旧缓存。

当前源码只有 `POST /api/daemon/runtimes/:runtimeId/feishu-bot/messages`（daemon.ts）用于入站消息，没有报告所称同路径 GET 的注册。因此没有把该 GET 写成已修复/已验证；若 stable 仍有该 GET，需要其路由版本或请求日志继续定位。POST 创建的消息输入下发会使用本次修复的批量消息读取。

## 验证及剩余工作

本轮最终加强后的预算：20 pass、0 fail、110 assertions。消息/心跳/Chat 回归：49 pass、4 skip、0 fail（5 文件，883 assertions）；扇出、offer、配置和 request-read-cache：72 pass、4 skip、0 fail（4 文件，477 assertions）；真实 socket reporting：18 pass、0 fail（863 assertions，84.14 s）；飞书 daemon/routes/task-bridge 及通知权限：82 pass、4 skip、0 fail（4 文件，703 assertions）。共 241 pass、12 skip、0 fail；skip 为缺少 PostgreSQL URL 的专属用例。`bunx tsc --noEmit`、直接 `node node_modules/typescript/bin/tsc --noEmit`、docs:test（13 pass）、docs:check 和 diff 空白检查通过。没有单独配置的 Lint 命令，未声称运行全仓测试。

```sh
bun test tests/unit/multiremi/daemon-report-query-budget.test.ts
bun test --timeout 30000 tests/unit/multiremi/daemon-heartbeat-fanout-cost.test.ts tests/unit/multiremi/session-log-window-query-count.test.ts tests/unit/multiremi/session-projection-follow.test.ts tests/unit/multiremi/multiremi-side-session-projection.test.ts tests/unit/multiremi/chat-queue.test.ts
bun test --timeout 30000 tests/integration/daemon-protocol-v2/reporting.test.ts
bun test --timeout 30000 tests/unit/multiremi/daemon-downlinks.test.ts tests/unit/multiremi/daemon-downlink-configs.test.ts tests/unit/multiremi/daemon-task-offers.test.ts tests/unit/multiremi/multiremi-request-read-cache.test.ts
bun test --timeout 30000 tests/unit/multiremi/multiremi-feishu-bot-daemon.test.ts tests/unit/multiremi/multiremi-feishu-bot-routes.test.ts tests/unit/multiremi/multiremi-feishu-bot-task-bridge.test.ts tests/unit/multiremi/question-notification-access.test.ts
node node_modules/typescript/bin/tsc --noEmit
npm run docs:test
npm run docs:check
git diff --check
```

终态事务仍有较高的固定成本：complete 402、fail 240 次 SQL，包括既有任务完成/失败、评论、Issue 状态和事件处理。它们现在不随夹具消息数和 retry 深度增长，但尚不能声称达到“几十次”的小预算；本项仍未满足 Issue 的小预算要求；不能以预算测试通过代替这一验收。SQL 采样显示 complete 内仍有 13 次 Issue/labels 读取、16 次 Session 读取及 11 次 workspace 锁写；进一步收敛应保留事务、权限和回滚语义，不能只过滤这些 SQL 计数。usage unit 的逐单位账本写入不在此次批量化范围内，预算固定一个 unit，不声称单位数增长仍为常数。

未执行真实 PostgreSQL 和 stable 部署验证。环境未提供 `MULTIREMI_TEST_POSTGRES_URL`；Docker socket 访问被拒绝，没有用 SQLite 冒充 PostgreSQL。预算夹具支持显式 PostgreSQL URL，连接失败不会回落。合并、部署和至少 8 个并行轮次一小时内 `event_loop_lag_max < 1s`、无 `daemon_timeout` 的现场数据仍是验收前提。
