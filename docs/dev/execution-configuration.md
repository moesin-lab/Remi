---
title: 执行能力组与网关端点
status: active
summary: 端点保存地址、协议和认证；执行能力组选择引擎、机器、连接和模型策略。
---

# 执行能力组与网关端点

侧栏「执行能力组」（`/{workspaceSlug}/execution-groups`）统一管理执行组和网关端点。端点不属于某个模型或执行引擎：它保存地址、支持的 API 协议、协议路径和认证。执行组选择执行引擎、Runtime 成员、一个端点或本机登录，以及可选的默认模型和模型白名单。Agent 选择执行组，再选择该组实际可用的模型。

同一端点可以同时支持 `openai-responses`、`anthropic-messages`、`google-generative`，分别供 Codex、Claude、Antigravity 执行组使用。`openai-chat-completions` 供直接调用 Chat Completions 的系统功能使用，与 Codex 的 Responses 协议分开声明。声明支持协议不代表 Remi 转换协议；网关必须真实实现相应接口。Antigravity 支持 Google 协议端点或本机 `agy acp` 登录，两条认证链路互不回退。Grok 保留原生连接。

## 端点与执行组

[端点契约](../../packages/contracts/src/execution-endpoint.ts)与[API](../../packages/server/src/api/routers/execution-config.ts)定义：

- `/api/execution-endpoints` 和 `/:id`：列表、读取、创建、更新、删除端点。
- `/api/execution-groups` 和 `/:id`：执行组管理；`endpoint_id: null` 明确选择本机登录，不继承工作区 Relay。
- 端点可保存模型清单和手动补充条目；执行默认值与白名单 `model_policy.model` / `model_policy.models` 仍属于组。同一端点的两个组可以选择不同模型。
- 更新端点产生不可变 revision，所有引用组等待成员确认新版本。共享端点的编辑影响所有引用组；仍被组或系统 AI 引用时不能删除，也不能移除消费者需要的协议。
- `protocol_paths` 为相对 `base_url` 的路径。Codex 未显式设置路径且基地址没有版本后缀时，默认加 `/v1`；Claude 使用基地址并请求 `/v1/messages`；Antigravity 使用基地址并请求 `/v1beta/...`。迁移保留原连接的完整基地址，不重复添加版本路径。

```bash
remi runtime endpoint list --json
remi runtime endpoint create --file endpoint.json --json
remi runtime endpoint update <endpoint-id> --file endpoint.json --json
remi runtime endpoint delete <endpoint-id> --json
```

`endpoint.json` 示例（真实密钥不要提交到 Git）：

```json
{
  "name": "团队网关",
  "connection": {
    "base_url": "https://gateway.example",
    "protocols": ["openai-responses", "anthropic-messages"],
    "protocol_paths": {"openai-responses": "/v1", "anthropic-messages": ""},
    "auth_mode": "api_key",
    "env_key": "",
    "auth_header": "bearer"
  },
  "api_key": "REPLACE_WITH_API_KEY"
}
```

认证头 `auth_header` 用于 Anthropic 接口，可选 `bearer` / `x-api-key`。Google 接口使用 Google API key 头并兼容网关 Bearer。`auth_mode: env` 使用 daemon 进程内的 `REMI_ENDPOINT_*` 变量；服务端不接收环境变量的值。迁移的引擎专属变量继续兼容，但不会自动复制到其他机器。

```bash
remi runtime group create --file group.json --json
remi runtime group get <group-id> --json
remi runtime model catalog --execution-group <group-id> --json
remi agent update <agent-id> --execution-group <group-id>
```

```json
{
  "name": "开发 Codex",
  "description": "开发和代码审查",
  "provider": "codex",
  "endpoint_id": "ep_REPLACE_WITH_ENDPOINT_ID",
  "runtime_ids": ["REPLACE_WITH_RUNTIME_ID"],
  "model_policy": {}
}
```

`model_policy.blocked_models` 是组级屏蔽名单：最多 200 个唯一、区分大小写的精确 ID，校验规则与 `models` 相同；允许填写尚未发现的 ID。缺省或空数组表示不屏蔽，屏蔽优先于放行名单。此版本不支持通配、前缀或端点级屏蔽；后续模式规则将使用独立字段，保持精确 ID 的含义。默认模型被屏蔽时拒绝保存，错误定位到 `model_policy.model`。已保存 Agent 保留原模型，API 返回 `model_policy_reason`，Web 选型器显示屏蔽提示；新任务拒绝入队，未领取任务不可领取并显示策略原因，已领取任务及其冻结重试仍使用原连接与模型。

CLI 支持 `remi runtime group create|update --file group.json --blocked-model exact-id`（可重复；替换屏蔽名单，其他组字段仍由 JSON 提供）。清空时在 JSON 中指定 `model_policy.blocked_models: []`。`group get` 展示策略与是否设置默认模型；`runtime model catalog` 的 JSON 保留 providers 结构并包含 `blocked_models`，table/jsonl 展开模型行，表格显示目录状态、默认模型与推理等级；无默认标记时明确显示 `none identified`，不猜测组配置。

