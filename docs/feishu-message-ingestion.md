---
title: Feishu 消息接入
status: active
summary: 当前 Messaging Core、Lark CLI Provider、连接授权、采集边界和验证入口。
---

# Feishu 消息接入

本页描述[Messaging Core](../packages/server/src/messaging/index.ts)及其 Lark CLI Provider。飞书机器人对话连接器在[packages/connectors/src/feishu](../packages/connectors/src/feishu)，由[工作区 bot 配置与 Runtime 分配](deploy/66-8-remi-environment.md)驱动；两者的凭据、消息处理和验证不能混用。

## 当前组件与能力

| 组件 | 职责与源码 |
|---|---|
| Connection | 绑定 provider/channel 与配置，保存连接健康状态。见[MessagingRepo](../packages/server/src/store/repos/messaging-repo.ts)。 |
| Source | 绑定 Connection，设置会话 allowlist、启用状态、轮询间隔及保留策略。 |
| Scheduler | 租约、增量游标、重叠时间窗、去重、未处理重试和过期清理。见[scheduler.ts](../packages/server/src/messaging/scheduler.ts)。 |
| Lark CLI Provider | 通过 argv 调用 lark-cli；执行渠道读取、结构归一、连接配置和交互授权。见[provider.ts](../packages/server/src/messaging/providers/lark-cli/provider.ts)、[runner.ts](../packages/server/src/messaging/providers/lark-cli/runner.ts)。 |
| Outcomes | 通知、回复草稿、Issue 提案和处理审计。见[outcomes.ts](../packages/server/src/messaging/outcomes.ts)。 |

Provider manifest 当前声明 pull、会话检索/读取、send/reply、attachmentDownload、edit/recall、连接配置及交互授权；不支持 push、attachmentUpload、mention、reaction。**Provider 能力不等于已发布的用户 API**：当前 [Messaging 路由](../packages/server/src/api/routers/messaging.ts)提供采集/查询/处理结果/提案操作，没有通用发送或附件下载端点。采集产生的回复草稿是 Inbox 内容，不会自动发送飞书消息。

附件归一支持结构化 `attachments` 和内容中的 file/image key。若 lark-cli 只给渲染后的文字占位符，Provider 不从 `[Image: ...]` 猜测文件 key；不能据此声称所有历史消息都能下载附件。

## 部署与连接授权

API 镜像内置固定版本并校验摘要的 lark-cli；版本及构建参数见[Dockerfile.api](../deploy/docker/Dockerfile.api)，运行配置见[部署指南](../deploy/README.md)。Provider 当前最低版本为 `LARK_CLI_MINIMUM_VERSION=1.0.90`。Core 不依赖另起一个采集 sidecar。

通过 Connection 配置应用时，Provider 为每个连接创建 managed profile；应用 secret 经 stdin 交给 lark-cli，数据库配置只保存 profile 引用。交互授权会返回用于用户完成授权的 URL 和公开会话状态；私有 device code 留在服务端会话内。实现见 Provider 的 `provisionConnection`、`beginAuthorization` 以及 Messaging 路由，不能把一次全局 CLI login 当作每个 Connection 都已完成授权。

[CLI 声明](../apps/remi/cli/commands/operations.ts)中的常用入口：

```bash
remi messaging provider list
remi messaging connection add --help
remi messaging connection authorization start <connection>
remi messaging connection authorization get <connection> <session>
remi messaging connection check <connection>
remi messaging source add --help
remi messaging source available-conversations <source>
remi messaging source status <source>
```

Connection 的 Provider 配置走结构化输入，具体字段以 API 和 CLI help 为准。现有 profile 与 managed profile 的清理行为不同：删除 managed Connection 会调用 lark-cli logout/remove profile；不直接编辑凭据文件。旧 `remi feishu` 命令仍有兼容路由，新接入使用上述 Messaging 入口。

## 采集与处理约束

这些约束来自 Scheduler、MessagingRepo、Provider 和 Outcomes，不代表已验证任何当前部署：

- 空 allowlist 不采集；Scheduler 和落库层均检查范围。落库层比较消息及会话激活时间的分钟值，仅接受后续分钟，激活所在分钟的部分消息可能被跳过。
- 消息身份为 `(connection_id, external_message_id)`；内容更新不会重置已有处理状态。Scheduler 使用重叠时间窗接住延迟出现的消息，避免仅依赖严格单向时间游标。
- Runner 强制 `TZ=UTC` 归一 lark-cli 无时区的分钟时间。消息搜索页上限 50、会话搜索上限 100，Provider 按各命令上限截取。
- `processed_at` 标识处理完成；默认 900 秒检查未处理消息，达到默认 3 次重试限额后写入 `dismissed/unprocessed_timeout`。实际值由 Source 配置决定。
- notify/draft-reply 受 `feishu_messages` 通知偏好控制；明确静音产生 `recipient_muted` 终态。Issue 提案需经人类管理员批准/拒绝；批准路径有去重与审计，task token 不能批准提案。
- 对 watcher 启用 `issue_creation_requires_proposal` 时，直接和 Autopilot 间接建 Issue 都受策略限制；此策略不是所有 agent 的默认行为。
- 缺失 CLI、未授权、版本不兼容等通过 Connection 状态及错误码暴露；限流/超时的可重试处理见 Provider，不能把这些状态等同于 Source 永久停用。

**暂停与删除有不同的数据结果**：停用 Source 停止后续采集；已有内容仍受保留策略管理。删除 Source 会删除关联消息、outcome 和游标；删除 Connection 会连同 Sources、消息和 outcomes 一并删除。需要保留数据时使用停用操作，不能把删除作为无损暂停。

## 验证入口

按改动选择当前单元测试：

```bash
bun test tests/unit/multiremi/lark-cli-message-provider.test.ts tests/unit/multiremi/messaging-scheduler.test.ts
bun test tests/unit/multiremi/messaging-repo.test.ts tests/unit/multiremi/messaging-outcomes.test.ts
bun test tests/unit/multiremi/messaging-api.test.ts tests/unit/multiremi/messaging-contract.test.ts tests/unit/multiremi/feishu-compat.test.ts
```

[真实 CLI 集成测试](../tests/integration/lark-cli-message-provider.test.ts)只读取当前已授权账户，不发送/回复/上传；缺少 lark-cli 或登录时会跳过。`bun test tests/integration/lark-cli-message-provider.test.ts` 的绿色结果必须同时检查执行/跳过数量。更改连接授权、发送等 Provider 能力时，还需分别验证对应能力；只读采集测试不覆盖它们。本次文档核对未运行这些 Bun 测试或访问真实飞书账户。
