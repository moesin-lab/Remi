# MUL-21：Assistant 与渠道传输切割

本方案以 Remi `main@1ff7d6e96` 和只读 Persona
`7e92568a10156da89360b729426214881f9941c1` 为调查基线。
本轮交付 Phase 1 路由与命令策略切片；完整助理模式按下文分期实现。
不把新增 TypeScript 契约视为已经落库或已提供用户功能。

## 参考与现状差异

Persona 参考：`docs/assistant/assistant.md`（主对话、UserSpoke、随访、简报、监督），
`unified-entry.md`（Intent、Instant / Auto-start / Plan-first、Task dock），
`north-star.md`（实际打扰和发送可用性），`docs/extensions/bots.md`、`channels.md`。
代码核对 `server/internal/assistant/feishu_message.go`、`feishu_card_actions.go`、
`channels*.go`、`service.go`，`server/internal/feishubot/events.go` 与
`server/internal/hub/manager_bots.go`。Persona 也已将旧 hub/bots 职责迁到
assistant/extmgr，不能按旧目录名判断现行归属。

| 领域 | Persona | Remi 基线与决定 |
| --- | --- | --- |
| 助理身份 | 独立主对话、执行器、监督器、跨渠道状态 | 现有 bot 配置有 agent/runtime，Chat 是按外部会话键创建；新增独立 Assistant 身份，不能把 bot_id 当永久 assistant_id |
| 多机器人 | 传输连接与助理分开 | Remi 已有多 bot，workspace+bot 隔离；不是全工作区只有一个 Chat。兼容适配器必须保留此隔离 |
| 渠道 | transport 上报 message/card_action，Assistant 处理目标和 run | supervisor 主要已负责凭据拉取、连接协调与交接；混合职责主要还在 FeishuBotRepo 与 CLI task handler，不能只改 supervisor 名字 |
| 焦点 | main/new/list 与线程目标 | Remi 有 new/status/stop；群话题保持 Issue 绑定。Phase 1 保持命令集合和未知命令提示；main/list 后续只对新助理模式启用 |
| 能力 | main/asks/all_asks/push/sync 分开 | 新绑定分开控制当前会话问题/审批、全工作区问题/审批、通知与简报；全工作区和主动镜像默认关闭。旧绑定不自动扩大权限 |
| 问题 | 自己 ask_user 被新消息撤回；权限不撤回；超期转待办 | Remi 已有统一 Q、路由/回答版本、令牌、provider 消费状态。必须复用 Q；不得新建第二份 Assistant 审批状态机 |
| 调度 | Follow-up / Routine 入原会话，监督降低打扰 | Remi Autopilot 有独立运行来源 Chat；助理只管理随访意图与监督引用，不替换 Autopilot 或 Issue 执行负责人 |
| 指标 | 首次送达用户才算打扰；发送尝试 ok/failed/unknown | Remi 后续补结构化事件；不得从 connector online 推导助理可用率，历史缺失显示 unknown |

## 领域与数据模型

[领域契约](../../packages/contracts/src/assistant.ts)给出 Assistant 身份、默认 Agent、
主 Chat 与监督策略，及新绑定的能力默认值。Phase 1 只落契约和可运行路由，
没有 Assistant 表、CRUD、能力配置读写或新 Web 页面。

后续落库模型（全部受 workspace_id 约束）：

| 表 | 关键字段与约束 | 归属 |
| --- | --- | --- |
| assistants | id、workspace_id、name、main_chat_session_id nullable、default_agent_id、supervision_policy、revision、archived_at | Assistant；主 Chat 和 Agent 必须同工作区，主 Chat 不得是 Issue transport Chat |
| assistant_channel_bindings | id、workspace_id、assistant_id、channel_kind、channel_id、capabilities JSON、revision | 一个 transport 绑定一个助理；一个助理可有多个 Web/IM 入口；unique(workspace,kind,channel_id) |
| assistant_channel_focus | binding_id、sender/recipient_scope、focused_chat_id、revision | 焦点按操作者隔离；共享群不允许覆盖私人焦点；群 thread 单独映射，优先于焦点 |
| assistant_followups | id、assistant_id、origin_session_id、due_at、prompt、state、idempotency_key | 一次随访；原会话不可用时显式记录失败，不暗中投到别的 Issue |
| assistant_routines | id、assistant_id、autopilot_id、timezone、delivery_policy | 复用 Autopilot 调度与 run，不新增计时引擎 |
| assistant_work_refs | assistant_id、origin_session_id、issue_id 或 execution/session 引用 | Task dock 聚合；不是第二套任务状态 |

