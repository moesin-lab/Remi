---
title: Claude Code ACP 接入
status: active
summary: 说明 Claude Code 的 Runtime 自定义 Messages 连接、鉴权注入、配置优先级及会话隔离。
---

# Claude Code ACP 接入

Claude Code 由 [daemon worker](../../packages/server/src/worker/daemon.ts) 组装任务，经 [AcpProvider](../../packages/acp/src/provider.ts)、[ClaudeAdapter](../../packages/acp/src/adapters/claude-code/index.ts) 和仓库固定的 `@agentclientprotocol/claude-agent-acp` 启动。桥接器、SDK 和实际执行文件版本以 [runtime-versions.json](../../packages/acp/src/runtime-versions.json) 为准，准备与安装步骤见[配套升级说明](../daemon-runtime-upgrades.md)。

Windows 通过 Node 启动随仓库提供的无扩展名 `remi-claude-agent-acp` 脚本，健康检查与实际 ACP 会话共用[启动解析](../../packages/acp/src/launch.ts)；机器需安装 Node 并将其加入 PATH。

## Runtime 自定义连接

统一配置入口的 Claude Profile 支持一个 Anthropic Messages 兼容接口和一个默认模型，再由能力组绑定到多个 Runtime。填写连接名称、API 基础地址、模型 ID，以及 API Key 或本机 `REMI_CLAUDE_*` 环境变量名；请求鉴权可选 Bearer Token 或 `x-api-key`。地址填写服务基础路径，Claude Code 在其后请求 `/v1/messages`，例如网关是 `https://gateway.example/anthropic`，不要填写完整 messages 路径。允许 Runtime 可访问的 HTTP(S) 本机或局域网地址，服务端不主动请求该地址。

