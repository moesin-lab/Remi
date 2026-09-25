---
title: 能力组与连接 Profile
status: active
summary: 工作区集中配置连接、选择 Runtime 成员，并通过版本确认控制任务领取。
---

# 能力组与连接 Profile

Runtime 页的统一配置入口管理两个对象。连接 Profile 保存 Claude/Codex 的服务地址、模型和鉴权；能力组选择执行引擎、一个 Profile（或不使用自定义连接）与 Runtime 成员。一个 Profile 可供多个组复用，一个 Runtime 可承载多个组。自动发现只登记引擎与机器状态，不创建能力组。

[API](../../packages/server/src/api/routers/execution-config.ts)使用 `/api/execution-profiles` 与 `/api/execution-groups`，集合支持 GET/POST，单项支持 GET/PUT/DELETE。连接配置的 provider 只支持 `claude`、`codex`；组还支持 `antigravity`，但其 `profile_id` 必须为 null。组内成员必须同工作区并匹配 provider，`any` Runtime 可承载具体 provider。更新不能更改已有 Profile 或组的 provider。

## 配置流程

先检查当前工作区，再创建连接：

```bash
remi runtime profile list --json
remi runtime profile create --file profile.json --json
```

`profile.json` 示例：

```json
{
  "name": "团队 Codex",
  "provider": "codex",
  "profile": {
    "name": "team-codex",
    "base_url": "https://gateway.example/v1",
    "model": "custom-model",
    "auth_mode": "api_key",
    "env_key": ""
  },
  "api_key": "REPLACE_WITH_API_KEY"
}
```

外层 `name` 是展示名，内层 `profile.name` 是连接标识，只接受字母、数字、下划线、连字符。Codex 接口须兼容 Responses；Claude 须兼容 Anthropic Messages，并可设置 `auth_header: "bearer"` 或 `"x-api-key"`。每个 Profile 声明一个模型。地址、模型与思考能力规则见 [Codex](../design/acp-codex-via-codex-acp.md#runtime-自定义连接)和 [Claude](../design/acp-claude-via-claude-agent-acp.md)。不要把真实密钥提交到 Git。

选择机器上登记的 Runtime，使用返回的 Profile ID 创建组：

```bash
remi runtime list --json
remi runtime group create --file group.json --json
remi runtime group list --json
```

```json
{
  "name": "团队开发",
  "provider": "codex",
  "profile_id": "ep_REPLACE_WITH_PROFILE_ID",
  "runtime_ids": ["REPLACE_WITH_RUNTIME_ID"]
}
```

`profile_id: null` 使用工作区 Relay / 原生连接，不继承该 Runtime 的旧自定义 Profile。能力组可以暂时无成员，但不会有可执行机器。云友使用 `--execution-group <group-id>` 选择组；模型目录使用 `remi runtime model catalog --execution-group <group-id>` 查询。

更新使用 `runtime profile update <id> --file ...` 或 `runtime group update <id> --file ...`，提交完整配置。Profile 每次保存产生不可变 revision；省略 `api_key` 保留已存密钥。删除使用对应 `delete <id>` 命令。仍被组引用的 Profile、仍被云友引用的组不可删除。

## 下发、快照与凭据

[daemon 心跳](../../packages/server/src/api/routers/daemon.ts)下发组 ID、绑定 generation、Profile ID、revision 与非秘密配置。[daemon](../../packages/server/src/worker/daemon.ts)检查 provider、解析配置并取得对应凭据或本机环境变量，随后回报 ready 或 error。[服务端状态存储](../../packages/server/src/store/repos/execution-binding-states-repo.ts)只接受与当前绑定 generation 和 Profile 版本一致的确认，重新注册或修改绑定后拒绝旧确认；[任务调度](../../packages/server/src/store/repos/tasks-repo.ts)要求受管组配置 ready 才能首次领取任务。更新 Profile 后旧 revision 的确认不再满足领取条件。旧 daemon 不能为受管组确认配置。

ready 表示配置与凭据解析成功，不表示已调用远端模型。Runtime 在线、模型出现在目录与配置 ready 是不同证据，真实连通性仍需执行任务验证。

首次 claim 冻结完整连接配置和凭据版本，加入执行指纹。运行中任务继续使用自己的快照，daemon 按任务构造隔离配置；同一 Runtime 上不同组的任务不会互相覆盖全局 provider 设置。已冻结任务重领继续使用旧连接；显式修改云友模型或 thinking 参数时，已冻结但尚未启动的任务取消，运行中任务继续原执行。重试与会话隔离约束见各 provider 接入文档。

Profile 与组的写入要求人类工作区管理员身份；组修改还检查受影响 Runtime 的编辑权限。task/daemon token 不能管理中央配置。API 不回显明文密钥；中央凭据使用现有 AES-256-GCM 机制，作用域绑定工作区、Profile ID 与不可变 credential ID。密钥配置及轮换变量见 [Codex 凭据说明](../design/acp-codex-via-codex-acp.md#runtime-自定义连接)。删除 Profile 只隐藏当前配置，保留历史版本和加密凭据，支持既有任务快照。

环境变量模式不在平台存密钥：Codex 使用 `REMI_CODEX_*`，Claude 使用 `REMI_CLAUDE_*`。变量必须存在于每台承载机器的 daemon 进程环境；仅在运行管理 CLI 的终端设置无效。

## 升级与旧数据

[迁移](../../packages/server/src/store/execution-profile-migration.ts)保留旧成员与云友绑定，放开一个 Runtime 只能属于一个同 provider 组的限制。每份旧 Runtime/provider 连接独立导入为中央 Profile，不按名称或配置内容合并；API Key 解密后以中央 Profile 作用域重新加密，旧连接和凭据继续保留给既有任务快照。迁移要求原凭据和解密密钥完整可用，缺失时失败，不丢弃连接或回退明文。

单成员旧组绑定该成员导入的 Profile 并转为受管组；成员都没有自定义连接的旧组转为 `profile_id: null` 的受管组。多成员组含不同连接时保留旧组的非受管调度语义，不擅自用一个 Profile 覆盖其他成员的连接。每个导入连接如果尚无受管组，迁移会为其建立绑定原 Runtime 的独立能力组，供集中编辑与使用；旧异构组不被静默替换。受管组必须等待新版 daemon 的当前配置确认才能接新任务，因此升级平台前应先升级各机器 CLI，平台升级后重启 daemon 并确认绑定 ready。

迁移保留旧模型能力的来源证据。仅同 Runtime 的实际旧连接与中央连接等价、凭据来源可验证时复用 thinking 能力；更换服务地址或密钥后旧证据失效，多机器组继续取成员能力交集。

编辑旧组会将其转为受管组；选择 null Profile 会采用工作区 Relay / 原生连接，因此迁移自定义连接时应选择正确的导入 Profile。Runtime 详情不再逐台编辑自定义连接；旧 `runtime codex-profile get|set`、`runtime claude-profile get|set` API/CLI 保留用于旧数据兼容，它们不会同步导入后的中央 Profile。

## 验证入口

配置与下发可从上述 CLI 的读取结果、Runtime 绑定状态及 daemon 心跳检查。文档检查使用 `npm run docs:test` 与 `npm run docs:check`；这些检查不代表真实模型调用成功。
