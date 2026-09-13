---
title: Topic、Chat 与 Issue Session 产品模型
status: active
summary: 定义对话、Issue 工作会话、任务、成果及飞书话题之间的边界、生命周期和绑定关系。
---

# Topic、Chat 与 Issue Session

本页是 Remi 对这些名称的产品约定。面向用户的文案和新接口应使用 **Chat** 与
**Issue Session**；只有上下文已明确位于 Issue 内时，才把后者简称为 **Session**。
`provider session` 必须带限定词，不能简称为 Session。

```mermaid
flowchart LR
  Topic["飞书 Topic<br/>外部话题/线程"] -->|外部绑定| Chat
  Chat -->|每条待处理消息| ChatTask[Chat Task]
  Chat -. "可绑定 0..1 个" .-> Issue
  Issue -->|"创建时自动有 Main；可再建多个"| Session[Issue Session]
  Session -->|执行轮次| IssueTask[Issue Task]
  Session -->|显式发布| Result[成果]
  ChatTask -. "可继承 issue_id；常规路径不进入 Issue Session" .-> Issue
  ChatTask --> Provider[provider session]
  IssueTask --> Lane["Session × Agent lane"] --> Provider
```

## 名词与层级

| 名称 | 产品职责 | 持久化和归属 |
|---|---|---|
| Topic | 特指飞书群中的原生话题/线程，是消息接入的外部地址，不是 Remi 的一级领域对象。 | 以飞书 `chat_id` 和根消息 ID 组成外部会话键，经 binding 指向一个 Chat。 |
| Chat | 用户与一个 Agent 的持续对话容器，保存消息、队列、未读状态和运行上下文；不要求先有 Issue。 | 属于 Workspace，固定一个 Agent，可选绑定一个同 Workspace Issue。一个 Issue 可被多个 Chat 绑定。 |
| Issue | 要跟踪、分派和验收的工作目标。 | 属于 Project/Workspace；创建时同步创建唯一的默认 Main Issue Session。 |
| Issue Session | Issue 内一条独立的工作脉络，隔离事件投影和 Agent 的 provider 上下文。 | 永远属于一个 Issue；一个 Issue 有一个默认 Session，并可有多个附加 Session。 |
| Task | 一次可调度、可取消、可审计的执行轮次，不是对话容器。 | Chat 消息创建 Chat Task；Issue Session 派发创建 Issue Task；也存在不属于二者的直接 Task。 |
| 成果（Session Result） | 某个 Issue Session 主动公开给整个 Issue 复用的稳定结论或交付物。 | 不可变，记录来源 Session、可选来源 Task、类型和引用；不等同于完整事件或 Task transcript。 |
| provider session | Codex/Claude 等运行后端用于续接模型上下文的技术标识。 | Chat 直接保存当前续接状态；Issue Session 按 `Session × Agent × execution scope` 保存 lane。它不是产品 Session。 |

实现依据包括 [Issue/Session 表结构](../packages/server/src/store/migrations.ts)、
[Issue Session 仓储](../packages/server/src/store/repos/issue-sessions-repo.ts)、
[Chat 仓储](../packages/server/src/store/repos/chat-repo.ts)和
[Task 调度](../packages/server/src/store/repos/tasks-repo.ts)。兼容类型仍名为
`MultiremiChatSession`，兼容 REST 路径仍为 `/api/chat/sessions`；它们是内部/历史命名，
不表示 Chat 是 Issue Session 的一种。

## 创建、续接与结束

### Chat

- Web 在首次发送消息或首次上传附件时创建 Chat；CLI 也可用 `remi chat create` 显式创建。
- 一条没有活跃执行的消息创建一个 Chat Task；已有活跃 Task 时，飞书接入可把新消息作为 steer
  送给该 Task。同一 Chat 的待执行 Task 串行领取。
- Chat 的 provider session 只是运行优化。不能续接时，系统可从有预算的 Chat 历史重新投影，
  因此 Chat 的身份不依赖某一个 provider session ID。
- 归档 Chat 会取消未完成 Task 并使它只读；恢复后可继续。删除会移除 Chat 及消息，并取消未完成 Task，
  但已保留的 Task 审计记录仍保留私聊作用域。

### Issue Session

- 创建 Issue 时必定创建默认 `Main`；额外 Session 由用户、API 或 CLI 显式创建。
- Issue Session 的评论/事件按 Session 分流；同一个 Agent 在同一个 Session 内通过 lane 续接 provider
  上下文，换 Session 或换 Agent 都不是同一条 lane。
