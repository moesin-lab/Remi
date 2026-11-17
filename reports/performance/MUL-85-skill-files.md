# MUL-85：消除普通 Agent 读取中的 Skill 文件展开

本轮基线 `f54ab7453d00ca465770294436e26d9998ebc97b`，同一分支 `agent/MUL-85`、PR #83。
前两阶段和统一来源 Top 10 见 [混合负载报告](MUL-85-mixed-load.md)；本报告补充大文件根因与修复。

## 线上证据与根因

操作者 2026-11-17 04:52 UTC 的 stable PostgreSQL 采样：600 次、间隔 50ms，
220 条活跃查询中 96 条（44%）为 `SELECT * FROM multiremi_skill_files WHERE skill_id = $1 ORDER BY path ASC`。
共享 Skill 1,277 文件约 13 MB，关联 9 个 Agent；一分钟该表扫描 237 次、读取约 30 万行。
这是操作者提供的生产观测，本任务环境未访问生产 PostgreSQL 或 docker。

`hydrateAgent` 的关联 Skill 查询对每个 Skill 再调用 `listSkillFiles`，无条件跨同步 PG 桥
读取全部 content；普通身份检查、列表、派发和状态处理反复触发。`getSkill` 与
`listAgentSkills` 在省略参数或只给 `includeArchived` 时也隐式全量读取。
大文件结果传输/解析成本不能用单纯 SQL 条数或 SQLite 2.5ms RTT 模型覆盖。

Git 最早可追溯至当前仓库初始原生 Bun 导入 `c5279febf`：当时的
`src/multiremi/store.ts:listAgentSkillsForExistingAgent` 已存在无条件文件读取。
后续目录迁移 `f2c3865c1`、包拆分 `1d4dbd12a`、仓库拆分 `0d007603b` 延续该行为。
不能据此把它称为 `def540e09` 新引入的回归；大 Skill 数据把既有成本放大。

## 修复边界

- 普通 Agent/Skill 读取默认不取关联文件，显式 `includeFiles: true` 才加载。
- Agent 列表和 Runtime 活跃 Agent 列表复用有界批量 Skill 读取，消除逐 Agent 关联查询。
- 任务 claim/offer/workspace 执行上下文显式加载文件，选中任务只读取一次；旧 daemon
  二进制兼容门禁与回滚保留。Skill 详情、创建/更新响应及 runtime 导入结果保留文件。
- 权限检查、关联验证、模板 Skill 存在检查不展开文件。历史 inline Skills 的合并语义保留。
- 没有新增内容缓存、改轮询节奏、调大超时或丢请求。内容哈希缓存/清单拉取需要协议与
  一致性决策，本轮不实施。MUL-53 与 MUL-84 仍由原任务处理。

## 同夹具修前修后

Bun 1.3.14、SQLite，10 Agent（9 普通 + 1 default），共同关联 1,277 × 10,240 bytes
= 13,076,480 bytes 的 Skill。真实驱动执行后计数，夹具准备不计入。
工作负载：单 Agent、按名字引用解析、默认 Agent、全部 Agent 列表、Runtime 活跃列表，
以及默认/空 options/includeArchived 的 Skill 读取与 Agent Skill 读取各一次。

| 指标 | 修前 f54ab7453 | 修后 |
|---|---:|---:|
| SQL 总数 | 117 | 21 |
| skill_files 查询数 | 35 | 0 |
| 读取文件 content bytes | 457,676,800 | 0 |
| 单次夹具读取耗时 | 613.3ms | 7.1ms |

同一新增预算测试在隔离基线 worktree 实际运行，按预期因文件查询预算失败（0 pass/1 fail），
修后通过。此耗时是单次本地观测，不是 p50、PG 或生产性能保证。
测试另验证：列表只执行 2 SQL、显式全量读取、文件修改即时可见、归档过滤及归档显式读取。

## 大文件混合负载对照

复用已提交真实 HTTP/WS/后台入口模型，增加可选 `MUL85_SKILL_FILES=1277`，
8 Runtime、8 Agent 共同关联上述 13 MB bundle、60 queued Chat、10 轮询方、
每条 SQL 注入 2.5ms 同步延迟、60 秒发送窗口；两组依次运行，避免互相抢占 CPU。
两组均未叠加 MUL-84，单个真实 daemon socket、0 个活跃 provider lane。

