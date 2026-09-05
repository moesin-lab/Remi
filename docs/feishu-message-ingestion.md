---
title: Feishu 消息接入
status: active
summary: 当前机器人 Chat/Issue 话题与轮次推送，以及独立的 Messaging Core 采集、授权和验证入口。
---

# Feishu 消息接入

本页分别说明机器人对话和 [Messaging Core](../packages/server/src/messaging/index.ts)的 Lark CLI 采集。机器人连接器在[packages/connectors/src/feishu](../packages/connectors/src/feishu)，由[工作区 bot 配置与 Runtime 分配](deploy/66-8-remi-environment.md)驱动；两者的凭据、消息处理和验证不能混用。

## 机器人对话、Issue 话题与更新

[FeishuBotRepo](../packages/server/src/store/repos/feishu-bot-repo.ts)维护飞书会话与平台 Chat 的绑定。[Issue 创建路由](../packages/server/src/api/routers/issues.ts)通过已验证 task token 找到来源 Chat：未绑定时自动绑定新 Issue，已有绑定时保留并返回提示，不会悄悄改绑。人类可用 [Chat CLI](../apps/remi/cli/commands/collaboration.ts)的 `remi chat issue bind/unbind` 显式调整；绑定目标必须属于同一工作区。

- **自动话题**：[工作区配置](../packages/server/src/issue-topics/config.ts)默认关闭，启用需目标群 `chat_id`，可按 `project_ids` 限制；空项目列表表示不限制项目。配置写入要求人类工作区管理员。[workspace CLI](../apps/remi/cli/commands/workspace.ts)提供 `remi workspace issue-topics get/set`。当前 Issue 创建 API 在 bot 在线且命中过滤条件时创建绑定 Chat 和持久化根消息投递；从 Chat 创建的 Issue 不再另开话题。未配置、bot 离线或准备投递失败不阻断 Issue 创建，也不代表以后会自动补建。
- **增量上下文**：绑定默认建立启用的 agent_chat 通知通道；[AgentIssueUpdatesRepo](../packages/server/src/store/repos/agent-issue-updates-repo.ts)将允许的 Issue activity 按默认 30 秒窗口合并，只保留该批最新正文及事件计数，过滤来源于目标 Chat 的回声。普通更新写为 Chat 待投递消息，不单独唤醒 Agent；下一次 claim 最多注入最新 12 条并给出遗漏数量，成功完成后才清除待投递标记。切换绑定或关闭订阅会清除待投递更新。摘要不替代 `remi issue get` 和最近评论查询。
- **订阅控制**：[Chat 路由](../packages/server/src/api/routers/chat.ts)提供 `issue-updates` 查询/开关，对 task token 返回 403；CLI 为 `remi chat issue updates get/enable/disable`。开关与绑定分别维护，不能只看 Issue 有绑定就认定更新仍启用。
- **轮次推送**：[TasksRepo](../packages/server/src/store/repos/tasks-repo.ts)在负责人 Issue Session 任务成功结束、该 Issue 已无其他活跃执行任务后，触发绑定话题的总结。已有 Chat task 时 steer；否则创建一个主动总结 task。按绑定与负责人 task 去重，等待委派任务和负责人回程完成，Chat 总结本身不自动修改 Issue 状态或再发 Issue 评论。
- **出站投递**：主动总结完成后进入持久化 outbox，daemon 通过心跳领取有租约的 delivery，经 [concierge host](../apps/remi/cli/multiremi.ts)发送并回报；失败按退避重试。[send.ts](../packages/connectors/src/feishu/send.ts)向飞书 create/reply 传 delivery 的幂等键。根消息成功后用返回的消息 ID 固定话题绑定；这些机制不等于真实飞书端已验证恰好一次投递。

Chat 即使绑定 Issue，仍使用独立 Chat 工作目录与会话投影。claim 中的 `bound_issue`、待投递摘要和 [CLI caller context](../packages/server/src/api/routers/cli.ts)可帮助 Agent 找回当前 Issue；不要把任务创建时尚未绑定的空 `issueId` 当作永远没有 Issue 上下文。

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
bun test tests/unit/multiremi/multiremi-feishu-issue-topics.test.ts tests/unit/multiremi/multiremi-feishu-bot-task-bridge.test.ts
bun test tests/unit/multiremi/multiremi-agent-issue-updates.test.ts tests/unit/multiremi/multiremi-store-daemon-wire.test.ts tests/unit/connectors/feishu-send.test.ts
bun test tests/unit/multiremi/lark-cli-message-provider.test.ts tests/unit/multiremi/messaging-scheduler.test.ts
bun test tests/unit/multiremi/messaging-repo.test.ts tests/unit/multiremi/messaging-outcomes.test.ts
bun test tests/unit/multiremi/messaging-api.test.ts tests/unit/multiremi/messaging-contract.test.ts tests/unit/multiremi/feishu-compat.test.ts
```

[真实 CLI 集成测试](../tests/integration/lark-cli-message-provider.test.ts)只读取当前已授权账户，不发送/回复/上传；缺少 lark-cli 或登录时会跳过。`bun test tests/integration/lark-cli-message-provider.test.ts` 的绿色结果必须同时检查执行/跳过数量。更改连接授权、发送等 Provider 能力时，还需分别验证对应能力；只读采集测试不覆盖它们。实际执行结果和真实飞书验证范围应记录在对应任务或 PR。