- `active`/`archived` 当前用于组织和默认列表过滤：默认列表隐藏 archived Session。它不同于 Chat
  归档；现有实现不会因为归档 Issue Session 自动取消正在执行的 Task，也没有把所有写入口统一变为只读。
- Session 是 Issue 的子对象，不能改绑到另一个 Issue。Issue 删除时按父子关系清理。

### Task 与成果

- 正常 Chat 发送路径创建的 Task 具有 `chat_session_id`；如果 Chat 已绑定 Issue，还会继承
  `issue_id`，但不会自动取得 `issue_session_id`。因此它仍是 Chat Task，不会进入 Main Session。
- 正常 Issue 执行路径创建的 Task 具有 `issue_id` 和 `issue_session_id`，没有 `chat_session_id`。
  未显式指定 Session 的 Issue Task 使用 Main。
- Task 完成输出仍是执行记录。只有调用 `remi session result publish`（或等价 API）后，才成为
  可由其他 Session 稳定复用的成果；其他 Session 不应依赖来源 Session 的私有事件投影。
- Chat 绑定 Issue 只提供关联、上下文提示和 Issue 更新订阅，不会合并两边的消息历史、Task 队列、
  provider session 或生命周期。Chat Task 也不会自动发 Issue 评论或驱动 Issue 状态。

成果元数据约定见 [Issue key results](issue-key-results.md)，Chat 的队列与权限契约见
[Chat](chat.md)。

## 飞书个人 Bot 与群话题

[Feishu 连接器](../packages/connectors/src/feishu/index.ts)先计算外部会话键，
[FeishuBotRepo](../packages/server/src/store/repos/feishu-bot-repo.ts)再把它映射为平台 Chat：

| 飞书入口 | 外部会话键 | 产品行为 |
|---|---|---|
| 个人 Bot 私聊 | 私聊的 `chat_id` | 同一私聊持续映射到同一 Chat，直到执行 `/new` 或路由 Agent 改变。每条新输入创建/steer Task，而不是创建 Issue Session。 |
| 群内新顶层消息 | `chat_id:thread:<message_id>` | 该根消息开启一个飞书 Topic，并映射到独立 Chat。 |
| 群内话题回复 | `chat_id:thread:<root_id>` | 继续同一飞书 Topic 对应的 Chat。 |
| Remi 自动创建的 Issue 话题 | 发送成功后的根消息 ID | 预先创建的绑定 Chat 在根消息落地后固定外部键，并可选绑定对应 Issue。 |

`/new` 会取消当前活跃 Task 并解除该外部键的 binding；下一条消息创建新 Chat。旧 Chat 不会因
`/new` 自动归档或删除。在飞书中优先用 `/chat` 查看当前 Chat；`/sessions` 仅作为旧命令别名保留，
它不列出 Issue Session。

Daemon 在飞书 Topic 尚未转成 Issue 时，可能使用 `_topics/<topic-id>` 临时工作目录；
[TopicWorkspaceLifecycle](../packages/daemon/src/agent-runtime/workspace/topic-lifecycle.ts)在 Issue 创建后把它迁移到
Issue 工作目录。`remi issue bind-topic` 是该迁移的恢复入口。这里的 “topic workspace” 是本地实现细节，
不是另一种产品对象或长期容器。

## 术语规则与关联事项

- UI、文档和 CLI 用 **Chat** 指持续对话，用 **Issue Session** 指 Issue 内工作脉络，用 **Task**
  指一次执行；不要使用 “Chat Session”。
- 数据库列 `chat_session_id`、类型 `ChatSession`、URL 查询参数 `?session=` 和 REST
  `/api/chat/sessions` 暂时保留兼容，不作为新产品术语扩散。
- “Session archive” 还可能指 provider 本地会话文件的备份/恢复机制；必须写全为
  **provider session archive**，不要与 Issue Session 的 `archived` 状态混用。
- Workspace 单用户模型、成员/owner 清理与外部发送者身份边界由 **MUL-2** 独立处理，本页不定义其迁移方案。
- 让绑定 Issue 的 Chat 直接展示并续接 Issue Session Task 由 **MUL-3** 独立处理；在该能力完成前，
  不得把 Chat-Issue 绑定描述为 transcript 或 Task 的合并。

## 验证入口

核心关系由以下测试覆盖：

```bash
bun test tests/unit/multiremi/multiremi-issue-sessions.test.ts
bun test tests/unit/multiremi/multiremi-store-chat.test.ts tests/unit/multiremi/chat-queue.test.ts
bun test tests/unit/multiremi/multiremi-feishu-bot-task-bridge.test.ts
bun test tests/unit/daemon/topic-workspace-lifecycle.test.ts
```
