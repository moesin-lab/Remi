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
| task.usage，2 / 40 个 native usage units | 38 / 228 | 31 / 31 | 40 |
| POST feishu-bot/messages，已有会话追加，2 / 40 条消息历史 | 85 / 85 | 81 / 81 | 96 |
| GET messages，2 / 40 条有效 Q 通知 + 20 / 400 条过期通知 | 53 / 931 | 9 / 9 | <50 |
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
- 消息列表及范围读取为当前扫描页预取 related messages、窗口外 target_seq 目标和 source subjects，复用已有可见性规则。消息列表仍按原规则继续扫描隐藏行；原生 Q 通知在分页 SQL 中先过滤失效路由，并批量检查响应页权限；直接 Q 的 20/400 个隐藏通知夹具为 9/9 次 SQL。普通回复间接继承的受限来源仍可能跨多个候选页，不能把这一夹具泛化为所有隐藏路径的全局常数证明。
- Chat retry ancestry 在 attempts 基表中一次递归读取，按连续 attempt_no 回溯；Chat 历史只批量读取引用任务的 status，不水合 usage/autopilot。
- 任务批量水合对整个批次调用 usage projection；不再在结果 map 内逐任务聚合。
- offer 工作区扇出批量读取 Runtime 与 daemon drain 围栏。workspace/消息可见性和配置变更仍保留相应权限检查。
- Issue workspace 报告只改变派活条件，继续唤醒 workspace offers；不重建无关 daemon 配置。飞书 sent/failed 只刷新已验证 bot Runtime 的 pending 队列。消息、评论和终态刷新 pending 输入消费者；活跃任务、bot hosts、未关闭的后台 lane 和 drain hosts 都计入，其他配置/维护事件保留完整扇出。
- 每个同步帧及下行阶段使用有失效规则的同步读取范围，范围退出即关闭，后台异步工作不能沿用旧缓存。

按仓库所有者勘误，以实际注册的 `POST /api/daemon/runtimes/:runtimeId/feishu-bot/messages` 为目标。测试先建立真实飞书绑定和活动 Chat，再播种同一 Chat 的 2/40 条历史，调用真实 HTTP 端点追加一个不同 external message ID；计入下行 drain。查询为 81/81，上限 96。新建绑定/Chat 的首条接入是另一条较重的固定写路径（诊断为 245 次），不以“已有会话追加”的预算冒充新会话成本。

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

终态事务仍有较高的固定成本：complete 402、fail 240 次 SQL，包括既有任务完成/失败、评论、Issue 状态和事件处理。它们现在不随夹具消息数和 retry 深度增长，但尚不能声称达到“几十次”的小预算；本项仍未满足 Issue 的小预算要求；不能以预算测试通过代替这一验收。SQL 采样显示 complete 内仍有 13 次 Issue/labels 读取、16 次 Session 读取及 11 次 workspace 锁写；进一步收敛应保留事务、权限和回滚语义，不能只过滤这些 SQL 计数。本轮补充了逐语句、读写分类及调用点清单：[终态 SQL 诊断](MUL-182-terminal-sql.md)。complete 为 316 读 + 86 写，fail 为 191 读 + 49 写；该项仍未达到小预算，重复读/锁不是不可优化的证明，保持草稿。

未执行真实 PostgreSQL 和 stable 部署验证。环境未提供 `MULTIREMI_TEST_POSTGRES_URL`；Docker socket 访问被拒绝，没有用 SQLite 冒充 PostgreSQL。预算夹具支持显式 PostgreSQL URL，连接失败不会回落。合并、部署和至少 8 个并行轮次一小时内 `event_loop_lag_max < 1s`、无 `daemon_timeout` 的现场数据仍是验收前提。


## 2026-11-17 复审补充

在独立 `/tmp/mul182-original-baseline`（detached `87fd55c0f`）复制当前预算测试，执行：

```sh
bun test tests/unit/multiremi/daemon-report-query-budget.test.ts -t 'POST feishu|Question permissions|task.usage budget'
```