`model_policy: {}` 自动发现模型；可用 `{"model":"default-model","models":["default-model","fast-model"]}` 限制选择。实际目录由各成员通过选定连接探测后求共同可用集合，不用工作区全局目录补足缺失模型。空目录或探测错误不会伪装成可用。端点编辑不触发模型推理；目录探测不等于真实模型调用成功。

## 第三方端点接入

交互参照 Magpie 提供商编辑器、模型目录与测试流程（参考提交 `7a69f455cb391a6b0674c8f4a70f9b76f12e85ea`，仓库 `yetone/magpie` 的 `internal/gui/assets/app.js`、`internal/provider/models.go`、`internal/provider/test.go`），在 Remi 的端点／执行组边界内实现。

| 接入行为 | Remi 契约 |
|---|---|
| 粘贴 cURL / 环境变量 | 仅解析文本中的 URL、API Key、请求模型；不运行命令，不展开变量。请求模型作为手动目录条目，仍由组选择默认模型 |
| 每协议独立地址 | `protocol_urls` 优先于公共地址和 `protocol_paths`；输入完整请求地址时去除请求后缀，保留自定义路径 |
| 单独获取模型 | `options.models_url` 可指定独立模型列表地址；使用当前端点凭据，从 Remi 服务器连接 |
| 禁用列表与手动补充 | `options.fetch_models: false` 不请求列表；`manual_models` 保存 ID、名称、上下文、输出上限。手动条目覆盖同 ID 展示元数据，但不证明引擎能力 |
| 非秘密附加头 | `options.headers` 应用于模型发现及 Codex、Claude、Antigravity 和系统标题请求；认证、Cookie 与传输控制头不允许放在这里 |
| 超时 | `options.timeout_ms` 仅控制检查和模型发现，不是任务执行超时 |
| 模型浏览 | 列表旁的「添加模型」按钮展开并定位手动输入；搜索 ID/名称，显示协议、来源、上下文和输出上限；可将发现的条目保留为手动条目 |
| 分开检查 | 获取列表、探测 API 路径、测试一个模型。路径返回 400/422 只表示有响应；模型测试才发送一次小型推理请求，可能计费 |
| 失败与旧目录 | 刷新失败保留上次成功列表并标识旧版本；修改草稿后显示旧目录提示。失败、空列表、无效 JSON 不标为成功 |
| 未保存草稿 | 可以检查草稿；不会因此保存配置。已保存端点可在服务器复用密钥，浏览器不取回明文 |

`POST /api/execution-endpoints/inspect` 接收 `operation: models | detect | test`；`test` 必须指定一个 `protocol` 和 `model`。`GET /api/execution-endpoints/:id/catalog` 读取目录缓存及最近检查结果。按 `endpoint_id` 检查模型时，省略 `connection` 或传 `null` 表示使用已保存连接。使用已保存凭据时可更新目录缓存，旧 revision 的迟到结果被忽略。显式提供连接对象（即使与已保存连接等价）或临时 `api_key` 时，检查结果只用于本次预览。缓存不参与 Runtime ready 判定，实际可执行目录仍由执行组成员确认。使用 Runtime 环境变量认证的端点不能在服务器检查，手动目录读取除外。

```bash
remi runtime endpoint inspect --file inspection.json --json
remi runtime endpoint catalog <endpoint-id> --json
```

`inspection.json` 可使用 `{"endpoint_id":"ep_ID","operation":"models"}`，也可附带草稿 `connection` 和新 `api_key`。测试模型时再添加 `protocol`、`model` 并将 operation 改为 `test`。

本次未实现 Magpie 的密钥池、额度路由、代理／自定义 CA、任意请求体覆盖或无认证模式。当前 Remi 原生执行适配器仍要求 API Key 或 Runtime 环境变量；页面不提供尚未接通执行层的开关。协议检查不会自动改写协议，也不自动试用不同账号或模型。

带 `endpoint_options` 的组和冻结任务要求 Runtime 声明 `execution_endpoint_options: 1`，旧 Runtime 提示升级且不能领取任务，避免静默忽略手动目录或附加头。

## 本机登录与隔离

本机登录指 daemon 运行账号下可用的原生认证，不一定与浏览器用户或交互终端相同。端点与本机登录都是显式选择；连接失败不会切换到另一种账号或计费来源。每个会话保留隔离的配置目录和原生记录，不让同机不同组互相覆盖配置。

