---
title: Codex ACP 接入
status: active
summary: 说明任务到 Codex ACP 的当前执行链、配置来源、会话隔离与验证入口。
---

# Codex ACP 接入

当前执行链是服务端分配的 task/agent → [daemon worker](../../packages/server/src/worker/daemon.ts) → [AgentRuntime](../../packages/daemon/src/agent-runtime/runtime.ts) → [AcpProvider](../../packages/acp/src/provider.ts) → `codex-acp`，经 ACP stdio 通信。模型、执行参数和 MCP 来自任务携带的 Agent 配置及运行时装配；工作目录来自任务工作区解析。

## 配置与运行

- 在工作区 Agent 上设置 `provider: codex`，由符合路由条件的 Codex runtime 领取任务。[CLI Registry](../../apps/remi/cli/commands/agent-extensions.ts)提供 `remi agent create`、`remi agent update` 的 `--provider`、`--model` 和 `--thinking-level` 参数；先用对应命令的 `--help` 核对当前参数与身份要求。
- [daemon 启动入口](../../apps/remi/cli/multiremi.ts)调用 [ensureAcpBridges](../../packages/acp/src/provision.ts)，使用源码固定的 `@agentclientprotocol/codex-acp` 版本及 Remi usage 补丁。版本以 [runtime-versions.json](../../packages/acp/src/runtime-versions.json) 为准；它同时固定 bridge、配套 Codex SDK 和实际执行文件版本。发版准备与安装校验见[配套升级说明](../daemon-runtime-upgrades.md)。系统或 Homebrew 的 Codex 升级不会替换 Remi 托管依赖。
- ACP 执行文件按显式 `executable`、`REMI_CODEX_AGENT_ACP_EXECUTABLE`、Remi 管理目录与 PATH 解析，具体顺序见 `resolveAcpExecutableForAgent`。Windows 的扩展名解析也在该函数所在文件中。
- 当前 Codex 健康检查只确认执行文件可解析，不启动模型进程。检查通过不等于登录、网络、模型或真实任务已可用。

## 协议与隔离

[CodexAdapter](../../packages/acp/src/adapters/codex/index.ts)已经实现工具名、输入、结果预览及权限模式映射。[AcpProvider](../../packages/acp/src/provider.ts)根据 ACP 返回的能力协商 model/effort/mode；不能用未被桥接器读取的会话 `_meta` 代替协商。适配器对不支持的 `allowedTools` 和会话 `systemPrompt` 发出警告，不保证这些字段生效。

[Session Home](../../packages/daemon/src/agent-runtime/workspace/session-home.ts)负责会话目录与凭据路由，[Codex Home](../../packages/daemon/src/agent-runtime/agent-plugins/codex-home.ts)负责配置/插件物化及认证文件连接。[能力装配](../../packages/daemon/src/agent-runtime/capabilities/agent-plugins.ts)将隔离目录传为 `CODEX_HOME`；插件集合及执行指纹参与会话复用判定，不能让不同执行身份共用插件配置。

这类隔离针对配置、插件与原生会话记录，不意味着每个 Home 都拥有独立付费账号。原生 OAuth 可以连接基础 Home 的认证文件，Relay 凭据使用另一条注入路径；更改认证或切换 Relay 时需要同时检查目录与凭据状态。

## 能力组自定义连接

能力组的「能力组连接」支持一个自定义 Responses provider：连接名称、API 基础地址、默认模型与可选模型 ID 列表，以及 API Key 或成员 Runtime 本机 `REMI_CODEX_*` 环境变量。组内成员共享连接配置；执行任务的 daemon 需声明 `codex_profiles: 1`。未启用时沿用工作区 Relay / 原生登录路径；启用后优先于工作区 Relay。接口地址由 Runtime 连接，允许 HTTP(S) 的 loopback / LAN 地址；服务端不会对它做模型发现请求，也不放宽工作区 Relay 的 URL 校验。

