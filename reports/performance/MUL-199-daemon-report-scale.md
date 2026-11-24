# MUL-199：规模查询预算（本地 SQLite，验收未完成）

基线 `ba203f401`，隔离分支 `agent/MUL-199`。首个夹具提交 `a4d6cba07`。以下对照使用同一份修正后的 ACK 排空夹具：修复前暂时反向应用本单 runtime diff，测完恢复；不拿未排空发送窗口的数字作基线。

## 夹具与测量口径

`tests/fixtures/multiremi/daemon-report-scale.ts` 接受维度参数。每档只在 beforeAll 建数一次，七类帧共享该档数据库和协议连接；每次测量前 ACK 排空包括 ACK 后产生的下行，避免大夹具填满窗口后少算工作。countSql 包含 layer.drain() 后台下行与派活，准备输入投影、正文读取回执和前置 ACK 在计数范围外，和独立的线上帧归因一致。

| 维度 | 小档 | stable 档 |
|---|---:|---:|
| issues | 2 | 100 |
| sessions | 2 | 40 |
| logsPerSession | 4 | 501 |
| agents | 2 | 10 |
| skillsPerAgent | 1 | 3 |
| runtimes | 4 | 8 |
| historicalAttempts | 2 | 80 |
| outboxRows | 2 | 100 |
| queuedRows（Chat / runtime command 各） | 2 | 100 |

日志采用各驱动原生 JSON 批量 INSERT。历史 attempt 通过 Store 创建、启动、写 usage、失败，maxAttempts=1；测试检查真实 attempts、usage、outbox、队列、skill 关联行数及每会话日志数量。另有 bot binding/任务与 Project Chat，以覆盖会通知下行的 task.progress 分支。

## 每帧查询数

每格为「读 / 写 = 总数」。SELECT/WITH 算读，其余执行算写；不是事务 SQL 的独立网络往返或耗时。

| 帧 | 修复前小档 | 修复前 stable | 修复后小档 | 修复后 stable |
|---|---:|---:|---:|---:|
| hb | 48 / 16 = 64 | 48 / 16 = 64 | 48 / 16 = 64 | 48 / 16 = 64 |
| task.start | 161 / 37 = 198 | 261 / 57 = 318 | 81 / 19 = 100 | 81 / 19 = 100 |
| task.progress | 44 / 10 = 54 | 44 / 10 = 54 | 44 / 10 = 54 | 44 / 10 = 54 |
| task.workspace | 61 / 15 = 76 | 161 / 35 = 196 | 38 / 9 = 47 | 38 / 9 = 47 |
| turn.input | 85 / 20 = 105 | 85 / 20 = 105 | 85 / 20 = 105 | 85 / 20 = 105 |
| turn.complete | 352 / 92 = 444 | 456 / 112 = 568 | 349 / 91 = 440 | 453 / 111 = 564 |
| task.fail | 348 / 62 = 410 | 600 / 102 = 702 | 345 / 61 = 406 | 597 / 101 = 698 |

五类非终态帧在 SQLite 写死读、写、总数常量，并对两档完全相等作断言；PG 运行相同的两档相等检查，但固定 PG 数字尚待真实捕获。turn.complete / task.fail 仅测量，由 MUL-191 继续优化。

## 增长来源与实现

- task.workspace 广播 dispatch_conditions_changed 导致无关 daemon 的 provider 也运行 claim/容量/插件检查。现按 workspace 所属 daemon 的 runtime 别名集合定向通知，保留同宿主不同 provider。
- task.start 的 in_progress 派生状态事件会触发无关 runtime 的 pending/offer 刷新。仅对 start 事务新产生的派生状态事件附启动 runtime；浏览器事件、状态推导和其他业务通知仍保留。
- 下行逐条读取旧 attempt 的身份，随后把已终态或无权 attempt 交给 turn snapshot 再检查。现用单个 JSON 参数批量读取身份，终态仍生成原 task.cancelled 控制帧及 ACK/discard 清理，只对活 attempt 投影输入。

