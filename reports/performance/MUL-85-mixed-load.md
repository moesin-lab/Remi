# MUL-85：SQL 来源定位与修复验证（2026-11-17）

PR：https://github.com/moesin-lab/Remi/pull/83 。基础版本 def540e09bf0cac777bbb3eced88fb405cc6d4c4；
第二阶段对照基线 7aa4bb7888f90073ebf55ae60068e8724ac0786a（包含第一阶段 HTTP 指标与预算回归），
两组均叠加相同的观测器、job 边界、真实 WS/HTTP 混合负载夹具；修后另加本 PR 的 claim 批处理。
所有原始聚合结果见同目录 `MUL-85-mixed-load.json`。本报告是隔离模型实测，不是线上 PG 或实际 lane 规模验收。

## 方法与口径

8 个 Agent、60 个 queued Chat、100 条 inbox 消息、1 个实际 daemon socket 广告 8 个已注册 Runtime，
每 15 秒真实 WS heartbeat；后台使用生产 scheduler/SCM/title/messaging/notification/capability 入口，
恢复测试环境原本关闭的 60 秒 offer sweep。Provider 为 inert fixture，**活跃 provider lane 为 0**。
独立客户端进程里的 10 个 poller 每秒并发请求五个真实鉴权路由，各路由 600 次，共 3000 次。
发送持续 60 秒，等待全部响应后结束窗口，未丢请求或增大产品超时。每次 SQLite 执行注入 2.5 ms
同步延迟，嵌套执行只计一次，用于模拟同步 DB bridge 对事件循环的压力，不代表真实 PG 查询耗时。

`db_sources` 在 SQL 完成时与进程总量同窗归因，分类总量不受 Top N 截断影响。
`db_unattributed = db_queries - HTTP - WS - job`。`db_routes` 仍按 HTTP 完成窗口统计，不能用来相减。
`count` 是窗内启动或执行 SQL 的 invocation 数；跨窗 invocation 可在两窗各计一次。
HTTP p50 使用独立客户端墙钟，包括事件循环排队；服务端中间件 p50 不包含全部接收前排队。

## 修前统一 Top 10

|来源|调用数|平均 SQL/次|SQL 总数|SQL 累计耗时 ms|
|---|---:|---:|---:|---:|
|job `daemon.offer`|16|748|11968|31873.9|
|http `GET /api/inbox`|600|6|3601|13235.7|
|http `GET /api/multiremi/runtimes`|600|6|3600|9861.9|
|http `GET /api/chat/sessions`|600|5|3000|9587.6|
|http `GET /api/issues`|600|5|3000|8179.2|
|http `GET /api/turns`|600|4|2401|6775.4|
|ws `hb`|7|248.57|1740|4864.7|
|job `capability.sweep`|1|751|751|1996.4|
|job `scheduler.sync`|2|6|12|32.4|
|job `messaging.sync`|6|2|12|31.7|

## 根因、引入点与处理

1. **daemon.offer**：空派活先为每个排队候选完整 getTask（usage 聚合、autopilot 关系），再逐 Chat/Agent/插件读取；
   插件 snapshot 与 capability revision 又重复读取。Chat affinity 路径引入于 `6308cf0f2e`（2026-09-11），
   profile 候选 getTask 引入于 `07183f54a7`（2026-09-18），并非已证实的 11 月新增回归。
   本 PR 只取 eligibility/affinity 决策列，批量读取 Chat/Agent，当前锁内按 Agent 复用插件事实，选中后仍完整 hydrate。
   **16 次扫描均从 748 SQL/次降至 54 SQL/次**；1/10/50 Chat 的单 Agent claim 均为 23 SQL。
   没有跨请求缓存、锁或派活协议变更。
2. **GET /api/inbox**：600 × 6。当前为身份/权限、计数/分页、批量附件/反应等不同读取；基线已有批量化，
   返回规模回归覆盖。未发现能在保持语义下继续直接消除的 N+1，不以缓存陈旧或漏掉权限读取换取数字。
3. **GET /api/multiremi/runtimes**：600 × 6。身份/权限、runtime 及关联聚合读取；基线已有批量 runtime 查询，
   本阶段未见重复等价查询。余下成本主要由轮询次数决定。两条 HTTP 来源不能据此定性为新增回归。
4. **chat/sessions**：600 × 5，列表和批量 Agent/后台任务；未见逐行 SQL，相关 SQL 内部扫描仍需真实 PG EXPLAIN。
5. **issues**：600 × 5，鉴权与列表事实；无逐条 hydration，真实数据规模执行计划待查。
6. **turns**：600 × 4（另有一个异步来源查询），基线已有批量 metadata/usage hydration，计数回归与返回规模无关。
7. **hb**：Runtime fanout 及 heartbeat 后处理。`fa63bfcb8` 引入的 drain +8 SELECT 回归由 MUL-84 独立负责；
   本 PR 不包含其业务修复，独立组合候选为 `ef04e5ffe7ee04ca383a3474a12c80b4e671ec3f`。
8. **capability.sweep**：751 SQL/次；逐候选能力决策是后续优先调查项，不把后台归因遗漏当作 HTTP 流量。
9. **scheduler.sync**：6 SQL/次，调度入口的不同队列/状态读取；暂无已证实 N+1。
10. **messaging.sync**：2 SQL/次，两个队列扫描；暂无已证实 N+1。

MUL-53 的 usage snapshot 写入在本 fixture 没有发生，不能据此降低其线上优先级或宣称解决 O(n²)。
需要天工决定的后续方案：可见页面才轮询、失效通知驱动刷新，或合并多个列表的鉴权/版本检查。
这些方案改变轮询协议或一致性边界，本 PR 没有实现；也没有增加服务端持久缓存。

