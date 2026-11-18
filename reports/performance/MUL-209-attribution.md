# MUL-209：并发帧 SQL 归因与 stable 采样边界

## 来源与结论

仓库基线 `8cc817d2ca31db59f2c6fb39f040b0edf99c1134`，任务 worktree
`agent/MUL-209`。本次先修复已证实的指标缺陷，不据未归因汇总推断业务 SQL 的 N+1。
没有合并、部署或改变 stable 配置。

所有者在 Main 会话评论 `cmt_5vcpiakbk43n` 提供附件 `mul209-stable-samples.md`
（attachment `att_177b5d920b994ff0bb61abe6615eb049`，58627 bytes）。来源是
`docker logs remi-stable-api-1` 最近 20 分钟，只读；平台部署
`618330b1ba56ec408323089baf3bceaae1ad50f3`，daemon `0.2.95+main.618330b1b`。
附件含各 20 条 API/WS 汇总，结束时间为 2026-11-18 09:20:33.623 至
09:39:39.671 UTC，窗口约 60 秒。实际 JSON **没有 db_sources、db_attributed
或逐语句统计**，所以无法从本附件推导占主导的 SQL、其次数、读写拆分或数据维度。

API 总查询 175312，event_loop_lag_max_ms 最大 10610.8；WS 已列出的类型查询
合计 110315。该合计小于 API 总数不能证明归因正确：重复归因仍可能与 HTTP/job 查询同时存在。
下表均为旧版全局差值口径，仅用于选择后续采样对象，不是真实帧 SQL 预算。

| 帧 | 总帧数 | 平均帧/分钟 | 旧口径查询合计 | 查询/帧加权平均 | 每分钟查询/帧范围 |
| --- | ---: | ---: | ---: | ---: | ---: |
| hb | 166 | 8.30 | 16943 | 102.07 | 77.50–147.56 |
| task.start | 19 | 0.95 | 4075 | 214.47 | 69–646 |
| task.progress | 40 | 2.00 | 1163 | 29.07 | 6–132 |
| task.workspace | 71 | 3.55 | 10217 | 143.90 | 31–254 |
| task.usage | 1194 | 59.70 | 52481 | 43.95 | 37.95–70.45 |

例如结束于 09:39:39 UTC 的一分钟，API 为 6191 查询；WS 为 139 帧，其中
usage 48 帧/1836 查询、hb 8/632、start 1/225、progress 1/132。
usage 频率和旧口径总量较高，值得优先采样，但不能据此指定真实放大原因。

## 已修复的指标维度

旧 Session 在处理前后读取进程全局计数。8 个连接各发一条查询，在全部执行后才结束帧，
每帧会把其他连接的 SQL 包含进去。上一轮真实 Session 的无数据库探针结果为
帧合计 36、db_sources.ws=8；这是合成指标诊断，不能证明现场污染比例。

现在复用 `db-sources.ts` 的 AsyncLocalStorage，每帧提供独立计数对象，SQL 完成时
同一钩子增加当前来源与当前帧的次数/耗时。其他连接、HTTP、无来源活动及嵌套独立 job
不增加该帧计数。来源汇总关闭时仍可收集帧计数，嵌套来源仍隔离。移除全局差值注入入口。
协议 ACK、心跳回包、progress 落库和下发队列的业务实现未改变。

回归使用 8 个独立 Session 的实际序列化链，先让每帧执行 1 次再统一释放，要求各帧 1、
合计 8，并在开启来源汇总时要求 db_sources.ws=8。另覆盖来源关闭、嵌套 job、失败和
来源窗口重置。配置 `MULTIREMI_TEST_POSTGRES_URL` 时八连接测试使用真实 PG bridge
执行 SELECT 1；无 PG 配置的本地测试使用 SQL 完成钩子，不能算真实 PG 验证。

计数归属一致不等于每分钟数字严格相等：WS 在帧完成时入窗，db_sources 在 SQL
完成时入窗；帧返回后的派生异步工作仍进入 db_sources，不修改已发出帧样本。
比较需考虑相邻窗口、top-N 和 dropped。业务夹具测到 drain 完成，可能含独立下发工作，
也不能直接等同于单帧完成样本。

## 每帧业务读写预算：没有因指标修正而减少

本地 SQLite 规模预算两档（small/stable）均保持下列前后常数；这不是现场真实 PG 数字。
本轮未根据无语句证据的猜测扩充业务维度或宣称消除了真实 SQL 放大。