Runtime 分为 connector host 与 Agent 执行放置；Assistant 默认执行器仅引用 Agent，
实际执行仍由现有执行配置组选择 Runtime。IM appSecret、配对、allowlist、
connector revision 和两阶段停止确认永远不进入 Assistant。

## 服务、协议与权限边界

Phase 1 的 [routing](../../packages/server/src/assistant/routing.ts)通过窄端口读取候选，
拥有“具体会话 > 私聊/群默认 > 旧配置”的优先级和路由 Agent 工作区/归档校验。
[FeishuBotRepo](../../packages/server/src/store/repos/feishu-bot-repo.ts)作为兼容适配器，
仍负责 bot 作用域 SQL、旧配置回退、幂等、绑定和事务。历史 config fallback 原样保留，
不额外更改归档/缺失 Agent 的返回行为，实际启用和任务执行仍受现有校验约束。
底层纯命令解析原语唯一实现于 [feishu-commands](../../packages/shared/src/feishu-commands.ts)
（供 `@connectors` durable history intake 与实时路由共享，避免反向依赖 `@multiremi/*`）；
[commands](../../packages/server/src/assistant/commands.ts)作为 Assistant 命令策略门面显式 re-export，
供 CLI 主入口直接调用；旧 CLI 模块 [cli/feishu-commands](../../apps/remi/cli/feishu-commands.ts)
继续从 `@shared/feishu-commands.js` re-export，保持调用方兼容。命令执行、
任务跟踪和卡片呈现尚在旧 handler，不宣称已完成 transport 全量剥离。

目标调用链：Transport → 鉴权/去重适配器 → Assistant ingress/command/focus service
→ 现有 Chat/Inbox/Q/Task → Assistant presentation policy → Transport send/edit。
Transport 接收规范化 `channel.message` / `channel.card_action`，含 workspace、
binding revision、provider event ID、sender、conversation/thread/reply、附件引用；
身份来自鉴权连接，不能信任 payload 自报 workspace/member。
消息幂等键沿用 workspace+bot+external_message_id，迁移期间不得双写双派任务。
卡片回调须保留原 Q/message_id、route_revision、收件人、一次性令牌与原始用户操作，
不能把“通过 Assistant 转发”当作 member 身份证明。

后续 API：`/api/workspaces/:id/assistants` 管身份与默认执行器；
`/assistants/:assistantId/channels` 管绑定/目标/能力；`/followups` 管随访；
`/routines` 引用 Autopilot。写接口使用现有 workspace operator/资源 guard，
revision 防止覆盖焦点和绑定。旧 `/feishu-bot/*` 配置、状态、daemon assignment 和
回调接口在兼容期继续可用；凭据写入口与 daemon 拉取入口仍由 transport 提供。
新增用户能力时必须同批实现 Registry CLI、manifest 和路由快照，本轮不新增 HTTP API。

## 问题与审批生命周期

1. 新普通消息经鉴权/幂等并确定同一 Assistant 主会话后，只撤回该主会话自己的
   question 类 ask_user；不撤回 Agent 问题、权限、计划审批或别的会话 Q。
   普通文字不解释成审批同意，也不消费旧卡片令牌。
2. 在统一 Q 事务中标记 withdrawn/replied_in_chat，结束 provider wait 并安排新消息；
   Web 与所有已投递 IM 卡片通过同一 outbox 收敛为 ended。撤回后消息发送失败，
   记录消息失败并允许重试，不能复活旧 Q。此语义需要专门扩展现有 Questions 服务。
