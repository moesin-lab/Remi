# MUL-304 PostgreSQL 路由矩阵夹具计时报告

任务 worktree：`/data00/home/chenmiaoxin/.remi/multiremi/workspaces/work/iss_x2xs66i95ir3/Remi`。

仓库 https://github.com/moesin-lab/Remi ，PR https://github.com/moesin-lab/Remi/pull/146 。
任务分支 `agent/MUL-304`；开发基线 `b897f0633f6ff4375a4e439045b037004d81953c`；计时基线 `f07dff0a76256bce2a577b9cd5ec9d76b68c2ed7`；优化源码 `e80c06262d71408fa39d0e3844908129bfce3b9d`。

测试环境来自现有完整 CI：Ubuntu GitHub hosted runner、Bun 1.3.14、pgvector/pgvector:pg17、真实本机 PG 服务、8 个后端分片。每轮四例位于 backend (2)。PR 运行的 artifact SHA 是测试用 merge SHA，手动运行的 artifact SHA 是分支源码 SHA。

## 四例总耗时与默认 5000ms 余量

下表单位 ms。每例总耗时包含克隆/建库、连接、真实迁移入口、Store 构造、基线快照、用例主体和清理。模板预热另列，不能当作消失的成本。

| 用例 | 冷基线 | 优化 PR | 优化独立运行 | 优化最小余量 |
| --- | ---: | ---: | ---: | ---: |
| restores native seed values and removes committed cells without restarting the Store | 3187.88 | 1429.33 | 1606.33 | 3393.67 (67.9%) |
| closes its connection when a cell fails | 2815.07 | 656.87 | 713.59 | 4286.41 (85.7%) |
| refuses request caches, live subscriptions, open transactions and schema changes | 2710.76 | 445.43 | 484.87 | 4515.13 (90.3%) |
| does not retain afterCommit callbacks from a rolled-back probe | 2796.36 | 586.06 | 713.62 | 4286.38 (85.7%) |

## 主要耗时段与实际成本

冷基线四例迁移耗时 2389.07–2432.95ms，占各例总耗时 76.3–89.2%。本次定位到重复冷迁移；没有将其进一步归因为特定 CPU、IO 或 PG 等待。

| 阶段 | 冷基线四例范围 ms | 优化两轮八例范围 ms |
| --- | ---: | ---: |
| 建库/克隆 | 14.19–14.85 | 82.82–130.03 |
| 连接 | 44.45–75.68 | 30.05–40.50 |
| 迁移入口 | 2389.07–2432.95 | 13.35–20.72 |
| Store 构造，不含迁移 | 13.76–14.46 | 8.21–18.69 |
| 基线快照及 ensureLocalWorkspace | 67.94–69.82 | 85.40–159.25 |
| 主体 | 32.87–481.27 | 32.62–899.86 |
| 清理 | 114.76–127.77 | 124.50–499.11 |

| 运行 | 模板成本 ms | 四例合计 ms | 模板加四例 ms | 相对冷基线减少 |
| --- | ---: | ---: | ---: | ---: |
| 冷基线 | — | 11510.07 | 11510.07 | — |
| 优化 PR | 3024.17 | 3117.68 | 6141.85 | 46.6% |
| 优化独立运行 | 3585.84 | 3518.41 | 7104.25 | 38.3% |

模板成本含模板建库、连接、冷 Store/迁移及关闭；不含 beforeAll 的管理连接 prepare 和 afterAll 的模板删除。完整文件墙钟另由原始分片报告 `files[].seconds` 保留，包含 SQLite 用例及 hooks；上表不是整条工作流墙钟或产品延迟。不同 runner 的调度与负载存在差异，两个优化样本不能证明未来所有 CI 的绝对上界。

## 可重复证据

- Run 44493686356: https://github.com/moesin-lab/Remi/actions/runs/44493686356；artifact `backend-shard-2`（ID 14515064175）；artifact SHA `f07dff0a76256bce2a577b9cd5ec9d76b68c2ed7`；目标文件 `13.101s`、失败数 0。
- Run 44494221188: https://github.com/moesin-lab/Remi/actions/runs/44494221188；artifact `backend-shard-2`（ID 14517057388）；artifact SHA `0d5cab63996a0ae6afd242bd103a6a730befdf33`；目标文件 `7.855s`、失败数 0。
- Run 44494282518: https://github.com/moesin-lab/Remi/actions/runs/44494282518；artifact `backend-shard-2`（ID 14518680142）；artifact SHA `e80c06262d71408fa39d0e3844908129bfce3b9d`；目标文件 `9.633s`、失败数 0。

原始筛选数据见 [CI 计时数据](ci-timings.txt)（JSON 格式）；完整原始分片 JSON 来自上述 GitHub artifact。分片统计覆盖会输出 `REMI_TEST_DB_FIXTURE_STATS` 的 helper，不能当作全仓数据库构造次数。

## 行为与验证边界

四例仍各有独立数据库、连接及新 Store，调用真实生产迁移入口；仅将重复冷历史迁移换成一次模板构建及克隆。保留关闭连接、原生种子恢复、schema/request cache/订阅/事务守卫和 rollback/afterCommit 原断言；补充跨克隆 schema 隔离及一次模板/四次克隆断言。未增加 timeout、未新增 skip 条件、未放宽原断言。

执行命令：`bun run test tests/unit/multiremi/routing-matrix-database.test.ts tests/unit/multiremi/pending-turn-reusable-database.test.ts tests/unit/multiremi/multiremi-store-task-routing.test.ts`。初次交付本机 SQLite 相关定向测试 77 pass；当时最终契约文件复跑 4 pass（未配置 PG URL，按原条件跳过）。仅未配置 `MULTIREMI_TEST_POSTGRES_URL` 时跳过；已配置但服务不可达或权限不足会失败，不会跳过或回退。后续真实本机 PG17 反向验证见下文。`bunx tsc --noEmit`、`npm run docs:test`（13 pass）、`npm run docs:check`、`git diff --check` 通过。PG 验证来自上述真实 CI。

