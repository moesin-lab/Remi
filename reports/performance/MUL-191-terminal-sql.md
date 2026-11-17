# MUL-191：终态查询预算（尚未验收）

当前规范测量和完整逐语句说明在 [终态预算与剩余审计](MUL-191-terminal-remaining.md)，对应原始 SQL/source 为 [剩余语句 JSON](MUL-191-terminal-remaining.json)。本分支普通合入 main 和 #112 的共享夹具/批量快照，没有 rebase 或强推；PR #105 目标为 main，保持 Draft。

| 帧 | 扩展 main 小档读/写=总数 | 扩展 main stable | 当前小档 | 当前 stable | 目标 |
|---|---:|---:|---:|---:|---:|
| turn.complete |366/105=471|610/185=795|177/52=229|177/52=229|≤60|
| task.fail |362/75=437|906/195=1101|116/25=141|116/25=141|≤40|

两档锁定相同的常数。旧 2/40 context 夹具另为 complete 165/48=213、fail 107/27=134；不能替代扩展夹具。新增 12 个活跃 attempt、8 个 AUQ/权限请求、20 条待发送飞书、12 runtime，单维度增量见 [MUL-199 报告](MUL-199-live-dimensions.md)。

第三轮在同一同步帧内合并 turn/attempt/message/Session/Chat/Project 等读取，Chat lineage 只取宿主身份。当前 229/141 仍超过 60/40（分别差 169/101）。逐执行清单包含 SQL、次数、来源、分类、参数和 scope/generation；同参数、同代际且依赖未写入的相同 SQL 无剩余重复。剩余项跨锁/写入/后台快照，或读取不同投影；接受此预算仍由所有者决定，不宣称数学最小值。

第三轮本地定向回归：10 文件 168 pass / 53 skip / 0 fail，覆盖终态、输入、缓存失效、Q、Session 和 Chat workspace lineage；新增真实 SQLite 缓存回归检验锁后重读、写后新值、回滚和对象隔离。PG skip 不计通过。完整 CI/最终 SHA 以 PR 描述和交付评论为准。

尚待：所有者接受超过 60/40 的剩余清单、最终 SHA 的真实 PG/完整 CI、独立审阅、获授权后合并/部署与 8+ 并行一小时 lag<1s 现场验证。本轮没有合并、部署或置 done。