请求头对应 Claude Code 的 `ANTHROPIC_AUTH_TOKEN`（Bearer）或 `ANTHROPIC_API_KEY`（x-api-key），每次仅注入选中的一种。具体协议见 [Claude Code 官方网关接入说明](https://code.claude.com/docs/en/llm-gateway-connect)。这不是 OpenAI Chat Completions/Responses 协议转换器。

中央配置要求 daemon 支持 Profile 下发并确认组的当前版本。组内任务优先使用其 Profile，组未指定 Profile 时使用工作区 Relay / 本机登录。配置流程、权限与旧数据迁移见[执行配置](../dev/execution-configuration.md)。留空时使用连接默认模型；旧 Runtime 连接的发现目录支持选择其他模型。中央 Profile 尚无独立目录探测缓存：组目录默认只确定配置模型，仅在同一 Runtime 的旧连接与中央配置可证明等价时复用目录和 thinking 证据（环境变量连接校验路由与鉴权字段，API Key 连接还要求迁移来源证明）。不同连接的探测状态和能力不混用，多机器组取成员有效能力交集。

旧 Runtime 连接的[模型发现](../../packages/server/src/worker/runtime-profile-models.ts)由 daemon 使用所选鉴权头请求 `/v1/models`，基础地址已以 `/v1` 结尾时不重复追加；按 [Claude Models API](https://platform.claude.com/docs/en/api/models/list) 的 `has_more` / `last_id` 翻页。完整目录保留配置默认模型，探测失败保留上次目录；首次失败仍可使用配置模型。thinking 能力仅按准确模型 ID 合并 ACP 实测结果，目录可读取也不代表模型推理成功。供应商目录不可用但 ACP 探测成功时，保留已有目录（首次使用配置默认模型）并更新已知模型的能力，日志明确记录目录探测失败；不会把 ACP 的官方模型列表当作 custom 供应商目录。平台和 daemon 需同时更新：模型上报携带 `model_profile`，过期或旧 daemon 的无标识上报不能覆盖 custom 目录。

启动时读取配置的首次心跳与后续心跳使用相同的完整响应处理器，确保一并领取的更新、模型刷新等维护请求得到处理。

## 凭据与执行隔离

- [配置契约](../../packages/contracts/src/claude-profile.ts)复用 [公共连接校验](../../packages/contracts/src/runtime-connection.ts)，只接受结构化字段，不接受任意 JSON 设置、命令或内联 URL 凭据。
- API Key 使用现有 [AES-256-GCM 凭据存储](../../packages/server/src/runtime-provider-credentials.ts)，只向绑定 Runtime 机器的 daemon token 下发。服务端需要 `MULTIREMI_PROVIDER_ENCRYPTION_KEY`（base64 编码的 32 字节密钥），或使用部署的 `MULTIREMI_TOKEN` 派生；轮换、旧凭据保留和加密作用域见 [连接凭据契约](acp-codex-via-codex-acp.md#runtime-自定义连接)。GET/PUT 响应不回显密钥，省略 `api_key` 保留已保存的密钥。
- [Claude 注入器](../../packages/daemon/src/agent-runtime/claude-profile.ts)将模型、基础地址和模型别名写入隔离的 `CLAUDE_CONFIG_DIR/settings.json`，密钥仅存在子进程环境。清空另一种鉴权、旧 OAuth token 和额外鉴权头，并关闭继承的 Bedrock/Vertex/Foundry 路由开关。模型别名及子 Agent 模型统一指向配置模型，避免辅助请求跑到其他模型。
- 非秘密路由通过桥接器支持的 `claudeCode.options.settings` 再传入 SDK，覆盖项目/local 设置中的冲突地址、模型和云路由，其余项目设置继续加载。凭据不放入该元数据，也不写入基础 Home 或隔离配置文件。
- Claude Code 会用项目设置中的凭据覆盖进程环境。启用 Runtime 连接时，执行前检查工作目录及父目录的 `.claude/settings.json` / `settings.local.json`；若包含鉴权环境变量、`CLAUDE_CONFIG_DIR` 或 `apiKeyHelper`，任务明确报错并要求将凭据移至连接 Profile，不修改项目文件，也不把密钥写入 SDK settings/命令行来覆盖它们。
- 任务 claim 时冻结配置、所选模型和凭据版本，并纳入执行指纹。Claude 自定义连接按执行指纹隔离 Home；连接和模型未变时延续原生会话，变更后从产品记录重新启动。运行中任务使用冻结连接和模型；自动重试在原 Runtime 仍兼容当前 Agent 时保留快照和 Runtime 归属，否则清除旧快照并重新调度。旧 daemon 不可领取带 Claude profile 的任务。
- 可选的 Chat Completions 进度摘要不复用此连接密钥；需要单独配置 `MULTIREMI_PROGRESS_SUMMARY_OPENAI_BASE_URL` 与 `MULTIREMI_PROGRESS_SUMMARY_OPENAI_API_KEY`。正常任务消息不受影响。

## API 与 CLI

新连接使用 `remi runtime profile create|update`，请求中指定 `provider: "claude"`；通过 `remi runtime group create|update` 选择连接和 Runtime。中央配置、完整 JSON 示例及鉴权边界见[执行配置](../dev/execution-configuration.md)。

旧 `GET/PUT /api/runtimes/:id/claude-profile` 和 `remi runtime claude-profile get|set` 保留用于单 Runtime 连接兼容，沿用 Runtime 可见性和 owner/admin 编辑权限，task token 对该配置路径为 hard deny。它们不会修改受管组的中央 Profile。旧连接使用 `{"profile":null}` 恢复继承；环境变量模式使用 `auth_mode: "env"`、`env_key: "REMI_CLAUDE_API_KEY"` 并省略 `api_key`。更新本机变量后需重启 Runtime。

Runtime 级模型目录可通过以下命令刷新和检查；能力组的可选目录使用 `remi runtime model catalog --execution-group <group-id>` 查询：

```bash
remi runtime model refresh <runtime> --json
remi runtime model status <runtime> <request-id> --json
remi runtime model list <runtime> --json
```

## 验证入口

- [配置、权限、加密版本和任务亲和性](../../tests/unit/multiremi/runtime-claude-profile.test.ts)
- [注入、旧配置覆盖和密钥不落盘](../../tests/unit/daemon/claude-profile.test.ts)
- [真实 API → daemon，两种鉴权及隔离 Home](../../tests/integration/runtime-claude-profile.test.ts)
- [自定义目录发现、缓存及所选模型执行（provider fixture）](../../tests/integration/runtime-profile-model-discovery.test.ts)
- [Claude 页面及鉴权选择](../../frontend/packages/views/runtimes/components/runtime-claude-profile-tab.test.tsx)
- [CLI 文件输入与恢复继承](../../tests/unit/remi/cli-operations.test.ts)

这些文件是验证入口，不代表所有外部服务兼容。真实模型服务还需满足 Claude Code 的工具调用、流式事件和模型能力要求。
