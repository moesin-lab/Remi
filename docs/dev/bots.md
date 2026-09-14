---
title: Bot 配置、路由与执行
status: active
summary: 在一个 Bot 内管理平台账号、Agent 承载、执行目录、路由和可选白名单，并与旧飞书机器人并行使用。
---

# Bot 配置、路由与执行

Bot 是独立的管理主体。平台账号、默认承载、路由、Issue 推送与白名单都在 Bot 内配置；Agent、Runtime、RuntimeWorkspace、Chat 和 Task 继续使用 Remi 原有资源。类型见 [bots.ts](../../packages/contracts/src/bots.ts)，管理入口为 [Bot API](../../packages/server/src/api/routers/bots.ts) 的 `/api/bots` 和 [remi bot](../../apps/remi/cli/commands/bots.ts)。持久化配置与会话见 [BotsRepo](../../packages/server/src/store/repos/bots-repo.ts)，条件解析见 [routing.ts](../../packages/server/src/bots/routing.ts)。

## 配置与执行位置

一个 Bot 可以绑定多个平台账号。目前执行适配支持飞书，包括 Feishu、Lark 和 ByteDance 域；同平台的不同 app/token 保存为不同 `platform_bindings`。平台字段预留扩展位置，不表示当前已支持其他平台。

| Bot 配置 | 当前含义 |
|---|---|
| `platform_bindings` | 外部账号、凭据、收发消息的 `host_runtime_id` 和连接启停。每个绑定有稳定 ID。 |
| `default_target` | 默认 Agent，以及可选执行 Runtime、项目或 RuntimeWorkspace。当前承载类型只有 `kind: "agent"`。 |
| `routes` | 有序的条件与目标配置；直接引用 Agent，执行设置可以覆盖默认值。 |
| `issue_notifications` | 可选的主动 Issue 推送，明确使用哪个平台绑定、发往哪个群、项目过滤和可选 Agent 目标。 |
| `allowlist_enabled` | 默认 `false`。启用后使用 Bot 内已发现账号的允许状态约束 Issue 创建。 |

Bot 新建时默认停用，配置中的 `enabled` 控制 Bot 整体运行；平台绑定也有独立的 `enabled`。连接宿主负责接收与发送，目标的执行 Runtime 负责运行 Agent，两者可以不同。`workspace_id` 沿用现有数据归属，不把外部发送者关联为工作区成员。

工作位置沿用[RuntimeWorkspace 契约](runtime-workspaces.md)：项目和 RuntimeWorkspace 互斥。默认目标未填写执行设置时使用自动选择；规则未填写某个执行设置时继承 Bot 默认值，显式 `null` 清除此项继承。RuntimeWorkspace 固定所属机器，不能通过另一 Runtime 执行。直接以单 Runtime 为承载对象尚未实现，指定 Agent 的执行 Runtime 与它是两种能力。

## 路由与聊天历史

入站请求的显式目标优先，其次按配置顺序选择第一条命中规则，最后使用默认目标。规则可以匹配平台绑定、私聊/群聊、外部会话 ID 和命令；不同字段同时满足，同字段数组满足其一。空条件匹配全部请求，放在前面会覆盖后面的规则。当前不使用模型判断路由意图。

会话映射由平台绑定、外部会话和解析后的 Agent/执行设置确定。规则 ID、匹配顺序、token、provider session ID 和自动调度实际选择的机器不构成这份映射。两条规则选中相同目标时复用 Chat；不同 Agent 或工作位置使用不同 Chat。新增条件和同账号换 token 不应拆散原聊天历史。

平台绑定 ID 同样用于账号身份和历史关联。轮换同一账号的 secret 时保留它的 ID；要更换 `app_id` 或域，新增绑定。已有任务和回复保留原目标，配置变化用于后续请求。重开切换对应映射的当前 Chat，取消和状态查询根据明确的 Chat/回复目标定位；一个外部会话有多个承载目标且无法唯一定位时返回 `ambiguous_session`。

执行仍走 Bot 入站 → Chat → Task → Runtime，复用现有 steer、委派、重试和 provider 会话恢复。入站与出站记录保存原平台绑定和回复位置，完成回复及 Issue 更新沿原会话发回；Bot 配置修改不会把进行中的回复发到新账号。主动 Issue 推送需要显式配置 `issue_notifications`，不从多个账号中猜测目的地。

Bot Chat 属于所在空间，空间用户可从 Chat 列表查看历史和实时任务；发送者保持外部账号身份。删除 Bot 后历史仍可访问，已有个人 Chat 保持原归属。附件上传到服务端后以稳定引用交给执行 Runtime；执行中追加的附件通过 steer 提供下载命令，重试保留原消息的附件。

最终回复统一通过持久化 outbox 交付。普通流式卡片发送成功后记录外部消息回执，最终投递更新这张卡片；没有卡片回执时才按投递幂等键新发消息。崩溃恢复后若平台暂不允许更新原卡，投递保持失败/重试状态，不改成再发第二条消息。卡片更新与新消息发送分别需要真实平台验证。

## 可选白名单与凭据

默认开放模式不因为外部发送者未绑定成员而限制 Issue 创建，也不要求先有 Messaging 采集记录。发送者按 Bot 平台绑定和外部账号 ID 自动登记、去重；昵称仅用于展示，不跨平台账号合并。

