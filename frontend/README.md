# Remi 前端

这里是 Remi / Multiremi 的 Web 控制台：查看任务与执行过程，在工作台处理待验收或待输入任务，管理项目、Agent、设备与自动化。

当前应用入口是 `apps/web/`（Next.js App Router）。业务逻辑、页面和基础组件分别放在 `packages/core/`、`packages/views/`、`packages/ui/`。后端位于仓库根的 `packages/server/`，由 Bun + Hono 提供 API；本目录不单独维护服务端或客户端发布流程。

开始开发前阅读：

- [仓库开发入口](../CLAUDE.md)：环境、命令与全局导航。
- [前端开发上下文](../docs/dev/frontend.md)：目录职责、启动接线、数据流和源码定位。
- [前端 Agent 规则](AGENTS.md)：状态、包边界和测试要求。

依赖由[根 Bun workspace](../package.json)统一管理，在仓库根安装。各包命令以其 `package.json` 为准；前端目录内的旧包管理元数据不构成另一套安装流程。

## 更新连续性

Web 自己提供 `GET /health/build`（不走 `/api`），返回 `{ "build_id": "<string>" }`，响应为 `Cache-Control: no-store`。`health` 已在工作区保留 slug 集合中。构建时优先使用 `REMI_WEB_BUILD_ID`，否则生成一次 UUID；同一值用于 Next buildId、服务端路由和浏览器 bundle。启动同一 standalone 产物的多个实例不会重新生成身份。MUL-32 可用此端点确认 Web 构建，不能将它当 API 版本。

全局横幅读取 platform status，并由 `daemon:maintenance_changed` 使查询失效；收到 `platform_update_in_progress` 立即显示切换。active operation 的 switching/restarting/verifying/rolling_back 属于切换阶段，maintenance 表仍可能标为 draining。构建检测在启动、窗口重新聚焦、每 15 秒和共享导航前执行；空闲时下一次导航整页切换，存在未确认发送、队列 outbox、草稿或进行中的写入时只提示。chunk 加载异常按 tab/源构建最多自动恢复一次。

自动重放写请求严格限定为带身份的 Chat message（`session_id + dedupe_key`）和 queue enqueue（`session_id + client_id`）；服务端分别在 `send-message.ts` 与 `queued-messages.ts` 去重。重放复用原始正文与身份，覆盖网络错误和 502/503/504。Next rewrite 对连接拒绝返回裸 500 文本 `Internal Server Error`，仅此精确网关响应也视为网络不可达；应用 JSON 500 不重放。其他写操作保持原失败路径，不因加请求头就被视为幂等。读取遇到 503 + Retry-After 也会等待。重试尊重 Retry-After 的秒数或 HTTP 日期，否则使用抖动退避；等待上限为 `MAINTENANCE_RETRY_LIMIT_MS`（10 分钟），等待不占 Chat 的 20 秒有效请求预算，AbortSignal 可取消等待。到达上限仍沿用未确认送达/保留输入与人工重试路径。

隔离浏览器验收（需 Bun 1.3.14、Node 22.6+、Chromium）：

```bash
node node_modules/playwright-core/cli.js install chromium
bun --tsconfig-override tsconfig.json frontend/smoke/update-continuity.ts
```

该命令创建临时 SQLite 和独立 API 子进程，构建两个 standalone Web，验证 25 秒维护闸门、API 实际停机再启动及 A → B 首次导航。恢复后直接查询 `multiremi_conversation_log`，每条测试 Chat 只能有一行。默认端口 14341/14342，可用 `UPDATE_SMOKE_API_PORT` / `UPDATE_SMOKE_WEB_PORT` 修改；不使用 6131–6134，不管理生产 daemon 或 stable profile。输出临时目录内的 result.json 是该次执行证据，脚本存在不代表验收通过。