## 同规模前后与敏感性

|组别|实际窗口 s|SQL 总数|归一 SQL/min|最大 loop lag ms|turns 客户端 p50 ms|inbox 客户端 p50 ms|
|---|---:|---:|---:|---:|---:|---:|
|修前 N8/M10|98.836|30097|18275.1|21805.8|20320.9|20349.0|
|修后 N8/M10|65.526|18781|17198.2|3551.3|2551.6|2580.0|
|修后 + MUL-84 N8/M10|64.563|18250|16961.5|2905.6|2009.2|2028.8|
|修后 N4/M10|60.752|16723|16517.1|1984.9|1101.5|1125.8|
|修后 N8/M5|62.175|10766|10390.1|3062.2|286.0|313.2|

修前/修后均 3000 次成功 HTTP，零客户端错误、零 5xx、零 dropped。不同排空时长会改变 heartbeat、
60 秒后台扫描的触发次数，所以不能将 SQL 总数差全部归为单一代码收益；归一 SQL/min 也因修后处理吞吐
提高而只小幅下降。确定性的单次 offer 成本 748→54 比跨窗口差值更能隔离修复效果。
修后仍约 17k SQL/min，说明固定 HTTP 轮询流量仍是下一步协议决策的主要来源，未宣称消除线上高负载。
组合 MUL-84 的数字仅为独立运行观测，不能把不同 heartbeat 次数和 timer 相位当作其净收益。
敏感性表保留原始参数；N4/M10 和 N8/M5 并非同规模前后验收。

## 复现与上线复核

```sh
MUL85_RUNTIMES=8 MUL85_POLLERS=10 MUL85_SECONDS=60 MUL85_SQL_MS=2.5 \
  MUL85_PROFILE_OUT=/tmp/mul85-mixed.json bun test tests/manual/profile-api-mixed-load.test.ts
```

先 checkout 本报告的基线/修后候选，在隔离 worktree 中应用相同 observer/profile 支持；基线不得应用
`tasks-repo.ts`、`chat-repo.ts`、`store.ts`、`context.ts` 的第二阶段批处理修改。
MUL-84 组合变体在独立 worktree 应用上述候选对 def540e09 的心跳差异，不合入本 PR。
注入延迟只存在于手动测试。PostgreSQL、真实活跃 lane 和生产数据集尚未验证。

由仓库所有者在 API 环境设置 `MULTIREMI_METRICS_DB_ROUTES=1`、`MULTIREMI_METRICS_SUMMARY_TOP_N=20`，
部署/重启后采集至少 5 分钟（按真实容器名替换）：

```sh
docker logs --since 5m multiremi-platform-app-api-1 2>&1 | grep -E '"event":"(api_minute_summary|ws_minute_summary|api_slow_request)"'
```

同时提供发布 SHA、pid/role、真实 daemon/runtime/Agent/活跃 lane 数、浏览器标签数和轮询节奏；
前后保持规模一致，对比进程 SQL/min、lag、turns/inbox p50、同窗来源榜及 db_unattributed。
本环境没有宿主机 docker 权限；不声称已部署或已通过线上验收。部署并复核前保持 in_review。

## 实际验证

Bun 1.3.14，最终所选回归使用仓库 HOME 隔离包装：

```sh
bun run test tests/unit/multiremi/db-source-attribution.test.ts tests/unit/multiremi/claim-queued-chat-query-count.test.ts tests/unit/multiremi/request-metrics.test.ts tests/unit/multiremi/first-screen-hotspots-query-count.test.ts tests/unit/multiremi/first-screen-hotspots-inbox-attachments.test.ts tests/unit/multiremi/multiremi-claim-hydrate-selected.test.ts tests/unit/multiremi/multiremi-store-task-affinity.test.ts tests/unit/multiremi/multiremi-store-task-routing.test.ts tests/unit/multiremi/multiremi-store-agent-plugin-execution.test.ts tests/unit/multiremi/central-profile-task-routing.test.ts tests/unit/multiremi/messaging-scheduler.test.ts tests/unit/multiremi/body-html-backfill.test.ts tests/unit/multiremi/issue-title-poller.test.ts tests/unit/multiremi/scm-poller.test.ts tests/arch/package-boundaries.test.ts
node node_modules/typescript/bin/tsc --noEmit --pretty false
bun run docs:test
bun run docs:check
bun run scripts/snapshot-api-routes.ts --check
git diff --check
```

结果：15 文件 **229 pass / 11 skip / 0 fail**，6191 assertions，94.69 秒；skip 为未配置真实 PG 的桥接专项及环境条件分支，不是 PG 通过。
类型检查退出 0；文档测试 13/13、文档校验、路由快照与 whitespace 校验通过。
`db-source-attribution` 覆盖并发、跨窗、响应后异步 SQL、Top N 分类总数、溢出和默认关闭。
本报告所有手动 profile 均以 `bun test` 实跑，未将其描述为完整隔离包装或线上测试。

独立 `bun run test tests/integration/daemon-protocol-v2/heartbeat-plugin-cost.test.ts`：
主分支变更组合 **5 pass / 3 fail**（现有 MUL-84 full-drain 查询预算回归，mesh 实测 37 > 30）；
独立叠加 MUL-84 候选的 worktree 为 **8 pass / 0 fail**。没有放宽预算或将其修复文件带入 MUL-85。
第二阶段最终 SHA 尚待独立审尺复审与探微回归；先前 SHA 的独立结论不能替代本次验收。
