# MUL-199：活跃轮次、待处理 Q 和飞书发送维度

基线为 a4d6cba07（main + 原始规模夹具）；本轮只增加夹具维度。小档额外 2 个活跃 attempt / 1 个 AUQ / 1 条待发送；stable 额外 12 个活跃 attempt / 8 个 AUQ（含权限请求）/ 20 条待发送，runtime 4→12。历史维度仍是 100 issues、40 sessions × 501 logs、10 agents × 3 skills、80 历史 attempt+usage、100 outbox/队列。活 attempt 使用独立 Chat lane，均在报告宿主 rt_cost_0，状态为 running/awaiting_human；progress/fail 报告宿主 rt_cost_2。

## 前后两档（读/写=总数；含排队下行与派活）

| 帧 | 基线小档 | 基线 stable | #112 小档 | #112 stable |
|---|---:|---:|---:|---:|
| hb | 43/19=62 | 43/19=62 | 43/19=62 | 43/19=62 |
| task.start | 175/49=224 | 415/129=544 | 77/19=96 | 77/19=96 |
| task.progress | 44/10=54 | 44/10=54 | 40/10=50 | 40/10=50 |
| task.workspace | 51/15=66 | 211/55=266 | 33/9=42 | 33/9=42 |
| turn.input | 109/32=141 | 189/72=261 | 81/20=101 | 81/20=101 |
| turn.complete | 366/105=471 | 610/185=795 | 338/96=434 | 502/136=638 |
| task.fail | 362/75=437 | 906/195=1101 | 339/66=405 | 803/146=949 |

终态帧在 #112 中只测量，不作为本单预算；#105 已普通合入这组夹具与快照，组合版数字见 MUL-191 报告。

## 单维度增量（固定原 stable 历史规模）

基点 runtime=8、活 attempt=2、Q=1、待发送=1。active 比 base 多 10 个活 attempt；questions 比 active 多 7 个 Q；outbound 比 base 多 19 条待发送；runtimes 比 base 多 4 个 runtime。数字来自六次独立运行（每组 seed 一次），原始每条 SQL 计数均保存在相邻 JSON。

| 帧 | +10 活 attempt | +7 Q（已固定 12 活 attempt）| +19 待发送 | +4 runtime |
|---|---:|---:|---:|---:|
| hb | +0/+0 | +0/+0 | +0/+0 | +0/+0 |
| task.start | +80/+40 | +0/+0 | +0/+0 | +80/+20 |
| task.progress | +0/+0 | +0/+0 | +0/+0 | +0/+0 |
| task.workspace | +0/+0 | +0/+0 | +0/+0 | +80/+20 |
| turn.input | +80/+40 | +0/+0 | +0/+0 | +0/+0 |
| turn.complete | +80/+40 | +0/+0 | +0/+0 | +80/+20 |
| task.fail | +80/+40 | +0/+0 | +0/+0 | +232/+40 |

+10 活 attempt 在 start/input/complete/fail 各增加 80 SELECT + 40 写：每 attempt 一次 turn_id、当前 turn 关联校验、Runtime、head、日志窗口、两次 attempt receipt、任务身份（各 10 次）；workspace/lane/projection 写各 10 次（lane 为两次）。本次把这段改为集合 lane 锁、当前关联+receipt/head、日志窗口和两次集合水位写。runtime 维度的 full fanout 成本已由上一轮 #112 的定向 Runtime 事件处理消除。

Q 增量和待发送数量增量均为 0：Q 在业务创建事务完成路由，普通帧不逐 Q 重走处理；飞书每次只推进一个有效待发送实体，没有随历史/队列长度逐行读取。这不证明处理 Q 或发送结果帧本身的成本。

## 验证和边界

本地新规模回归 10 pass（10.42 s；时钟修复后另见交付证据），包含固定预算、完整终态/回复、活 Q 和待发送行计数，以及批量输入/wrap-up、跨宿主拒绝。另两个相关回归文件 30 pass / 3 PG skip，38.76 s；tsc 和 docs:test/docs:check 通过。

旧 #112 完整 run 44167167312 的 PG backend (3) 失败：两档同时存活时，PG stable seed 超过 15 s ACK deadline，第一档连接在测量前关闭（hb 0 SQL，后续无响应）。新增可选 protocol clock 参数并为 SQL 夹具使用现成 ManualDaemonProtocolClock；生产仍用 systemClock，15 s 不变。新的完整 CI 尚须确认；不把 SQLite 或 PG skip 当作 PG 通过。

## 现场差距仍未闭合

历史+活 attempt 的原 main stable complete 达 795（现场 660 落在其间），runtime 和活轮次维度足以解释量级但不是逐条复现。hb 62 对现场 124–175、progress 54（优化后50）对263的差距仍存在：本夹具没有模拟现场各宿主活轮分布、插件 binding/version/desired 状态、outbound operations 回放与协议重连同时发生的组合。需要所有者提供每宿主活 attempt 和 Q 状态计数、插件绑定/版本行数、pending/sending outbound/operations 计数、实际 hb 和各 task 帧数/min；这些是后续夹具补齐指标，当前未读取线上数据。

未按缺失帧频冒充总负载排序；本轮优先处理实测会随活 attempt 增长的 start/input 下行。PR 保持 Draft，未合并、部署或置 done。