- [配置契约](../../packages/contracts/src/codex-profile.ts)只接受结构化路由字段，不接受任意 TOML、命令、URL 内联凭据或查询参数。每组配置一个连接；`model` 是默认模型，`models` 是包含默认模型的去重列表，省略时兼容旧单模型配置。云友可选列表中的模型或留空使用默认值。自动模式按所选模型筛选可执行 Runtime，claim 时将该模型冻结进连接快照。
- [注入器](../../packages/daemon/src/agent-runtime/codex-profile.ts)将配置展开为隔离 `CODEX_HOME/config.toml` 的 `model`、`model_provider` 和 `model_providers.remi_custom`；密钥只进入进程环境 `OPENAI_API_KEY`，不写入 config/auth 文件。本机基础 Home 不变。ACP 的 `MODEL_PROVIDER`、`CODEX_CONFIG`、`DEFAULT_AUTH_REQUEST` 环境覆盖也会被明确设置，避免旧机器配置改变路由。
- 这里的 Profile 是 Remi 的命名连接，不是直接复制本机 `--profile` 配置。Remi 展开有效配置，不依赖本机 profile 文件的布局。
- [任务快照](../../packages/server/src/store/repos/tasks-repo.ts)在 claim 时冻结连接和凭据版本，并把连接纳入执行指纹。修改配置只影响新任务；运行中任务使用原快照，自动重试在原 Runtime 仍兼容当前 Agent 时保留快照。连接变化后从产品会话记录重新启动原生会话，不把旧 provider 会话 ID 传给新接口。若 Agent 切换 provider 或原 Runtime 不再兼容，重试清除旧快照，由兼容 Runtime 重新领取。
- 模型目录显示配置的模型，属于配置声明，不代表连通性验证，也不虚构 thinking 能力。未在 Codex 内置目录中的模型可由启动配置使用；Codex 可能提示缺少模型元数据，兼容性取决于实际 Responses 服务。
- 可选的 LLM 进度摘要使用 Chat Completions 协议，因此不自动复用自定义 Responses 连接的密钥；需单独配置 `MULTIREMI_PROGRESS_SUMMARY_OPENAI_BASE_URL` 与 `MULTIREMI_PROGRESS_SUMMARY_OPENAI_API_KEY` 才启用该摘要。任务状态与执行消息照常上报。

直接填写的 API Key 使用 [AES-256-GCM 存储](../../packages/server/src/runtime-provider-credentials.ts)，新凭据的认证数据绑定工作区、能力组和不可变凭据版本。服务端需配置 `MULTIREMI_PROVIDER_ENCRYPTION_KEY`（base64 编码的 32 字节密钥），也可使用部署的 `MULTIREMI_TOKEN` 派生密钥；没有加密密钥时保存失败，不回退明文。轮换时用逗号分隔的 `MULTIREMI_PROVIDER_ENCRYPTION_PREVIOUS_KEYS` 保留旧密钥；更换 master token 前需保留旧派生密钥或迁移数据。组配置和历史凭据独立于 Runtime 生命周期，删除或移动单个成员不会删除共享连接；删除工作区时统一清理。历史任务通过不可变引用继续读取冻结凭据。

浏览器 GET/PUT `/api/execution-groups/:id/provider-profile?workspace_id=...` 只返回配置与不透明凭据引用；PUT 仅 human 工作区 owner/admin 可用，task token 不可读写。向已配置连接的组加入 Runtime 也要求 human admin。`api_key` 省略保留密钥，`profile: null` 恢复继承。密钥仍经 daemon 专用 `/api/daemon/runtimes/:id/codex-profile-key` 下发，需绑定该机器身份，且该 Runtime 属于凭据的组或持有正在执行的对应任务快照。环境变量模式不存储密钥，需在每个成员机器上配置相应变量。

迁移在单个事务中把旧 Runtime 配置移动到能力组。同组配置一致时共享；存在不同配置（含未配置成员）时按旧配置分组，未配置连接的分组优先保留原组 ID，否则第一个 Runtime 所在分组保留原组 ID，其他分组获得稳定的 `migrated_...` ID。固定 Runtime 的云友跟随迁移，原组云友保留原组，调度范围可能缩小。密文复制时保存原加密上下文，不要求启动时解密；新写入使用组身份。旧 Runtime GET/PUT 和 CLI 命令保留兼容入口，实际读写该 Runtime 当前所属组，写入同样要求 human admin。旧 daemon 的心跳及任务快照仍接收单模型格式。
CLI 对应命令：