完整 SQL、两档逐语句计数及每条增长项的维度在 [机器可读对照](MUL-199-daemon-report-statements.json)。下表引用其中语句编号；runtime 分类对应 workspace offer/downlink 的实际调用扇出，agent/skill 分类对应其水合读取。多个维度同时放大，这些数据不构成各维度独立的耗时因果实验。

| 帧 | 语句 | 小档 | stable | 增长维度 |
|---|---|---:|---:|---|
| task.start | Q001 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.start | Q008 | 4 | 8 | runtime (workspace offer/downlink fanout) |
| task.start | Q018 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.start | Q020 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.start | Q025 | 4 | 12 | agent / runtime (claim pump fanout) |
| task.start | Q026 | 2 | 6 | agent / runtime (claim pump fanout) |
| task.start | Q043 | 4 | 8 | runtime (workspace offer/downlink fanout) |
| task.start | Q051 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.start | Q074 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.start | Q076 | 2 | 6 | agent / runtime (claim pump fanout) |
| task.start | Q088 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.start | Q090 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.start | Q098 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.start | Q104 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.start | Q111 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.start | Q113 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.start | Q149 | 21 | 41 | runtime (workspace offer/downlink fanout) |
| task.start | Q150 | 1 | 0 | runtime (workspace offer/downlink fanout) |
| task.start | Q151 | 0 | 1 | runtime (workspace offer/downlink fanout) |
| task.start | Q166 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.start | Q170 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.start | Q171 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.start | Q172 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.start | Q184 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.start | Q206 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.start | Q229 | 6 | 10 | runtime (workspace offer/downlink fanout) |
| task.start | Q232 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.workspace | Q001 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.workspace | Q008 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.workspace | Q018 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.workspace | Q020 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.workspace | Q025 | 4 | 12 | agent / runtime (claim pump fanout) |
| task.workspace | Q026 | 2 | 6 | agent / runtime (claim pump fanout) |
| task.workspace | Q043 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.workspace | Q051 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.workspace | Q074 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.workspace | Q076 | 2 | 6 | agent / runtime (claim pump fanout) |
| task.workspace | Q088 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.workspace | Q090 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.workspace | Q098 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.workspace | Q104 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.workspace | Q111 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.workspace | Q113 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.workspace | Q149 | 12 | 32 | runtime (workspace offer/downlink fanout) |
| task.workspace | Q150 | 1 | 0 | runtime (workspace offer/downlink fanout) |
| task.workspace | Q151 | 0 | 1 | runtime (workspace offer/downlink fanout) |
| task.workspace | Q166 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.workspace | Q170 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.workspace | Q171 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.workspace | Q172 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.workspace | Q184 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.workspace | Q206 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.workspace | Q229 | 3 | 7 | runtime (workspace offer/downlink fanout) |
| task.workspace | Q232 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| turn.complete | Q001 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| turn.complete | Q008 | 4 | 8 | runtime (workspace offer/downlink fanout) |
| turn.complete | Q018 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| turn.complete | Q020 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| turn.complete | Q025 | 4 | 12 | agent / runtime (claim pump fanout) |
| turn.complete | Q026 | 2 | 6 | agent / runtime (claim pump fanout) |
| turn.complete | Q043 | 4 | 8 | runtime (workspace offer/downlink fanout) |
| turn.complete | Q051 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| turn.complete | Q056 | 1 | 3 | skill (terminal hydration) |
| turn.complete | Q074 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| turn.complete | Q076 | 2 | 6 | agent / runtime (claim pump fanout) |
| turn.complete | Q088 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| turn.complete | Q090 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| turn.complete | Q098 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| turn.complete | Q104 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| turn.complete | Q111 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| turn.complete | Q112 | 1 | 3 | runtime (workspace offer/downlink fanout) |
| turn.complete | Q113 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| turn.complete | Q149 | 22 | 42 | runtime (workspace offer/downlink fanout) |
| turn.complete | Q150 | 2 | 0 | runtime (workspace offer/downlink fanout) |
| turn.complete | Q151 | 0 | 2 | runtime (workspace offer/downlink fanout) |
| turn.complete | Q166 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| turn.complete | Q170 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| turn.complete | Q171 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| turn.complete | Q172 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| turn.complete | Q184 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| turn.complete | Q206 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| turn.complete | Q229 | 13 | 17 | runtime (workspace offer/downlink fanout) |
| turn.complete | Q232 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.fail | Q001 | 6 | 14 | runtime (workspace offer/downlink fanout) |
| task.fail | Q008 | 6 | 14 | runtime (workspace offer/downlink fanout) |
| task.fail | Q017 | 4 | 8 | runtime (workspace offer/downlink fanout) |
| task.fail | Q018 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.fail | Q020 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.fail | Q022 | 4 | 8 | runtime (workspace offer/downlink fanout) |
| task.fail | Q025 | 4 | 12 | agent / runtime (claim pump fanout) |
| task.fail | Q026 | 2 | 6 | agent / runtime (claim pump fanout) |
| task.fail | Q028 | 4 | 8 | runtime (workspace offer/downlink fanout) |
| task.fail | Q036 | 12 | 24 | runtime (workspace offer/downlink fanout) |
| task.fail | Q039 | 4 | 8 | runtime (workspace offer/downlink fanout) |
| task.fail | Q043 | 6 | 14 | runtime (workspace offer/downlink fanout) |
| task.fail | Q045 | 4 | 8 | runtime (workspace offer/downlink fanout) |
| task.fail | Q046 | 4 | 8 | runtime (workspace offer/downlink fanout) |
| task.fail | Q047 | 4 | 8 | runtime (workspace offer/downlink fanout) |
| task.fail | Q048 | 4 | 8 | runtime (workspace offer/downlink fanout) |
| task.fail | Q049 | 4 | 8 | runtime (workspace offer/downlink fanout) |
| task.fail | Q050 | 4 | 8 | runtime (workspace offer/downlink fanout) |
| task.fail | Q051 | 5 | 9 | runtime (workspace offer/downlink fanout) |
| task.fail | Q052 | 4 | 8 | runtime (workspace offer/downlink fanout) |
| task.fail | Q054 | 4 | 8 | runtime (workspace offer/downlink fanout) |
| task.fail | Q065 | 4 | 8 | runtime (workspace offer/downlink fanout) |
| task.fail | Q066 | 5 | 9 | runtime (workspace offer/downlink fanout) |
| task.fail | Q074 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.fail | Q076 | 2 | 6 | agent / runtime (claim pump fanout) |
| task.fail | Q078 | 4 | 8 | runtime (workspace offer/downlink fanout) |
| task.fail | Q085 | 8 | 16 | runtime (workspace offer/downlink fanout) |
| task.fail | Q086 | 6 | 14 | runtime (workspace offer/downlink fanout) |
| task.fail | Q088 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.fail | Q090 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.fail | Q098 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.fail | Q099 | 4 | 8 | runtime (workspace offer/downlink fanout) |
| task.fail | Q102 | 12 | 24 | runtime (workspace offer/downlink fanout) |
| task.fail | Q103 | 4 | 8 | runtime (workspace offer/downlink fanout) |
| task.fail | Q104 | 5 | 9 | runtime (workspace offer/downlink fanout) |
| task.fail | Q111 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.fail | Q113 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.fail | Q118 | 4 | 8 | runtime (workspace offer/downlink fanout) |
| task.fail | Q139 | 4 | 8 | agent / runtime (claim pump fanout) |
| task.fail | Q140 | 4 | 8 | runtime (workspace offer/downlink fanout) |
| task.fail | Q141 | 4 | 8 | runtime (workspace offer/downlink fanout) |
| task.fail | Q149 | 27 | 59 | runtime (workspace offer/downlink fanout) |
| task.fail | Q150 | 2 | 0 | runtime (workspace offer/downlink fanout) |
| task.fail | Q151 | 0 | 2 | runtime (workspace offer/downlink fanout) |
| task.fail | Q156 | 4 | 8 | runtime (workspace offer/downlink fanout) |
| task.fail | Q165 | 4 | 8 | runtime (workspace offer/downlink fanout) |
| task.fail | Q166 | 5 | 9 | runtime (workspace offer/downlink fanout) |
| task.fail | Q170 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.fail | Q171 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.fail | Q172 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.fail | Q181 | 4 | 8 | runtime (workspace offer/downlink fanout) |
| task.fail | Q184 | 6 | 14 | runtime (workspace offer/downlink fanout) |
| task.fail | Q203 | 4 | 8 | runtime (workspace offer/downlink fanout) |
| task.fail | Q206 | 2 | 6 | runtime (workspace offer/downlink fanout) |
| task.fail | Q229 | 10 | 18 | runtime (workspace offer/downlink fanout) |
| task.fail | Q232 | 2 | 6 | runtime (workspace offer/downlink fanout) |

