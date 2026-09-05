---
title: Remi 当前架构地图
status: active
summary: 从 CLI、Web 和飞书入口追踪到 API、存储与 Agent 执行，并定位配置和验证边界。
---

# 当前架构地图

本页描述当前工作树的实现位置。运行命令见[根 CLAUDE.md](../CLAUDE.md)，包成员和脚本以[根 package.json](../package.json)为准。
任务导航见[开发入口](dev/README.md)。本页与源码一起维护；接口字段和默认值回到其定义处读取。

## 入口与职责

| 入口或模块 | 当前职责 | 读代码从这里开始 |
|---|---|---|
| `apps/remi` | `remi` CLI、登录、服务生命周期和平台命令 | [main.ts](../apps/remi/main.ts)、[CommandRegistry](../apps/remi/cli/core/command-registry.ts) |
| `apps/server` | 平台 CLI 入口，复用服务端启动分发 | [main.ts](../apps/server/main.ts)、[multiremi.ts](../apps/remi/cli/multiremi.ts) |
| `frontend/apps/web` | Next.js Web 入口 | [应用目录](../frontend/apps/web)、[前端地图](dev/frontend.md) |
| `packages/server` | Hono API、wire 序列化、领域存储、平台 worker | [API 组合与服务启动](../packages/server/src/api/server.ts)、[Store](../packages/server/src/store/store.ts) |
| `packages/daemon` | 共享 AgentRuntime、工作目录/插件/MCP/提示词组装、lane 和定时调度 | [runtime.ts](../packages/daemon/src/agent-runtime/runtime.ts)、[orchestrator.ts](../packages/daemon/src/orchestrator.ts)、[scheduler.ts](../packages/daemon/src/scheduler.ts) |
| `packages/remi` | Remi core 库与会话辅助代码；当前 foreground 的飞书消息接线位于 `apps/remi/cli/multiremi.ts` | [core.ts](../packages/remi/src/core.ts)、[当前 foreground](../apps/remi/cli/multiremi.ts) |
| `packages/acp` | ACP 连接与 provider 会话 | [provider.ts](../packages/acp/src/provider.ts)、[client.ts](../packages/acp/src/client.ts)、[adapter registry](../packages/acp/src/adapters/index.ts) |
| `packages/connectors` | 平台消息接收与回复适配 | [base.ts](../packages/connectors/src/base.ts)、[feishu](../packages/connectors/src/feishu) |
| `packages/contracts` / `shared` / `auth` | 共享类型、配置/基础设施、认证 | [contracts](../packages/contracts/src)、[shared](../packages/shared/src)、[auth](../packages/auth/src) |

当前执行实现跨两个包：领取、上报、取消与恢复的主循环在
[server/worker/daemon.ts](../packages/server/src/worker/daemon.ts)，它调用 `packages/daemon` 的运行时构件。
排查任务执行时两个位置都要看；包名不等于全部生命周期的归属。

## 三条数据流

**Web / CLI 读写平台数据**：前端查询或 CommandRegistry → Hono [routers](../packages/server/src/api/routers) →
[Store facade](../packages/server/src/store/store.ts) / [领域 repos](../packages/server/src/store/repos) → 数据库。
对外形状集中到 [wire](../packages/server/src/api/wire)；事件经 [realtime](../packages/server/src/api/realtime.ts) 到前端缓存。

**任务执行**：issue/chat/autopilot 产生 task → [任务存储](../packages/server/src/store/repos/tasks-repo.ts) →
[daemon client](../packages/server/src/worker/client.ts) / [worker loop](../packages/server/src/worker/daemon.ts) 领取 →
[AgentRuntime](../packages/daemon/src/agent-runtime/runtime.ts) 组装执行上下文 → ACP provider → 消息、usage 和终态上报。
权限请求、会话延续、工作目录归属与重试都在这条链路中，不可只以模型输出判断完成。

Chat 可绑定同工作区的一个 Issue；新 Chat task 可继承该 `issueId`，但仍使用 Chat 工作目录，其完成不会自动改变 Issue 状态或发布 Issue 回复评论。绑定、改绑和待投递更新由 [ChatRepo](../packages/server/src/store/repos/chat-repo.ts)维护。[claim wire](../packages/server/src/api/wire/tasks.ts)为 Chat/Issue 会话生成有预算的 bootstrap/delta projection，并单独携带绑定 Issue 与增量摘要；[CLI context](../packages/server/src/api/routers/cli.ts)提供 caller 的 Chat/Issue 信息，不能从摘要推断完整历史。