结果 3 pass / 3 fail。unit 从 2 到 40 时 38→228；Question 的有效/过期通知从 2/20 到 40/400 时 53→931；已有飞书会话的 POST 为 85/85。POST 基线已在 96 内，但 Runtime 身份仍额外做历史聚合；本轮改为 lite 后 81/81。另在上一修订 `d74aa2b73` 执行相同测试（当时 POST 用新建会话夹具）得到 usage 36/226、Q 54/936，均在报告中与原始基线数字分开。

usage 的事实表、回执和旧冲突修订 floor 一次预取；普通 token 快照在所有修订校验通过后用 JSON 参数展开，每表一次 INSERT，保留 run 锁、旧修订 floor、superseded tombstone、相同修订冲突与事务回滚。10,000 unit 的单元测试实跑 18 次 SQL，重放 15 次；两次聚合均为 120,000 tokens，事实与回执各一条 INSERT，无 bind 上限分块增长。

**保留的逐项路径及原因：** `claimProviderIdentity` 对 provider session/request 的兼容 connection 命名空间串行取得 ownership，较晚 unit 的 token/money role 冲突必须看到本快照较早 unit 的决定；`claimMeterIdentity` 还依赖累计区间覆盖与已接收事实。`coveredUnitIds` / monetary commitment 分片需要核验集合 digest、计数与 FK 后再标完整。本轮没有将这些检查伪装为普通 upsert：request ownership 的检查/冲突审计仍逐项执行；累计 meter、增量金额 coverage 及已有 provider money 的改写保留旧事实/回执写路径。这些路径不宣称拥有 31 次常数预算。普通 request identity 的接受事实及回执本身已批量写入。现有 ownership/coverage/receipt 回归用于守住语义，但这不是上述分支全量批量化完成的证明。

严格的 Question metadata 校验仍先于批量 SQL 事实授权；直接过期通知在 LIMIT 之前过滤。测试核对可见 ID、顺序、next_cursor=null，且过期通知正文未出现在响应中；同时显式比较小/大夹具查询数相等。

本机未配置测试 PG URL，系统 apt 写锁/安装目录无权限；独立 PostgreSQL 二进制可下载，但 `initdb` 拒绝 root，切换非特权用户又被宿主拒绝（`cannot set groups: Operation not permitted`）。没有改写系统/借用其他任务数据库，也没有把 SQLite 当 PG。完整 Release build check 的运行与结论以 PR 描述中精确 head SHA 的证据为准。

本轮本地实际执行记录（各命令单独统计，不跨重叠用例相加）：

```sh
# 66 pass / 5 skip / 0 fail（修订时普通 ownership 条件尚未放宽为批量接受事实）
bun test --timeout 30000 tests/unit/multiremi/store-usage-accounting.test.ts tests/unit/multiremi/usage-superseded-receipts.test.ts tests/unit/multiremi/question-notification-access.test.ts tests/unit/multiremi/daemon-report-query-budget.test.ts

# 扩大回归：139 pass / 51 skip / 1 fail，HOME sentinel residual paths=[]。
# 失败为 chat-message-pagination 的 SQL 探针只匹配旧 WHERE 形状，实际响应/分页/附件断言均已通过。
# 探针改为识别同一 SELECT 的表与 alias，继续保留返回行数、EXPLAIN 索引与附件范围断言；随后整文件和预算文件重跑。
bun run test --timeout 30000 tests/unit/multiremi/chat-session-log-access.test.ts tests/unit/multiremi/chat-message-pagination.test.ts tests/unit/multiremi/issue-questions.test.ts tests/unit/multiremi/question-notification-access.test.ts tests/unit/multiremi/store-usage-accounting.test.ts tests/unit/multiremi/usage-superseded-receipts.test.ts tests/unit/acp/usage-request-ownership.test.ts tests/unit/multiremi/daemon-report-query-budget.test.ts

# 重跑：27 pass / 0 fail / 194 assertions；HOME sentinel residual paths=[]。
bun run test tests/unit/multiremi/chat-message-pagination.test.ts tests/unit/multiremi/daemon-report-query-budget.test.ts
node node_modules/typescript/bin/tsc --noEmit
npm run docs:test
npm run docs:check
git diff --check
```

skip 均保留为未跑的测试，不能视为真实 PG 通过。类型检查通过；docs:test 13 pass，docs:check 与空白检查通过。完整 Release build check 的后端分片/PG 状态需另看本修订 PR 的精确 SHA 结果。