原生连接的模型也按组独立探测，不继承工作区网关目录。Antigravity 本机登录组使用 daemon 账号现有的 `agy` 登录凭据，复制到隔离会话目录后启动 `agy acp`；不复制个人配置和历史。成员需声明 `antigravity_native: 1`，旧 Runtime 必须升级。未登录时明确报错，不继承网关；模型和思考级别由本机 ACP 探测。详见 [Antigravity Runtime](../antigravity.md#local-sign-in)。

## 下发、任务快照与密钥

[绑定状态](../../packages/server/src/store/repos/execution-binding-states-repo.ts)下发组 ID、绑定 generation、端点 revision 和适配后的非秘密连接。daemon 声明 `execution_endpoints: 1` 后才能执行新连接语义；旧 daemon 的页面状态提示升级，不让旧进程把本机登录解释为继承网关。

配置 ready、目录 ready、Runtime 在线是不同证据。连接变更使旧确认失效；只改组名不使成员失效。模型策略变更轮换 generation。daemon 在任务首次领取时收到 `execution_connection`，其中冻结模式、引擎、端点 ID/revision、连接和凭据引用；运行中任务与基础设施重试不随端点编辑改账号。冷重试重新选择当前配置。

端点复用已有版本和凭据存储。密钥以 AES-256-GCM 加密，作用域绑定 workspace、端点 ID 和 credential ID；API 不回显明文。只向属于工作区、已绑定端点或正在执行对应冻结快照的 Runtime 交付凭据。删除端点保留历史版本与凭据供冻结任务恢复。新增 `execution_connection` 列和读取投影的迁移同时覆盖 SQLite/PostgreSQL。

## 系统 AI 与兼容入口

模型输入框可按 ID 或名称查找已绑定网关的模型，选择后填写原始 ID，也可手输目录之外的值。标题优先使用有凭据和基址的 Chat 端点，其次是 Messages；无法确认路由或命中未绑定端点 ID 的旧 relay 时可手输。摘要的 `openai_model` 使用 Chat 目录，`model` 使用 Messages；`auto` 展示两者，`cli` 使用本机配置和覆盖规则。

页面先读取当前协议的目录快照。缺少快照或端点 revision 变化时立即刷新；页面保持打开时，距上次检查满五分钟会再次刷新。同一工作区、端点、revision 和协议的输入共享请求。失败时保留上次成功的列表和当前输入，五分钟后自动重试，也可点击「刷新模型」立即重试。切换端点或离开页面会取消旧计时，关闭 `fetch_models` 后仅显示手动条目。输入 ID 或名称后可点击候选，或按方向键和 Enter 选中原始 ID；点击对应功能的保存按钮才会写入策略。

设置中的原「模型网关」改为「系统 AI」，保留旧 `?tab=model-gateway` 地址。自动标题、进度摘要引用已有端点，不再独立编辑地址和密钥；这些系统默认连接不覆盖执行能力组。由服务器直接调用的功能只接受存储 API 凭据的端点，本机环境变量凭据不交给服务器。

```bash
remi workspace system-model-endpoints get <workspace> --json
remi workspace system-model-endpoints set <workspace> --file defaults.json --json
```

```json
{"defaults":{"openai-chat-completions":"ep_REPLACE_WITH_ENDPOINT_ID","anthropic-messages":null}}
```

旧 `runtime profile`、`workspace relay` API/CLI 暂留兼容；已迁移的 Profile 编辑转换为端点变更，旧模型字段写入对应组策略。旧 Relay 写入转换为端点与系统默认引用，不生成第二套明文密钥。新文档和页面只使用端点入口。旧 Runtime 单机 Profile 保留冻结历史任务兼容用途。

## 升级与迁移

[迁移](../../packages/server/src/store/execution-endpoint-migration.ts)在事务内执行一次：

1. 原中央 Profile 保留 ID，新增端点 revision，旧版本和 credential ID 不改；默认模型和白名单移动到引用组。
2. 完整的旧工作区 Relay 导入独立端点，原 Relay 行变为端点引用，清除其明文 token。相同 URL 不自动合并，避免混淆账号和协议路径。
3. 原来继承 Relay 的受管组绑定导入端点；无网关的组明确设为本机登录。无组 Agent 的原有引擎与机器约束转换为显式组。
4. 不完整的旧网关，以及使用旧全局手工推理声明、1M 上下文声明或额外原生配置选项的继承组，保留 legacy 执行状态；地址与密钥仍可导入端点，但不会静默丢弃这些额外语义。页面显示旧配置，需显式选择端点或本机登录后转换。冻结中的旧任务保留原快照语义，新端点组使用新组语义。
5. 清理旧绑定确认，等待支持 `execution_endpoints: 1` 的 daemon 重新确认。应先准备新版 daemon，再升级平台；旧进程不具备新连接能力时不能领取这些组的新任务。

## 验证入口

- `tests/unit/multiremi/execution-endpoints.test.ts`：SQLite/PostgreSQL 下跨引擎复用、凭据隔离、轮换、原生连接、迁移和系统引用。
- `tests/integration/execution-endpoint-daemon.test.ts`：真实 API/WS/daemon 下发与隔离配置；模型实现为测试替身。
- `tests/unit/daemon/execution-endpoint-routing.test.ts`：原生连接不继承网关、协议路径、Google 模型分页。
- `frontend/packages/views/runtimes/components/execution-config-page.test.tsx`、`settings/components/model-gateway-tab.test.tsx`：页面选择与写入边界。
- `bun run scripts/check-cli-capabilities.ts`、`npm run docs:test`、`npm run docs:check`：CLI 覆盖和文档检查。

这些是验证入口，不代表真实登录、订阅或模型调用已经验证。