| 帧 | 修改前读/写 | 修改后读/写 |
| --- | ---: | ---: |
| hb | 43/17 | 43/17 |
| task.start | 63/17 | 63/17 |
| task.progress | 30/8 | 30/8 |
| task.workspace | 32/8 | 32/8 |

`task.usage` 已有 context-size 与 3000 历史 usage units 回归；它不在当前四帧规模固定预算表中，
本次没有新增真实 PG 常数。等待 corrected 现场与语句证据后再定位实际维度和批量化。

## 请所有者提供的下一窗口（只读）

本 PR 未来获准部署后，取连续 **10 分钟**，记录精确起止 UTC、API/daemon SHA、每条
汇总 ts/window_ms、WS 所有 types 的 count/db_queries/db_ms/dropped，API 的
数据库总数/db_busy_pct/event_loop_lag_max_ms、db_sources/db_attributed/db_unattributed
（若当前配置没有这些字段，请注明，不要求为本单更改 stable 配置）。需要包含 hb/progress，
同时记 start/workspace/usage。语句计数用同窗口前后快照求差，不 reset 统计。
同步提供连接 daemon/peer 数、浏览器/Live Hub 订阅数、bot/runtime/后台任务数、
每 agent skill/plugin/binding/version/desired 数及活跃 attempt 数；缺失项明确标为不可观测。

SQL 见同目录 `MUL-209-readonly-sampling.sql`。先只运行存在性/权限检查；仅当已有
pg_stat_statements 时，将其安装 schema 代入第二段，在 t0 和 t0+10min 各导出一次。
不安装扩展、不改 track 设置、不 reset。query 中可能有业务字面量，请所有者脱敏后回传；
保留 queryid、规范化结构与次数/时间。pg_stat_statements 仅能给进程/数据库总语句成本，
无法单独将 queryid 绑定到某帧；须结合修正后的来源榜和源码/隔离夹具交叉归因。
若未安装，可由所有者每秒执行活动采样 10 分钟；活动样本是耗时占比近似，不能当准确调用数。

## 验证状态

本地 Bun 1.3.14：协议 Session、WS metrics 与来源归因 83 pass/0 fail；规模预算与
query-budget 37 pass/0 fail（SQLite）。本地完整 Release build check 不等于以上针对性测试；
最终 CI 状态、真实 PG 分片和未执行项以 PR 描述及本会话交付评论为准。


## MUL-224 审阅补测：真实 WebSocket 与去修复反证

在 Linux 开发机、Bun 1.3.14 上新增两个真实 WebSocket 回归（来源汇总开启/关闭）。
隔离服务使用 `startMultiremiServer`，8 个独立 daemon/runtime 经真实 upgrade/hello/message
进入注册的 trace.head RPC；每帧先查询一次，全部到达屏障后，插入 HTTP/job/无来源查询，
释放屏障，再各查询一次。测试同时断言回包、每帧计数 2、实际 flushMetrics 输出的
ws_minute_summary 为 8 帧/16 次，以及 db_sources 的 trace.head 来源为 16 次（启用时）。
监听 metrics ring 使用 call-through spy，不替换 Session、传输或汇总实现。
配置真实 PG URL 时查询均经过 PG bridge；本地没有 PG URL，SQL 完成钩子替身仅验证
真实 WS 的上下文/输出接线，不作为 PG 通过证据。

去修复反证在 `/tmp/mul209-old-attribution` 的隔离 archive 执行：保留新测试，
将 session.ts、daemon-protocol/index.ts、api/server.ts 恢复为基线 8cc817d2c 的全局差值接线。
同一测试命令得到 0 pass / 2 fail，均在每帧计数断言失败：实际为
19,18,17,16,15,14,13,12（合计 124），预期八个 2（合计 16）。
未更改任务工作树中的运行实现。命令为
`bun test tests/unit/multiremi/daemon-protocol-server.test.ts --test-name-pattern 'MUL-209 real'`。

补测版本的四文件协议/归因回归为 98 pass / 0 fail，类型检查通过。
旧 head fc3e045c575129a34ac32f28edd04b537a48a655 的完整 Release build check
[44280138146](https://github.com/moesin-lab/Remi/actions/runs/44280138146) 已核实 completed/success，
8 个真实 PG backend 分片均 success。这不代替补测后新 head 的完整 CI；新结果以 PR 描述为准。
