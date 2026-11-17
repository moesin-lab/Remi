# MUL-191 终态帧阶段性优化与剩余 SQL

状态：**未达到 ≤60 / ≤40；本报告和 PR 是待审的阶段性交付，不能作为验收通过或合并建议。**

基线 `agent/MUL-182`：`c5b4c289610e07712be7bf7a17bcd43305622307`（PR #99 尚未合并）。本任务分支 `agent/MUL-191`。沿用 [MUL-182 原逐语句清单](MUL-182-terminal-sql.md)，保留 SQL 全量计数、WITH、写入和 `layer.drain()` 排队工作。

## 实测

SQLite，Bun 1.3.14，同一预算测试的 8 Runtime / 4 daemon / 双活动任务；小/大 fixture 分别有 2/40 条上下文和 1/8 个 attempt。

| 帧 | 基线读/写/总计 | 当前读/写/总计（小/大相同） | 降幅 | 要求 |
|---|---|---|---|---|
| turn.complete | 317 / 89 / 406 | 226 / 62 / **288** | 29.1% | ≤60，未达到 |
| task.fail | 191 / 49 / 240 | 146 / 33 / **179** | 25.4% | ≤40，未达到 |

288/179 是当前实现的**实测可达预算**，不是理论下限，也未获需求方接受。测试先锁住这组数字并保留小/大相等断言；不能以它们恒定为由宣称完成小预算目标。complete 仍有 62 条写语句，仅继续做读缓存已不足以达标。

## 已完成的合并与复用

- workspace 与 lane 锁按数据库事务复用；外层事务结束清空，内层事务或 savepoint 回滚恢复入口锁集合。首锁继续失效锁前读取；不同事务不共享锁。原来需要的 W/Session/lane/turn 顺序不改。
- 同步读取范围内显式复用 Agent、Skills、Issue、标签、Session/owner scope 和 usage 原始查询。所有依赖表分别登记；任一表写入、首锁或回滚会使结果失效。数据库之间不共享多表查询结果；水合继续产生消费者对象。
- 终态事务将中间轮卡变更累积到最终一次投影/发布；revision 和 log_version 按原通知次数累加。失败事务丢弃通知批次，自动回复失败后的原有整笔重试仍保留。忽略返回值的终态 outcome 调用不再额外读取完整轮卡。
- 下行队列复用既有 UNION 探测结果，只查询有待办/回收/擦除工作的 family；空队列不再逐个查询。已存在 platform maintenance 单例时不再执行 INSERT ON CONFLICT。

## 剩余 SQL 与边界

完整逐语句原文、次数、来源、分类及保留原因在 [MUL-191-terminal-sql.json](MUL-191-terminal-sql.json)。不含 SQL 参数或凭据。`lock` 是互斥写；预算里的写数包含它。相同 SQL 合并展示不表示参数相同；不同宿主、任务、事务的读取不能简单视为同一行重复。

剩余主因：

1. 完成预检、终态事务和提交后下行快照有独立事务边界，跨边界仍重新验证 attempt/Runtime/lane。锁不能跨 COMMIT 复用；要进一步合并，需把预检与终态变更收敛到一个持锁上下文，同时覆盖 replay、input_unread 与自动回复整笔回滚重试。
2. 回复仍先暂存、再由 Issue/Chat 产品写入器发布，参与者、日志、dispatch intent 和事后通知各走规范入口。不能直接删除这些副作用；需要另行统一回复落库与 provenance，而非绕过产品写入器。
3. Issue 状态推导、Q/责任链、委派回程与飞书 outbox 保留现有判定。它们的用途不证明每条查询都必须独立存在；JSON 中明确标注尚可整合的语句。
4. 提交后下行仍验证 peer 的活跃轮、bot delivery、排空与派活容量。不能从帧统计中排除，也不能以 SQLite 时间当成 PG 延迟。

尚未提出可证明的最终下限；若要求继续达到 60/40，需要继续重构上述边界，本阶段结果不能代替该要求。

## 验证证据

- `bun run test tests/unit/multiremi/daemon-report-query-budget.test.ts`：27 pass，0 fail；小/大 complete=288、fail=179。
- 终态输入、轮卡字段、错误/replay、trace、lane/再响铃、队列等 10 文件：98 pass，62 个 PG 用例 skip，0 fail（其中新增锁/缓存/通知批次测试 3 pass）。
- `bun run test tests/unit/multiremi/multiremi-request-read-cache.test.ts`：16 pass，0 fail。
- 委派回程、follow lane、claim events 与 usage 等另 6 文件：93 pass，7 个 PG 用例 skip，0 fail。
- 新增事务复用测试最终单独复跑：3 pass，0 fail，覆盖内层通知回滚和首锁失效。
- `bunx tsc --noEmit`：通过。
- 真实 PG：本机无 Docker socket 权限；仅 root UID 映射，隔离 PostgreSQL 无法启动；远端 `runtime.command.run` 返回 `current credential cannot run runtime.command.run`。SQLite skip 不计作 PG 通过。分支完整 Release build check 及真实 PG 证据待 CI。
- stable 8+ 并行轮次一小时、event_loop_lag_max < 1s、无 daemon_timeout：未执行，属于合并/部署后的验收；本任务没有合并/部署授权。

复现逐语句：

```sh
MULTIREMI_TEST_SQL_TRACE=complete bun run test tests/unit/multiremi/daemon-report-query-budget.test.ts -t 'turn.complete budget with 2 '
MULTIREMI_TEST_SQL_TRACE=fail bun run test tests/unit/multiremi/daemon-report-query-budget.test.ts -t 'task.fail budget with 2 '
```

测试输出 `/tmp/mul182-sql-<name>.json`（仅 SQL 与 stack），与上述 JSON 的统计口径一致。真实 PostgreSQL 请显式设置 `MULTIREMI_TEST_POSTGRES_URL`；连接失败必须失败，不回落 SQLite。