## 现场差距与未完成项

本夹具没有充分复现现场所有形态：hb 64 仍低于现场 124–175，Project Chat progress 54 低于 263，start 318 低于 564，workspace 196 略低于 221–263。当前每 daemon 只报告两个 provider，只有两个主活跃轮和一个 bot 任务，历史轮次有数据但未模拟八个以上并行活轮；未放大活 AUQ、飞书 decision/reminder/operation 待回放组合。因此不能声称消除了所有真实规模维度的查询增长。需只读取得 stable 的每 daemon runtime 数、各 runtime 活 attempt 数、bot/AUQ/outbox pending 状态分布，再扩展参数并复测高频路径；尚未取得 stable 的这些只读统计。没有帧频实测，不能从单帧成本推断总负载排序。

真实 PG 未验证：本地 Docker socket 拒绝访问；下载的 PG 15.20 无法用非 root 用户启动（runuser 无法 set groups）。未绕过启动门禁。完整 Release build check（含 PG 分片）待当前 SHA 的 CI 证据。部署及 8+ 并行轮次一小时现场验收未执行。

## 可重复命令与实际结果

```sh
export PATH="$HOME/.bun/bin:$PATH"
MULTIREMI_TEST_QUERY_PROFILE=/tmp/report-profile.json bun test tests/unit/multiremi/daemon-report-scale-budget.test.ts
# 真实 PG（需要可创建测试库的本地测试服务）：
MULTIREMI_TEST_POSTGRES_URL=postgres://testuser@127.0.0.1:5432/postgres bun test tests/unit/multiremi/daemon-report-scale-budget.test.ts
bunx tsc --noEmit
npm run docs:test
npm run docs:check
```

本轮重跑规模文件 9 项通过、0 失败，9.60 秒（含单次建数和前置 ACK，低于 30 秒）。CI 自动由后端测试发现/分片纳入，不另行重复 seed；PG beforeAll 超时 120 秒，真实耗时未取得。相关九文件回归：218 pass、125 skip、0 fail，68.05 秒；skip 中包括未配置 PG 的测试，不能写成 PG 通过。TypeScript、文档测试和文档检查已通过。更多回归结果见交付评论。

## 2026-11-18 交付续接

Remi API 可通过仅对 Remi CLI 去掉代理环境变量访问；Git 凭据需带仓库路径（credential.useHttpPath=true）。夹具已推送并创建草稿 PR #112，MUL-191 已普通合入夹具和 origin/main。上文 SQLite 数字于本轮复跑（9 pass / 0 fail，9.28 秒）；PG 与完整 CI 待后续记录。尚未合并或部署。