首次独立审阅未发现已确认的源码缺陷，要求补充反向回归证据；下文已补齐，等待独立复审。尚未合并或部署，测试夹具变更不涉及运行时代码。

## 完整 CI 状态

| 运行 | 最终状态 | attempt | 完整覆盖 |
| --- | --- | ---: | --- |
| [44493686356](https://github.com/moesin-lab/Remi/actions/runs/44493686356) | completed / success | 1 | 921 文件 / 8 分片 / 0 失败 |
| [44494221188](https://github.com/moesin-lab/Remi/actions/runs/44494221188) | completed / success | 2 | 921 文件 / 8 分片 / 0 失败 |
| [44494282518](https://github.com/moesin-lab/Remi/actions/runs/44494282518) | completed / success | 1 | 921 文件 / 8 分片 / 0 失败 |

首次 PR CI attempt 1 的分片 1 中，`multiremi-two-process.test.ts` 第 1 轮冷启动触发 `multiremi_workspaces_pkey` 重复键；其下游 build 汇总随之失败。该文件在分片中最先执行，使用独立 PG 服务和未修改的 two-process helper/生产 Store，未引用本次修改的 helper，目标四例位于另一分片。已保留原始失败位置和 job 链接，并在完全相同源码上原样重跑失败 job 及其下游检查。重跑结果见上表，不把第一次运行描述为全绿。该冷启动竞态未在本 PR 中修复。


## 反向回归补充验收

PR: https://github.com/moesin-lab/Remi/pull/146
源码 head: e80c06262d71408fa39d0e3844908129bfce3b9d
基线: b897f0633f6ff4375a4e439045b037004d81953c
分支: agent/MUL-304。反向验证期间仓库源码未修改；本报告及原始数据随后作为文档提交到同一分支，不改测试实现。未重跑完整 CI。

本次在 Linux n36-000-223 的 git archive 可丢弃副本 /tmp/mul304-reverse 上执行，Bun 1.3.14，真实 PostgreSQL 17.12。数据库二进制从 apt.postgresql.org 的 bookworm-pgdg 包解压至 /tmp/mul304-pg/root17，以 user namespace 的 uid/gid 1000 启动专用本地服务，只监听 127.0.0.1:55484，数据位于 /tmp/mul304-pg/data17；不是 mock 或业务数据库。该服务已在验证后停止。副本仅依赖 node_modules 软链接原仓库，生产 TS 路径由副本自身 tsconfig 指向 archive 内源码。

首次尝试系统源 PG 15.19 时，在原实现对照的 beforeAll 中遇到生产 JSON 语法不支持（syntax error at or near JSON）。原始失败另保留为 pg15-incompatible.txt，不计作变异失败或通过证据。改用与 CI 相同主版本 PG17 后才开始下面四轮。本次不是新的完整 CI 采样，原两轮 CI 性能结论不变。

四轮相同命令（不提高 timeout、不改变 skip、不改断言）：

```bash
PATH="$HOME/.bun/bin:$PATH" MULTIREMI_TEST_POSTGRES_URL=postgresql://postgres@127.0.0.1:55484/postgres bun run test tests/unit/multiremi/routing-matrix-database.test.ts
```

| 副本状态 | 进程退出 | 结果 | 命中证据 |
| --- | --- | --- | --- |
| 原 e80c06262 | 0 | 8 pass / 0 fail | 34 expect；templateBuilds=1, clones=4, freshFallbacks=0 |
| fresh 变异 | 1 | 4 pass / 5 fail | :22 的 toMatchObject 期望 clones=4，实际 0；另有四例 5000ms timeout |
| shared 变异 | 1 | 7 pass / 2 fail | 原 :140（变异后 :141）的 toBeNull 收到 routing_schema_mutation；原 :22（变异后 :23）期望 clones=4，实际 1 |
| 恢复原 e80c06262 | 0 | 8 pass / 0 fail | 34 expect；templateBuilds=1, clones=4, freshFallbacks=0 |

fresh 精确补丁只令 consumer 不再申请克隆，让未传入数据库的 helper 回到原有 fresh 建库路径；保留新增断言。由于仍保留套件模板预热，该负向实现也保留了模板成本，不把它当作优化前基线性能数字。该运行四例实际出现超时；稳定回归证据是独立打印的 clones 数量断言失败，不声称未来任意机器必然超时。

shared 精确补丁令 suite 只申请并缓存一个数据库，将删除推迟到已有 suite dispose；每例仍关闭连接并新建 Store。第三例提交的 DDL 因此进入第四例，命中 schema 隔离断言，同时 clone 计数断言也失败。没有修改任何 expect、timeout 或 skip。

恢复后目标测试文件与 git archive 原文件逐字节相同，SHA256 均为 e5add1165b8b26d069e3760e7ce7f3ec05eab05fc1008589c98e753e47e13244。原仓库 git status clean，远端分支仍为上述 head。验证结束查询 pg_database，mul304_% / reusable_store_% 名称均 0 行；该结果只证明这四轮正常结束和这些断言失败路径的清理，未覆盖强杀、权限故障。

[完整反向验证证据](reverse-regression-evidence.txt) 含完整运行日志、精确 unified diff、变异/恢复脚本、SQL 版本及清理查询输出。待独立审阅者复核并给出复审结论；不以开发者自验替代独立复审。PR 尚未合并，子审阅 Issue 保留 in_review。