3. 问题过期用原 Q 的唯一键创建可稍后处理的待办引用；后续答案作为新消息进原会话，
   不伪造原 provider wait 已消费。审批到期只关闭，绝不自动转成允许。
4. 一次卡片操作只回答对应 Q 的当前版本；校验收件人/成员映射、workspace/bot/app、
   令牌有效期与单次消费，重复/旧路由/已结束一律拒绝。沿用现有
   [ADR 0011](../adr/0011-question-card-one-time-token.md) 和
   [统一问题](../dev/questions.md)。Assistant 没有代点审批能力。

以上为后续验收语义；Phase 1 不改变已有问题生命周期或令牌处理。

## Web 信息架构与 Intent

新增独立「助理」入口：主对话 + Task dock + Needs you，共用现有 Chat 消息和 Q。
设置分「默认执行器/监督」「渠道」「随访/例行」。现有「IM 平台 → 飞书」
继续管理应用凭据、连接 Runtime、allowlist、配对和健康，链接到已绑定助理；
助理渠道页展示目标与能力，编辑凭据跳回 IM 平台。

Instant 使用现有工具权限；Auto-start 只覆盖明确授权或受约束的只读任务；
Plan-first 复用统一 Q/计划审批。Assistant 记录 Intent 与 Issue/Task 引用，
不改变 Issue 负责人、上交链或用户已授予授权。Task dock 根据真实任务状态聚合。
北极星事件在成功首次投递用户时写 interruptions，在实际 start/resume 结果写
availability；unknown、历史覆盖起点、渠道重复投递和 probe 分开记录。

## 分期、迁移与回滚

| 切片 | 交付/验收 | 状态 |
| --- | --- | --- |
| Phase 1 | 独立契约；线上调用路径使用 Assistant 路由与命令解析；旧命令和路由兼容；无需 DB 迁移；相关单测 | 本轮实现 |
| Phase 2 | Assistant 表/CRUD/Web 主入口；显式迁移选定 bot 到助理；新建能力开关并接入所有入站/出站路径；main/list 与按操作者焦点 | 未实现 |
| Phase 3 | 消息与卡片 ingress、命令执行、任务跟踪、进度/答案/问答呈现策略移出 CLI/FeishuBotRepo；统一 Q 撤回与超期待办；transport 只做收发 | 未实现 |
| Phase 4 | Follow-up、Routine/Autopilot 集成、监督与简报；Task dock、分级 Intent、打扰/可用性观测 | 未实现 |

Phase 2 迁移必须显式选择身份与主 Chat，不能把不同用户私聊或群 Issue Chat 合并。
新表建立旧 binding 到新 binding 的唯一映射，既有 Chat、Issue、Q、outbox 与去重记录
不重建；旧配置继续读写，映射后的执行器变更在同一事务写兼容投影和 revision。
切流前用影子读取比对目标，但只允许一个写入派发路径。每个 bot 单独开关切流；
未迁移 bot 保持全部旧行为。旧能力只能等价投影，不主动开启全工作区问题或推送。

Phase 1 回滚只回退代码，无需删表/迁数据；后续回滚先停用新调度/入口，确认没有
重复 outbox 与未处理 Q，再回旧适配器，保留映射与审计，不删除用户会话。

## 验证与审阅边界

新增 `assistant-routing.test.ts` 覆盖会话优先级、跨工作区/归档/缺失路由降级、
空会话键和无配置路径。回归使用已有 bot routes、multiple bots、commands、
task handler、stop、config、task bridge、Issue topics、supervisor 测试。
真实飞书、真实 provider、线上迁移与重启不在本轮执行范围；mock/本地 SQLite
通过不代表真实飞书联调通过。实际执行结果在 Issue 评审交接中记录。
审阅重点为 SQL bot 隔离、优先级等价、CLI 兼容、契约是否误导为已发布能力，
以及后续迁移与授权设计；独立审阅由审尺完成。