```sh
MUL85_SKILL_FILES=1277 MUL85_SECONDS=60 MUL85_PROFILE_OUT=/tmp/profile.json bun test tests/manual/profile-api-mixed-load.test.ts
```

| 指标 | 修前 f54ab7453 | 修后 |
|---|---:|---:|
| SQL/min（含排空尾部，按实际窗口折算） | 17,094.7 | 17,034.4 |
| event_loop_lag_max | 4,864.5ms | 3,612.8ms |
| turns 客户端 p50 | 2,438.2ms | 2,772.1ms |
| inbox 客户端 p50 | 2,449.4ms | 2,755.4ms |
| 每路由请求数 | 600 | 600 |
| HTTP 错误 | 0 | 0 |

该模型固定轮询占主导，缺少活跃 task.workspace/终态等帧；SQL 基本持平，两个路由 p50
反而略升，不能声称整体吞吐或 p50 提升，也不能复现生产 PG 大文件解析的 8–18 秒停顿。
前述直接读取夹具才隔离了文件搬运的明确收益。需在同等真实 lane 负载下继续线上复核。
两组 profile 各 1 pass/0 fail；[完整聚合原始输出与来源榜](MUL-85-skill-mixed-load.json)。
两组第一至五名均为 inbox/runtimes（各 3,600 SQL）、chat sessions/issues（各 3,000）、
turns（2,402），随后 hb（1,528→1,316）、daemon.offer（864）；第八名 capability.sweep
从 751 降至 635。其他 job 和每项 count、db_ms、queries_per_invocation 见 JSON。
本轮不以重复更改轮询频率或缓存语义来降低该模型的请求量。

## 验证入口

```sh
bun run test tests/unit/multiremi/agent-skill-read-budget.test.ts tests/unit/multiremi/store-agents-skills-repo.test.ts tests/unit/multiremi/multiremi-store-agents-skills.test.ts tests/unit/multiremi/skill-file-encoding.test.ts tests/unit/multiremi/binary-skill-claim.test.ts tests/unit/multiremi/multiremi-claim-hydrate-selected.test.ts tests/unit/multiremi/runtime-skill-directory.test.ts tests/unit/multiremi/multiremi-api-skills-templates.test.ts
bun run test tests/unit/multiremi/first-screen-hotspots-query-count.test.ts tests/unit/multiremi/first-screen-hotspots-inbox-attachments.test.ts tests/unit/multiremi/skill-url-import.test.ts tests/unit/multiremi/claim-queued-chat-query-count.test.ts tests/unit/multiremi/agent-task-snapshot-visibility.test.ts tests/unit/multiremi/agent-workspace-context.test.ts tests/unit/multiremi/skill-workspace-context.test.ts tests/unit/multiremi/multiremi-store-agent-task-snapshot.test.ts tests/unit/multiremi/daemon-workspace-context.test.ts
node node_modules/typescript/bin/tsc --noEmit --pretty false
```

两组真实运行分别 53 pass/0 fail 和 158 pass/0 fail，HOME sentinel 均无残留；类型检查退出 0。
覆盖真实 WS 下发、二进制编码/旧 consumer 回滚、Skill API、导入和作用域、执行快照、列表预算。
未配置真实 PG，本轮不声称 PG 通过。

## 所有者部署后复核（尚未执行）

保留相同 Agent/lane 和轮询规模，启用现有 api_minute_summary SQL 来源榜，采集至少一分钟
修前/修后 db_queries、event_loop_lag_max、turns/inbox p50 和 HTTP/WS/job Top 10。
同时按操作者既有方法通过 stdin 向 `docker exec -i <pg> psql` 每 50ms 送入
`SELECT query FROM pg_stat_activity WHERE state = 'active' AND pid <> pg_backend_pid();`，
复核 skill_files 已退出活跃采样前列；不要使用 docker cp。
执行上下文与显式详情读取仍会读取完整 bundle，不要求 skill_files 永远为零。

独立审阅/QA 旧结论只覆盖 7aa4bb788；f54ab7453 与本轮最终 SHA 仍需独立复核。
未合并、部署或完成线上验收，Issue 保持 in_review。
