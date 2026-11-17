# MUL-191：共享规模夹具的终态测量（目标未完成）

本单仍未达到 turn.complete ≤60 / task.fail ≤40，保持 Draft；以下是可审阅的阶段性改动。#99 已合入 main，本分支普通合入 origin/main 和独立夹具 a4d6cba07（未 rebase、未强推）。PR #105 目标为 main。

## 同一夹具的读 / 写 / 总数

基线来自 MUL-199 反向应用 runtime 优化后的同口径测量（ba203f401）；当前为 agent/MUL-191，包含 ACK 排空和 layer.drain 的下行/派活工作。每档建数一次：小档 2 issue、2 session×4 logs、2 agents×1 skill、4 runtimes；stable 档 100 issue、40 session×501 logs、10 agents×3 skills、8 runtimes，以及历史 attempt/usage/outbox/队列。完整维度见共享夹具 daemon-report-scale.ts。

| 帧 | main 小档读/写=总数 | main stable 读/写=总数 | 当前小档读/写=总数 | 当前 stable 读/写=总数 |
|---|---:|---:|---:|---:|
| turn.complete | 352/92=444 | 456/112=568 | 201/49=250 | 201/49=250 |
| task.fail | 348/62=410 | 600/102=702 | 137/21=158 | 137/21=158 |

两档相等且 SQLite 的读、写、总数均锁定常量；真实 PG 配置时测相同两档相等，但尚未取得本次 PG 常量。250/158 仅是实测，不是理论下限。现有旧上下文夹具也通过，不能用其数字替代本表。

## 本次消除的增长

- workspace offer 唤醒先用一条 DISTINCT 查询定位 queued/dispatched 的 runtime，只在这些宿主检查 claim。runtime_id=NULL 保留全宿主 admission；释放槽位仍检查其他宿主的排队任务，全局 agent 容量语义不变；周期 sweep 保留。
- Agent 关联 Skill 文件由逐个 Skill 存在性/文件读取改为单条 JSON 集合查询，保持 Skill 顺序与各文件 path 顺序。读取缓存仍依赖 skill_files，写入失效。
- chat:queue_updated 只刷新浏览器，不再全工作区唤醒 daemon 下行；队列释放后的正常 message/task 通知仍驱动派活。终态状态、回复正文与 ACK 另有断言。
- 保留已有事务锁复用、终态轮卡通知合并、原始读取复用、lane 与日志 allocator upsert、outbox 和 replay 的规范入口。

本轮所有语句及次数见 [当前两档 profile](MUL-191-terminal-scale-statements.json)。[旧终态逐语句分析](MUL-191-terminal-sql.json)对应先前 258/163 的上下文夹具，只用于解释旧调用来源，不能视为当前数字。MUL-199 的 baseline statement report 逐条列出 runtime/agent/skill 增长。

## 现场 660 的解释边界

共享夹具 main complete 已从旧夹具约 404 增至 568；runtime 广播派活和 Skill 水合是实际定位到的增长路径，当前两档均为 250。现场 660 尚未逐条复现，568 与 660 的 92 条差距未闭合：目前仅两个主要活轮加 bot 任务、每 daemon 两种 provider，未覆盖现场各 runtime 活 attempt 数和 AUQ/飞书待回放组合。因此不能声称 660 已被完整解释。需 stable 只读维度统计和每分钟帧频后补齐夹具；没有这些数据，不能按单帧数字冒充总负载排序。

## 验证与尚待工作

- 共享规模测试 8 pass / 0 fail（8.79 秒）；新增固定预算与状态/回复断言后，在双文件验证中该 8 项仍通过。
- 相关六文件 97 pass、4 skip、0 fail（59.31 秒）：daemon offers、offer routing、Skill 读预算、Chat queue、runtime request queue、旧 report budgets。PG skip 不计通过。
- 新增 queued host / 未分配 host / 空队列唤醒回归：1 pass / 0 fail（1.47 秒）。开发时曾误用 db helper、写入只读 view，已改为修改规范 attempt 表并实跑通过。
- 真实 PG 尚无通过证据。Docker socket 不可访问；容器 uid_map 仅映射 root，非 root initdb 无法启动。不把 SQLite skip 写成 PG 通过。
- 旧 head 0e96caa0b 的完整 Release build check [44141078536](https://github.com/moesin-lab/Remi/actions/runs/44141078536) 结论 failure：PG backend 0/2/3/4/5/6/7 失败、1 成功；两项 macOS cancelled。旧运行既不全绿，也不能证明本次 head。本轮 bunx tsc --noEmit 通过；docs:test 13 pass / 0 fail；docs:check 通过。当前 head 的完整运行以交付评论和 PR 描述为准。

剩余：继续将完整终态事务和提交后下行收敛到 60/40，保持回复 provenance、input_unread、自动回复回滚重试与 outbox；真实 PG 和完整 Release build check；独立审阅；获授权后合并、部署及 8+ 并行一小时 lag<1s 现场验证。本轮未合并、未部署、未置 done。
