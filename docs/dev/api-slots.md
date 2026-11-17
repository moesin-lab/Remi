---
title: API slot 生命周期
status: active
summary: 同库 standby/active 切换、回环控制接口、请求排空与后台任务停止。
---

# API slot 生命周期

Phase A 用于同一 PostgreSQL 数据库上的两个 `all` API（不配置 peer）。生命周期实现见
[slot-lifecycle.ts](../../packages/server/src/api/slot-lifecycle.ts)，监听和后台任务接线见
[server.ts](../../packages/server/src/api/server.ts)，生产启动与信号处理见
[multiremi.ts](../../apps/remi/cli/multiremi.ts)。不设 slot 变量时保留启动前获取角色锁及原有探针响应；SIGTERM 等待 HTTP 排空和异步停止。

## 启动配置

| 变量 | 含义 |
|---|---|
| `MULTIREMI_SLOT` | slot 标识；启用 slot 时必填 |
| `MULTIREMI_SLOT_START` | `standby` 或 `active`，默认 `active` |
| `MULTIREMI_SLOT_CONTROL_TOKEN` | 独立控制凭据；启用 slot 时必填 |
| `MULTIREMI_SLOT_LOCK_TIMEOUT_MS` | 整个激活的共同 deadline（PG 建连、SQL、重试、fence 和启动），默认 10000 ms |
| `MULTIREMI_SLOT_DRAIN_TIMEOUT_MS` | 普通 HTTP 排空预算，默认 20000 ms |
| `MULTIREMI_SLOT_STOP_TIMEOUT_MS` | 后台停止等待预算，默认 5000 ms |

两个 slot 使用不同端口、同一数据库。standby 执行启动迁移并监听，但不获取角色锁、不开启后台任务，业务 HTTP 和 WebSocket 升级返回 503。`/healthz` 保留存活语义；`/readyz` 在非 active 状态返回 503 和 `{slot,state,version}`。active 时还检查数据库，成功返回 200 和 `{slot,state,version,term}`。

## 控制接口

控制接口与 API 共用监听端口，只接受实际 socket 来源为 IPv4/IPv6 回环的请求，不信任转发头。
请求必须带 `Authorization: Bearer <MULTIREMI_SLOT_CONTROL_TOKEN>`。公网 edge 必须屏蔽 `/internal/*`；不要把该路径通过本机反向代理暴露给外部用户。

| 方法与路径 | 行为 |
|---|---|
| `GET /internal/slot/status` | 当前状态；不依赖数据库或用户鉴权 |
| `POST /internal/slot/activate` | 依次获取角色锁、调用 fence、启动后台任务，完成后 active |
| `POST /internal/slot/release` | draining → 排空 HTTP → 关闭 WS → await 停止任务 → 解锁 → released |
| `POST /internal/slot/exit` | 响应后执行关停；排空失败时终止进程，以进程死亡隔离旧写入 |

激活锁竞争或 fence 失败返回 503，状态 failed，监听保留，可重试或 release。转换串行执行；重复 activate/release 幂等。released 可重新 activate。激活 deadline 到期时返回 503、状态 failed，不退出进程；尚未启动任务时，锁连接被取消并丢弃，迟到的 fence 不会启动任务。异步启动已开始时则保锁，待启动和停止均结束后回收；期间 release 返回 503。fence 接收 AbortSignal，钩子须尊重取消，避免迟到的外部副作用。停止任务失败时保留角色锁及 draining/failed 状态，须先成功 release，避免后台工作尚未结束就交接所有权。

