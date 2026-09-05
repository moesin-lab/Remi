---
title: Codex ACP 接入
status: active
summary: 说明任务到 Codex ACP 的当前执行链、配置来源、会话隔离与验证入口。
---

# Codex ACP 接入

当前执行链是服务端分配的 task/agent → [daemon worker](../../packages/server/src/worker/daemon.ts) → [AgentRuntime](../../packages/daemon/src/agent-runtime/runtime.ts) → [AcpProvider](../../packages/acp/src/provider.ts) → `codex-acp`，经 ACP stdio 通信。模型、执行参数和 MCP 来自任务携带的 Agent 配置及运行时装配；工作目录来自任务工作区解析。

## 配置与运行

- 在工作区 Agent 上设置 `provider: codex`，由符合路由条件的 Codex runtime 领取任务。[CLI Registry](../../apps/remi/cli/commands/agent-extensions.ts)提供 `remi agent create`、`remi agent update` 的 `--provider`、`--model` 和 `--thinking-level` 参数；先用对应命令的 `--help` 核对当前参数与身份要求。
- [daemon 启动入口](../../apps/remi/cli/multiremi.ts)调用 [ensureAcpBridges](../../packages/acp/src/provision.ts)，使用源码固定的 `@agentclientprotocol/codex-acp` 版本及 Remi usage 补丁。版本以 `BRIDGE_PIN` 为准，不从一次外部包查询结果推导。
- ACP 执行文件按显式 `executable`、`REMI_CODEX_AGENT_ACP_EXECUTABLE`、Remi 管理目录与 PATH 解析，具体顺序见 `resolveAcpExecutableForAgent`。Windows 的扩展名解析也在该函数所在文件中。
- 当前 Codex 健康检查只确认执行文件可解析，不启动模型进程。检查通过不等于登录、网络、模型或真实任务已可用。

## 协议与隔离

[CodexAdapter](../../packages/acp/src/adapters/codex/index.ts)已经实现工具名、输入、结果预览及权限模式映射。[AcpProvider](../../packages/acp/src/provider.ts)根据 ACP 返回的能力协商 model/effort/mode；不能用未被桥接器读取的会话 `_meta` 代替协商。适配器对不支持的 `allowedTools` 和会话 `systemPrompt` 发出警告，不保证这些字段生效。

[Session Home](../../packages/daemon/src/agent-runtime/workspace/session-home.ts)负责会话目录与凭据路由，[Codex Home](../../packages/daemon/src/agent-runtime/agent-plugins/codex-home.ts)负责配置/插件物化及认证文件连接。[能力装配](../../packages/daemon/src/agent-runtime/capabilities/agent-plugins.ts)将隔离目录传为 `CODEX_HOME`；插件集合及执行指纹参与会话复用判定，不能让不同执行身份共用插件配置。

这类隔离针对配置、插件与原生会话记录，不意味着每个 Home 都拥有独立付费账号。原生 OAuth 可以连接基础 Home 的认证文件，Relay 凭据使用另一条注入路径；更改认证或切换 Relay 时需要同时检查目录与凭据状态。

## 验证入口

| 范围 | 入口 |
|---|---|
| 执行文件、健康检查与显示适配 | [providers.test.ts](../../tests/unit/acp/providers.test.ts) |
| 桥接器版本与 provision | [provision.test.ts](../../tests/unit/acp/provision.test.ts) |
| 模型/effort/权限协商与隔离 Home | [acp-session-negotiation.test.ts](../../tests/unit/acp/acp-session-negotiation.test.ts)、[session-home.test.ts](../../tests/unit/daemon/session-home.test.ts) |
| 真实 API → daemon → ACP 任务 | [smoke-multiremi-acp.ts](../../tests/integration/smoke-multiremi-acp.ts) |

在根目录执行：

```bash
bun test tests/unit/acp/providers.test.ts tests/unit/acp/provision.test.ts tests/unit/acp/acp-session-negotiation.test.ts
bun run tests/integration/smoke-multiremi-acp.ts --provider=codex --check-only
```

移除 `--check-only` 会运行真实任务并调用模型，需要当前机器上有效的认证与模型访问。保留实际输出中的 `available`、`unavailable`、`passed`、`failed` 差别；这里列的是验证入口，不是本次执行结果。