白名单默认关闭。开启后，未允许发送者产生的 Chat 仍可交互，Issue 创建沿现有白名单语义受限；允许后按当前配置重新判断，移出后再次限制。此配置不增加 Runtime 权限矩阵、成员绑定或通用动作审批。Agent 自己已有的 Issue 提案策略独立保留。

平台 secret 在控制面保存，管理查询只返回是否配置及提示信息；daemon 通过绑定到指定 Runtime 的 assignment 获取连接材料。Bot 配置和白名单写入沿用现有的人类配置入口，task 可以读取当前空间的配置、发送者和会话；业务执行使用原 task 身份。普通 Chat 和 Bot Chat 都可以调用 `remi runtime command run` 操作其身份可访问的 Runtime，具体边界见[认证与权限](auth.md)。

## API 与 CLI

Bot 采用整体配置写入：`POST /api/bots` 创建，`PUT /api/bots/:id` 替换。平台绑定和路由无需另外创建顶层资源。更新时携带完整配置与已有绑定 ID；未传 secret 表示保留该 ID 的原凭据。新增绑定和更换密钥使用 `app_secret_op: "set"` 与 `app_secret`。已有绑定在 Bot 或该绑定停用时可用 `clear` 清除凭据；再次启用前必须重新设置密钥。配置读取的脱敏字段不是新 secret。

下面是 `bot.json` 的配置形状。Agent、Runtime 和 RuntimeWorkspace ID 替换为当前空间已有资源；Bot 保存后返回的平台绑定 ID 用于后续更新或指定 `issue_notifications.platform_binding_id`。

```json
{
  "workspace_id": "local",
  "name": "开发助手",
  "enabled": true,
  "platform_bindings": [{
    "platform": "feishu",
    "app_id": "cli_example",
    "domain": "feishu",
    "host_runtime_id": "runtime_mac",
    "app_secret_op": "set",
    "app_secret": "<应用密钥>"
  }],
  "default_target": { "kind": "agent", "agent_id": "agent_general" },
  "routes": [{
    "id": "deploy",
    "name": "部署请求",
    "match": { "commands": ["deploy"] },
    "target": {
      "kind": "agent",
      "agent_id": "agent_ops",
      "runtime_id": "runtime_windows",
      "runtime_workspace_id": "directory_windows"
    }
  }],
  "allowlist_enabled": false,
  "issue_notifications": null
}
```

```bash
remi bot list --workspace <workspace> --output json
remi bot create --file bot.json --output json
remi bot get <bot> --output json
remi bot update <bot> --file bot.json --output json
remi bot sender list <bot> --output json
remi bot sender allow <bot> <sender>
remi bot sender revoke <bot> <sender>
remi bot session list <bot> --output json
remi bot delete <bot> --yes
```

配置通过 `--file <path>` 或 `--file -` 提交；含 secret 时使用文件或标准输入，避免放进命令行。`--data` 也支持普通 JSON 配置。创建时未提供 `workspace_id` 使用 CLI 当前空间；更新是整体替换，提交完整配置。

删除 Bot 停止其接入并移除可用配置，其可选白名单不再限制历史 Chat；不删除它曾使用的 Agent、Runtime、Chat 或 Task。需要临时暂停时把 `enabled` 设置为 `false`。

## 与旧体系并行

旧工作区飞书配置、集成页、`remi workspace feishu-bot ...`、daemon 单连接路径及历史数据继续保留；新 Bot 有独立的配置、会话和投递记录。不同账号可分别使用两套体系，同一已启用账号由其中一套负责收发，不能同时启用重复连接。

本轮没有自动导入或重定向旧数据。切换同一账号时先停旧连接，再启用新 Bot；旧 Chat 历史仍留在旧体系。需要回退时停用新 Bot 后恢复旧配置。Messaging 的 Lark CLI 采集也是独立能力，不能将其 Connection、Source 或提案记录作为 Bot 对话的前置条件，见[飞书消息接入](../feishu-message-ingestion.md)。

## 验证入口

配置、路由与历史见 [Store 测试](../../tests/unit/multiremi/multiremi-bots-store.test.ts)，管理与机器接口见 [API 测试](../../tests/unit/multiremi/multiremi-bots-api.test.ts)，连接协调、收发与 Issue 更新分别见 [concierge](../../tests/unit/multiremi/bot-concierge.test.ts)、[host](../../tests/unit/multiremi/bot-host.test.ts)、[Issue updates](../../tests/unit/multiremi/bots-issue-updates.test.ts)。

CLI 的配置往返与账号定位见 [cli-bots.test.ts](../../tests/unit/remi/cli-bots.test.ts)，能力清单由 [generate-cli-capabilities.ts](../../scripts/generate-cli-capabilities.ts)生成。Runtime 命令的 Chat 凭据与结果查询见 [multiremi-api-runtime-command.test.ts](../../tests/unit/multiremi/multiremi-api-runtime-command.test.ts)。

上述测试提供本地验证入口；真实飞书连接、消息投递和 Windows 命令执行需分别记录实际环境验证，不能从模拟测试的通过数量推断已部署或外部平台已验收。
