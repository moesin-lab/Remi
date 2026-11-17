# MUL-88：final 后输入确认超时

调查日期：2026-11-17。基线：`d953761add45efd7b957a959d9f6ed7b27751fff`。
隔离工作分支：`agent/MUL-88`。没有重启或修改 stable 实例。

## 线上证据与边界

`remi turn trace read tsk_kszu5p503xvd --json` 返回：

- final item：`msg:msg_011Ch7qJFDAfuPa1Ux1Ar8a4`，`phase=final`。
- final 开始/结束：04:01:23.722 / 04:01:23.815 UTC。
- turn completed_at：04:01:34.679 UTC，status=failed。
- error：`daemon RPC failed: daemon_timeout`，reason=`agent_error.unknown`。

宿主 `~/.multiremi/daemon.log`（时间为 UTC+8）第 169246 行记录
`[12:01:34] ERROR [multiremi-daemon] Failed task tsk_kszu5p503xvd: daemon RPC failed: daemon_timeout`。
该样本 final 到失败约 10.9 秒；同期 usage outbox 的 ACK 超时仍只记录重试。
旧版本没有在同步 RPC 超时错误中写操作名称，日志没有请求 ID/调用栈，
所以**历史样本实际 RPC 名称仍待验证**，不能仅凭间隔声称已被日志直接证实。

源码确定：`runAgent` 的最终 completion 路径在 `completeTurn` 之前调用
`consumeTaskSteerMessages(..., [], true)`；初始 offer 的已投递输入仍在 confirmed 集合，
因此这一步会同步调用 `turn.input`，默认等待 10,000ms。超时直接抛出，
最终回复尚未进入 completion outbox，错误被执行失败路径归类为 agent_error.unknown。
新增隔离测试通过真实 RPC 计时器触发该路径，修复后的日志明确包含
`daemon_timeout (turn.input, 10000ms)`，不把模拟测试当作线上复现。

## 六个 no_events 样本

逐个执行 `remi turn get <id> --output json`，并对照同一 daemon 日志：

| attempt | daemon 日志（UTC+8） | 结论 |
|---|---|---|
| tsk_yh4iobqef87m | 11:47:02 claimed；11:47:32 start id 66319 wait timeout | start ACK 等待 30s 后失败，未进 provider |
| tsk_de3meph4eek9 | 12:03:59 claimed；12:04:29 start id 67837 wait timeout | 同上 |
| tsk_n2svhnvjc4hf | 12:03:32 claimed；12:04:02 start id 67798 wait timeout | 同上，前面 workspace 亦超时 |
| tsk_7qx1rpabbcec | 11:28:21 claimed；11:28:51 start id 64648 wait timeout | 同上，传输先报 daemon_unreachable |
| tsk_zvedwt7gr029 | 12:06:19 claimed；12:07:39 Wiki working-copy lock timeout | 准备阶段失败，未进 provider |
| tsk_iu9y6pahofhf | 12:09:17 claimed；12:10:36 Wiki working-copy lock timeout | 同上 |

`startTask` 的等待发生在 provider/trace 初始化之前，因此这些 no_events 不表示 final 丢失。
Wiki 锁竞争与准备阶段诊断已另建 **MUL-104**（`iss_fgezcs2226i2`）。
按本次恢复任务要求，final 前超时维持原有失败分类；此 PR 不将其伪装成 completed。

## 实现与验证范围

最终回复与有序输入收据写入同一条 completion outbox 记录后，pump 才等待
`turn.input`，成功后发送 `turn.complete`。输入收据是本地字段，不进入完成帧。
传输超时保留该终态记录重试，不重跑 provider；重启时复用现有 pending-terminal
保护，先回放而不恢复为孤儿。输入 resync、input_unread 提醒/持久暂停与 fallback
仍由既有守卫处理。完成 ACK 丢失时，stale 收据交由完成报告的幂等守卫校验。

集成测试使用隔离 SQLite、真实 daemon/服务端协议与测试 provider；使用 manual protocol
clock 触发真实客户端 deadline。daemon restart 指 harness 销毁并重建 daemon 对象、
从同一 SQLite outbox 重新加载，不是 systemd/OS 进程崩溃演练。
没有执行真实 provider、生产过载注入、部署或生产修复验证。

## 实跑检查

Bun 1.3.14；依赖通过 `bun install --frozen-lockfile` 安装。

```bash
bun run test tests/unit/daemon/turn-protocol.test.ts tests/unit/daemon/task-report-outbox.test.ts tests/unit/daemon/daemon-protocol-client.test.ts tests/integration/daemon-protocol-v2/final-input-timeout.test.ts tests/integration/daemon-protocol-v2/terminal-replay.test.ts tests/integration/daemon-protocol-v2/chat-unread-consumption.test.ts tests/integration/daemon-protocol-v2/task-input-authority.test.ts tests/unit/multiremi/turn-input-complete.test.ts
```

结果：136 pass、0 fail、4290 assertions（其中新增集成文件当时为 3 例）。
新增文件补充 receipt ACK 丢失与 final 前失败负向用例后，独立实跑：

```bash
bun run test tests/integration/daemon-protocol-v2/final-input-timeout.test.ts
```

结果：5 pass、0 fail、53 assertions；每个 final 场景均检查一次 provider 执行、
一次 attempt、零 failTask、一次 offer、最终回复送达，且本地 receipt 不进入完成帧。
原有 outbox 非终态超时、unread 持久暂停与回放、完成 ACK 丢失等断言均保留。

`bunx tsc --noEmit` 通过；`npm run docs:test` 13 pass、0 fail；
`npm run docs:check` 通过；`git diff --check` 通过。仓库未提供独立后端 Lint 命令。
PR/最终 SHA 的远端检查以交付评论内 stable 同版本 CLI 查询结果为准。