**飞书聊天**：[controlPlaneConciergeHost / createFeishuTaskHandler](../apps/remi/cli/multiremi.ts)启动 connector；普通消息经 daemon client 提交平台 Chat/Task，再走上面的任务执行链。connector 从 task 事件流回复；去重、运行中 steering、取消与人工请求也使用平台 task。当前 foreground 不实例化 `packages/remi` 的 `Remi` core，不能以该库的 `_process()` 作为当前 bot 入口。
工作区的 [Feishu bot 配置](../packages/server/src/store/repos/feishu-bot-repo.ts)指定 Agent 和 Runtime；
bot 控制指令携带版本和期望状态。[concierge supervisor](../packages/server/src/worker/feishu-concierge.ts)经鉴权接口拉取 assignment 后串行协调 connector 的启动、停止与重试，应用凭据不随心跳下发。心跳还可领取持久化出站投递，由 connector 发送并回报；自动 Issue 话题及负责人轮次完成推送见[飞书接入契约](feishu-message-ingestion.md)。

## 存储与事务

当前 Store 使用同步 `SqlDatabase` 接口。[openMultiremiDatabase](../packages/server/src/store/db/postgres.ts)
根据 `MULTIREMI_DATABASE_URL` 选择 PostgreSQL，否则使用本地 SQLite。
这是底层存储适配的选择；生产 server 启动还有[必要配置检查](dev/auth.md)，不能据此省略部署配置。
PostgreSQL 的 `PgBridge.request` 用 `Atomics.wait` 等待 [pg-worker](../packages/server/src/store/db/pg-worker.ts)，worker 使用单连接。
这是真实实现约束，不应被“整体 async/await”概述掩盖。

该适配文件记录的动机是兼容已有同步 Store 调用；不能据此推断它仍适合当前并发负载。
改为异步时需同时处理调用链与事务连接归属，不能只调大连接数。
性能影响、现有基线脚本和待测项见[性能调查](dev/performance.md)。

## 配置与能力定位

- bot assignment 由工作区独立的 `multiremi_feishu_bot_configs` 记录关联 Agent/Runtime；实际任务通过 Agent 行组装执行参数。bot 凭据在控制面配置，daemon 环境仅承载连接和进程设置，见[配置说明](deploy/66-8-remi-environment.md)。
- 当前 adapter registry 包含 Claude、Codex。认证方式按各 CLI 和[安装说明](../README.md)配置，不能把所有后端概括为“不需要 API key”。
- [MCP 组装](../packages/daemon/src/agent-runtime/mcp/ephemeral.ts)当前接受 `command` 形式的 stdio 服务；远程 HTTP 配置不能仅因存进 agent 字段就视为已注入。
- 项目知识由[知识服务](../packages/server/src/project-knowledge/service.ts)和[知识路由](../packages/server/src/api/routers/knowledge.ts)提供；用户项目知识与本仓库开发文档分别维护。

## 验证与修改边界

| 修改范围 | 先检查的依据 |
|---|---|
| 包依赖与共享类型 | [package-boundaries.test.ts](../tests/arch/package-boundaries.test.ts)、[tsconfig.json](../tsconfig.json) |
| HTTP 能力与 CLI | [仓库规则](../AGENTS.md)、[路由快照脚本](../scripts/snapshot-api-routes.ts)、[CLI 能力检查](../scripts/check-cli-capabilities.ts) |
| 任务路由、重试与会话 | [tasks-repo.ts](../packages/server/src/store/repos/tasks-repo.ts) 与 [worker/daemon.ts](../packages/server/src/worker/daemon.ts) 的相关测试；发现方式见[测试指南](../TESTING.md) |
| Chat/Issue 绑定、上下文与飞书推送 | [claim wire 测试](../tests/unit/multiremi/multiremi-store-daemon-wire.test.ts)、[Issue 更新测试](../tests/unit/multiremi/multiremi-agent-issue-updates.test.ts)、[话题测试](../tests/unit/multiremi/multiremi-feishu-issue-topics.test.ts) |
| 前端缓存与渲染 | [前端规则](../frontend/AGENTS.md)、[前端地图](dev/frontend.md) |

链接和静态检查只提供定位依据。本页不宣称已经启动生产服务、通过全部测试或完成性能测量。