release 首先停止接收业务请求；普通 HTTP 通过 Bun `pendingRequests` 原生计数到响应结束或取消（排除控制请求和 SSE），不代理普通响应 body，SSE 和 WebSocket 不计入排空预算。预算到期且普通 HTTP 未归零时，release 返回 503 `{error:"drain_timeout",in_flight:N,state:"draining",...}`，保持持锁、后台任务和 daemon 在线，不执行交接。此状态只有两条出路：activate 回滚（复用原锁、term 和任务，恢复服务），或 exit/SIGTERM 退出进程。即使旧请求随后完成，重复 release 仍返回 503，必须由 A4 supervisor 选择回滚或退出。只有进程死亡才能作为旧 HTTP 写入的 fence；不能在存活旧请求时解锁后激活 B，也不能把 HTTP 隔离交给 A3 后台 term fence。daemon 在排空期间保持连接，使在途 RPC 能完成；随后结束 SSE，daemon 收到 4001，浏览器（包括 trace）收到 1012。daemon 的现有重连、active task 恢复与 outbox 协议不变。

后台停止等待超时会返回 503，保留角色锁和 draining/failed 状态，禁止重新 activate；底层网络操作仍可能运行，并未被超时取消。操作结束后可重试 release，再 activate。所有 API 关停（含未设 slot 的普通 SIGTERM）共享 **25000 ms 总预算**：从首次信号/exit 开始，覆盖 HTTP 排空、后台停止、WebSocket、read pool/Hub、角色锁及数据库收尾，不为后续步骤重置。后台停止另有默认 5000 ms 的局部预算，所有任务并发 await；它不是总预算。任何关停步骤失败或总 deadline 到期，CLI 直接终止进程，不先释放锁或关闭 DB 让旧 HTTP 继续写。成功排空时仍优雅退出；HTTP 排空超时的 exit 以退出码 1 结束，由 supervisor 按进程死亡确认接管。Docker 所有 API compose 层（含 internal-updates）为 `stop_grace_period: 30s`，supervisor 的 SIGKILL 宽限同为 30 秒，均大于固定 25 秒总预算。调高排空/停止预算不能延长总预算。第二次 SIGINT/SIGTERM 会强制退出。

WebSocket 关闭握手最多等待 1 秒，未确认的连接随后断开，避免残留连接阻塞进程退出；这不影响普通 HTTP 的排空。

Bun 1.3.14 在服务端关闭 WebSocket 后可能保留 `pendingWebSockets` 计数，使原生 `stop(false)` 的 Promise 不结束。监听已停止且所有跟踪的 WebSocket 已关闭时，最终停机改为等待实际 HTTP 响应与 `pendingRequests` 清零；总预算内仍等待 HTTP，超过预算由 CLI 终止整个进程。回归测试同时验证停机后原端口可重新绑定。

`slotFence` 是 A3 注入 live term 的异步钩子；A2 默认 `term:null`，没有实现持久化 term 或后台写入 fencing。supervisor 的顺序、路由切换及回滚由 A4 负责：release A 后 activate B；若 B 失败，可重新 activate A。

## 验证入口

[真实进程 deadline 回归](../../tests/integration/slot-deadlines.test.ts)覆盖慢 PATCH + SQLite 写入 + PG 角色锁、排空失败回滚与退出、TCP/SQL 黑洞、迟到 fence 锁回收、slot/legacy SIGTERM 总预算，以及全部 compose 层与 supervisor 宽限。

[生命周期单测](../../tests/unit/multiremi/slot-lifecycle.test.ts)检查转换顺序、异步停止、失败回收、鉴权、原生 HTTP body 排空、SSE 豁免、后台停止超时保锁，以及子进程中的 pipelined HTTP/socket reset 压力回归。
[双进程测试](../../tests/integration/slot-lifecycle.test.ts)启动真实 CLI API 和 TCP 测试代理，用注入的惰性 provider 验证 daemon 运行中切换、离线终态 outbox 重放、浏览器关闭码和进程退出。SQLite 总是执行；配置 `MULTIREMI_TEST_POSTGRES_URL` 后额外执行 PostgreSQL，并检查角色锁竞争失败与回滚。测试数据库由既有隔离夹具创建、删除，不使用业务数据库；未配置 PG 时明确跳过其验收。

```bash
bun run test tests/unit/multiremi/slot-lifecycle.test.ts tests/integration/slot-lifecycle.test.ts
```