```bash
remi runtime group profile get <group>
remi runtime group profile set <group> --file profile.json
```

`profile.json` 示例（文件内不要提交真实密钥到 Git；可省略 `api_key` 保留已保存的密钥）：

```json
{"profile":{"name":"private","base_url":"https://example.com/v1","model":"custom-model","models":["custom-model","other-model"],"auth_mode":"api_key","env_key":""},"api_key":"REPLACE_WITH_API_KEY"}
```

环境变量模式使用 `"auth_mode":"env","env_key":"REMI_CODEX_API_KEY"`，不传 `api_key`。恢复继承使用 `{"profile":null}`。

## 验证入口

| 范围 | 入口 |
|---|---|
| 执行文件、健康检查与显示适配 | [providers.test.ts](../../tests/unit/acp/providers.test.ts) |
| 桥接器版本与 provision | [provision.test.ts](../../tests/unit/acp/provision.test.ts) |
| npm 发布包、配套 Codex、usage 补丁和真实 ACP 协商 | [verify-codex-bridge.ts](../../tests/integration/verify-codex-bridge.ts) |
| 模型/effort/权限协商与隔离 Home | [acp-session-negotiation.test.ts](../../tests/unit/acp/acp-session-negotiation.test.ts)、[session-home.test.ts](../../tests/unit/daemon/session-home.test.ts) |
| 真实 API → daemon → ACP 任务 | [smoke-multiremi-acp.ts](../../tests/integration/smoke-multiremi-acp.ts) |
| 自定义连接、密钥权限/加密与会话快照 | [runtime-codex-profile.test.ts](../../tests/unit/multiremi/runtime-codex-profile.test.ts)、[codex-profile.test.ts](../../tests/unit/daemon/codex-profile.test.ts) |
| API → daemon 的配置与密钥注入（provider fixture） | [runtime-codex-profile.test.ts](../../tests/integration/runtime-codex-profile.test.ts) |
| 能力组表单与凭据保留 | [execution-group-codex-profile.test.tsx](../../frontend/packages/views/runtimes/components/execution-group-codex-profile.test.tsx) |

在根目录执行：

```bash
bun test tests/unit/acp/providers.test.ts tests/unit/acp/provision.test.ts tests/unit/acp/acp-session-negotiation.test.ts
bun run tests/integration/smoke-multiremi-acp.ts --provider=codex --check-only
```

移除 `--check-only` 会运行真实任务并调用模型，需要当前机器上有效的认证与模型访问。保留实际输出中的 `available`、`unavailable`、`passed`、`failed` 差别；这里列的是验证入口，不是本次执行结果。

发版准备会在隔离目录安装并验证快照组合。需要进一步验证真实会话时，可将该固定 bundle 中的 bridge 目录传给检查器：

```bash
bun run tests/integration/verify-codex-bridge.ts --package-dir=<bundle>/node_modules/@agentclientprotocol/codex-acp
```

检查器核对发布包的依赖声明和实际 CLI 版本，应用 usage 补丁并执行发布包中的 token 转换，随后验证 ACP 初始化、会话创建、model/effort/权限协商和关闭。它从当前 `CODEX_HOME`（默认 `~/.codex`）复制 `auth.json` 到临时 Home，真实会话需要有效登录；不复制本机配置。加 `--prompt` 会调用模型并校验回复及实际 usage 事件。不加该参数时不会发送 prompt，也不能视为真实模型调用通过。

检查器应核对发行快照中的配套 Codex 基线；usage 补丁仍用于逐请求累加，不能用只包含最后一次模型请求的 prompt 结算替代。协议回归夹具使用 Node shebang，Windows 可在 WSL 中运行 `acp-session-negotiation.test.ts`；发布包检查器直接通过 Node 启动 bridge，可在原生 Windows 运行。
