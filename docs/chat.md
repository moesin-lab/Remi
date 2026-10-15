---
title: Chat 私聊与消息队列
status: active
summary: Remi 私聊与外部 Codex 会话的来源、项目分组、续聊和权限边界。
---

# Chat

Remi Chat 是用户与一个云友的持续私聊。可以直接提问、讨论或要求执行工作，无需先创建 Issue。
它不是 Session，但它拥有自己的工作 Sessions；完整对象关系见 [Topic、Chat 与 Session](conversation-model.md)。
独立页面位于 `/<workspaceSlug>/chat`，与其他页面的浮窗共享 Chat 选择和草稿；独立页不再挂载浮窗。
页面可以通过 `?session=<id>` 打开已有聊天，或通过 `?agent=<id>` 开始新聊天。

## 外部 Codex Chat

Chat 页的「外部」入口读取已注册 macOS / Linux Codex Runtime 上的原生会话。按 Runtime、来源和来源 Project
选择历史会话后，可在 Remi 继续同一原生 thread。外部会话不创建 Remi Chat、Agent 或工作 Session，
不进入平台任务调度和日志表；历史与执行状态仍以原生 Codex 为准。

外部页沿用 Chat 的双栏布局：Runtime、来源和 Project 选择固定在会话列表上方，列表与历史各自滚动；
手机端在列表与正文之间切换。Project 筛选记录在 URL，切换 Project 会退出当前会话，避免误向上一项目发送；
按会话分区的草稿仍保留。只有一个有效来源时直接选中并隐藏来源选择器；旧来源失效时仍提供明确的替代来源选择。
会话列表只显示标题和时间，标题栏不常驻路径；Runtime、来源 Home、项目路径和各类 ID 集中在会话信息中按需查看。
输入区使用 Enter 换行、
Cmd/Ctrl+Enter 发送，输入法组合阶段不发送。加载旧历史保留阅读位置，回到最新后恢复自动贴底。

历史渲染复用未变化的轮次和 Markdown，输入草稿、切换滚动提示或展开工具时不重新解析已有正文。
连续的工具、思考等记录按原始顺序归入“执行过程”，默认折叠；展开后可逐项查看详情，正文回复仍在原位置显示。
空白内容块不渲染，裁剪提示与轮次错误保留。原生历史中的本地或相对图片路径只显示原客户端查看提示，
不会向 Remi 网站请求原生机器上的文件，点击图片名称才显示原生路径；绝对 HTTP(S) 图片地址继续按图片展示。
最新历史页仍按运行状态每 2 秒或空闲时每 5 秒刷新；已加载且全部结束的较早页按原生游标缓存最多 30 秒，
新游标或未结束的旧轮立即读取。发送、中断和答复后同时失效最新页与旧页缓存；来源、Runtime、线程和工作区之间不共享历史。

来源由 daemon 扫描当前系统用户拥有的 `~/.codex`、`~/.codex-*` 和自身 `CODEX_HOME`，
按真实 Home 路径去重，来源 ID 绑定目录身份；同路径目录被替换后，旧来源 ID 失效。
API 只接受已发现的来源 ID，不接受 Home、socket、任意原生方法或配置覆盖。
不读取其他系统用户的目录，凭据和完整配置文件不上传。来源 Home 及项目路径用于只读展示。
工作区人类操作者沿用 Runtime 的共享权限；任务和 daemon 凭据不能读取或控制外部会话。

原生 Project 的名称和 roots 由 Codex 的项目目录提供，保持只读。没有原生 Project 归属的历史会话
按精确工作目录分组，标记为「按目录发现」，不会据重叠 roots 猜测归属、按远端地址合并不同工作副本，
或写回原生 Project。每个来源目录扫描有数量上限；达到上限或某个来源不可读时展示警告，不能将部分结果称为完整目录。

读取使用原生 metadata 和有界历史分页，不恢复线程。原生服务已运行时，经其本地控制 socket 接入；
没有可用原生服务时使用同一来源 Home 的独立 Codex app-server。仍在运行但连接失败的服务不会被另一进程替换。
继续聊只调用原生 `thread/resume` 和 `turn/start`，不新建、复制或 fork thread，不注入云友提示词、
连接 Profile、AGENTS 或 Skill。未选择模型时保留原生模型和思考强度；provider 和工作目录来自原生 metadata；
权限与其他运行设置由原生 Codex 按其恢复规则解析，不能用当前 Project 配置冒充历史轮设置。
续接失败、来源离线、writer lease 冲突或版本不支持时明确报错，不冷启动一个替代会话。

模型选项通过所选来源的原生 `model/list` 分页读取，与能力组或其他来源的目录分开。
选择模型只影响下一次发送：daemon 先确认模型仍在该来源的可见目录，再向同一 thread 的 `turn/start`
传入 `model`。已知的原思考强度被新模型支持时保留，否则使用该模型目录中的默认强度。
该覆盖由原生 Codex 保留到后续轮次，不改写 Home 配置；切换失败不自动尝试其他模型。
原生模型目录可能来自缓存，列出选项不等于已验证推理权限。历史模型不在目录时仍可沿用原生设置续聊。
模型读取与带模型发送要求 Runtime 广告 `external_chat_models: 1`；旧 daemon 只能使用原生设置续聊。
运行中、发送中或发送结果尚未确认时锁定选择，切换会话或来源不会沿用上一会话的待发送模型选择。

Remi 拒绝已知 active 线程的新输入，同一线程在本产品内串行处理发送；本连接发送的上一轮即使已收到 ACK，
仍需确认原生终态后才能发送下一条，暂缺历史和 unknown 回执都不能作为结束依据。原生接口没有跨客户端的
「仅在 idle 时发送」原子条件：状态读取后若 Codex App 同时开轮，输入仍可能成为原生插话。
继续聊时应等原客户端完成当前轮，避免两边同时操作。只能停止明确的原生 turn，不能把取消等同于撤销已执行的工具操作。
本连接收到的命令、文件、权限审批和用户提问可在 Remi 答复；原客户端已持有的等待仍需回原客户端处理。

共享原生服务会向多个客户端广播请求，收到回调不等于由 Remi 独占处理；普通回调的首个答复（包括错误）会消耗请求。
因此 live 连接对客户端专属工具、认证回调，以及超出完整展示预算的请求不自动答复，交由原客户端处理，
避免抢先拒绝原客户端正在执行的工具。独占 stdio 进程没有其他客户端可接手，仍对不支持的请求返回明确错误。
这类回调不再永久阻断历史读取或后续空闲轮次；能否继续发送仍以原生运行状态和本连接上一条输入的终态为准。
Remi 不自动执行客户端专属工具、不刷新原生认证、不批准裁剪后的命令或权限；live 无可用原客户端处理时仍需回原客户端解决等待。

发送使用客户端生成的 `request_id` 和 daemon 持久回执。断线或超时可能发生在原生接受输入之后，
因此结果为 `unknown` 时不自动重发，先按原生消息的 client ID 对账。同一个请求 ID 不能绑定不同正文、线程或模型。
原生读取有独立条数和字节预算，优先保留最近的用户消息与助手回复，再展示工具输出；
裁剪的输出明确标识，分页不等于一次返回完整历史。

接口见 [外部 Chat 路由](../packages/server/src/api/routers/external-chats.ts)，
类型见 [共享契约](../packages/contracts/src/external-chats.ts)，
本机接入见 [Codex driver](../packages/daemon/src/external-chats/index.ts)。
CLI 使用 `remi chat external sources/models/list/get/send/receipt/interrupt/respond`，`send --model` 可显式选择模型，参数由 Registry help 生成。
普通 Remi Chat 的工作位置、消息队列与管理操作继续遵循以下契约。

## 页面与侧栏

独立页没有页头横幅。会话头显示 Agent 头像、会话标题和已绑定的工作位置（Project 或 Runtime 目录名）；新聊天和历史都在左侧栏。浮窗保留原来的「⊕」按钮和会话下拉。

侧栏顶部是「新聊天」和「搜索」，「搜索」打开全局 Cmd+K。可滚动区按「置顶 / 项目 / 最近」分区：

- 置顶会话只出现在「置顶」，不论绑定在哪里；
- 绑定 Project 或 Runtime 目录的会话只出现在对应分组，不在「最近」重复。分组按其中最新的会话排序，先显示 5 组、每组 5 条；
- 「最近」是没有绑定位置的会话，先显示 10 条。

「显示更多」每次加 10 条；只会隐藏 1 条时直接全部显示。分组标题悬停时出现「+」，新聊天直接带上该 Project 或目录。

每行只显示 Agent 头像和标题，不显示时间和第二行；运行中显示 spinner，等待人工回答显示「待回答」，有未读回复显示蓝点。悬停或键盘聚焦时，状态位换成「归档」和「⋯」菜单；右键打开同一个菜单：重命名、置顶或取消置顶、停止运行（仅运行中）、归档（「已归档」列表里为恢复）、删除。

- 运行中的会话归档前要确认，因为归档会在服务端停止这一轮；空闲会话直接归档，并给出可撤销的提示，撤销即恢复为活跃。
- 删除需要二次确认；删除当前打开的会话会清空选择。

侧栏底部的「自动化」「已归档」切换到对应列表：「自动化」列出未归档的自动化 Chat，有未读时入口带圆点；「已归档」列出工作区内用户对话和自动化的已归档 Chat。

全局搜索的「聊天」分组只在面板打开时读取会话列表：按标题匹配（不区分大小写），最多 9 条，活跃会话在前，选中后打开该会话。

会话区不显示消息信封头（收件人、消息类型、唤醒方式）。用户消息没有唤醒 Agent 时，气泡下方留一行原因。失败或取消的轮显示状态和失败原因，并提供「重试」「在新会话中重试」和执行记录入口；已完成轮不显示状态文字。Chat 不再显示尝试列表。重试由通过入口鉴权的人类操作者发起，服务端按实际 owner 核验工作区，只接受失败或取消、且同一会话没有其他活跃轮的轮；规则见[消息接口](dev/message-api.md)。

普通 Remi Chat 每轮最终回复之前的过程（命令、文件改动、网页搜索、工具调用、中间说明、上下文压缩、子代理、计划）收在回复上方的执行步骤里：

- 运行中标题不到 1 秒为「处理中」，之后为「已处理 {时间}」并每秒更新，默认展开；最终回复开始输出时改为「用时 {时间}」并收起，不等这一轮结束。正在停止的轮显示「{时间} 后已停止」。运行中不再另显示状态条；状态条只在执行记录还没开始（排队、派发、离线、等待目录等）、读取失败，或等待人工回答时出现。
- 一条命令按解析出的动作各占一行（读取、搜索、列目录、运行）；模型给命令写了说明（Claude 的 Bash description）时整条命令只占一行，以说明为行文字，命令留在详情里。一个文件改动一行；连续两行以上收成一组，默认收起，摘要按固定类别顺序写成「已读取文件，运行了命令」，不显示数字。思考不单独成行，只在运行中替代「正在思考」显示思考摘要的最后一行；当前动作用静态图标加扫光，每个动作至少显示 1 秒。失败的命令仍写「已运行 …」，退出码在详情里；被引导或停止打断的命令（没来得及返回结果，或正在运行时被中止）写「已停止 …」。后台运行的子代理在本轮结束前显示「后台运行中：…」。
- 点开命令看到完整命令、输出（停在末尾）、「成功 / 已停止 / 退出码 N」和复制按钮；点开文件改动看到该文件的 diff 和增删行数。
- 已结束的轮只在完成摘要记录了过程条目时显示折叠的「用时 {时间}」，点开才读取执行记录，折叠里也有执行记录入口；更早的轮不显示折叠，执行记录入口在回复下方，悬停或聚焦时出现。失败或取消的轮把折叠放在失败提示上方，执行记录入口留在提示里；取消的轮折叠标题为「执行步骤」。

输入框右下角的圆环显示上下文窗口占用：只画环，不显示百分比，达到 90% 变红，悬停显示「已用 / 总量 · 百分比」。运行中跟随这一轮的实时上报，空闲时读取最近一轮结束时记下的占用，刷新后仍显示；一轮刚结束、它的卡片还没到时保留最后一次实时值，不回落到上一轮；没有数据时隐藏。

## Chat 与上下文

新聊天选择 Agent，首条消息或首次附件上传时创建会话。每个会话绑定一个 Agent，切换 Agent 会开始新聊天。
新聊天通过工作位置选择器选择 Project 或 Runtime 本机目录，两者互斥；也可保持纯对话。首次发送或上传附件创建会话后，位置选择固定，需要更换时新建 Chat；已有会话只在确有位置绑定时显示该行，纯对话不显示「无项目」位置条。Runtime 目录的绑定与保留规则见 [Runtime 工作区契约](dev/runtime-workspaces.md)。
选择 Project 后使用其指令、资源、Memory 和 Wiki。绑定的 Project 被归档或删除后，下一轮清除旧执行上下文，在平台 Chat 目录冷启动为纯对话；之后正常续聊。
界面显示「已绑定的项目不可用」，旧真实目录和已有仓库文件保持不动。历史列表不提供按 Agent 或 Runtime 的筛选。
Chat 与 Issue 独立：在聊天里创建 Issue 只创建工作项，不绑定会话，不继承该 Issue 的项目、仓库、附件或 Wiki 上下文。
任务领取中的只读 `chat_project_id` 来自 Chat 显式选择的项目；仅保留与该 ID 匹配的项目提示词和资源，不从历史 Issue 推导项目。
Web Chat 和飞书一对一私聊不接收 Issue 活动播报；飞书群里的 Issue 话题由飞书绑定表记录归属。Issue 最后一个在跑任务结束时（完成、失败、取消均算），系统将带触发任务 ID 的报告信封写入绑定 Chat 的会话日志，转述任务自行阅读 Issue 日志并回帖；同一触发任务的信封去重。
飞书 Issue 话题不出现在 Web/CLI 的 Chat 会话列表和待处理列表中，其讨论与更新保留在 Issue 话题入口。
升级时，缺少确定归属证据的历史群关联需要管理员按[迁移手册](migrations/chat-issue-decoupling.md)审计并恢复；恢复前暂停该关联的 Issue 通知。

Chat 支持重命名、置顶、归档、恢复和删除。归档会停止未完成的运行并禁止继续发送，恢复后可继续聊天。
删除会移除 Chat 及消息，并取消未完成运行。列表提供最新消息、未读数及运行状态；置顶 Chat 优先。

## 工作 Sessions

Chat 创建时同时建立自己的 `Main` Session。顶部「工作 Sessions」入口管理这个 Chat 的工作会话：
查看或新建 Session、从同一 Chat 的 Session 建立旁聊、向云友发送定向 request，并查看消息、
轮状态、人类请求和执行过程。发送回执证明消息已保存；实际是否开轮、合并待办或降级，
以 `wake_applied`、`wake_reason`、`turn_id` 和后续轮状态为准。

这些 Sessions 由当前 Chat 拥有，可以独立于 Issue 工作；关联 Issue 只提供工作投影，私聊权限仍跟随 Chat。
Issue 也有自己的 `Main` 与额外 Sessions，从 Issue 入口创建工作无需先建 Chat。两种所有权及生命周期详见
[对话与工作会话模型](conversation-model.md)。

普通 Chat 输入框向 Chat 对话发送统一消息，继续使用 Chat 的消息序列和 lane；输入不会自动进入工作 Session。
工作 Session 使用自己的消息序列、轮和 lane，其终态更新不会替换普通 Chat 的当前轮或未读消息队列。
没有 Issue 工作投影的工作 Session 与普通 Chat 共用 checkout，领取执行时跨云友串行预约目录；独立队列不代表可以同时修改同一目录。未知 offer 保留预约，确认拒绝后释放；Runtime 工作区沿用自己的目录预约。

## 项目仓库与工作目录

显式选择 Runtime 工作区时，Chat 使用注册的本机目录，不附加 Project 仓库，也不自动 clone、fetch 或切换分支。
未选择任何工作位置的 Chat 保持纯对话，仓库按需通过 `remi repo checkout` 获取。
Project 配置了 `local_directory` 时，Chat 在该真实目录执行，启动不会自动 clone、fetch 或修改 Git 工作树；
Wiki 使用 CLI 访问，既有 `.multiremi` 任务元数据仍会更新。

同一 Project 可在不同 daemon 上配置多个目录。唯一选择规则是资源列表按 `position, created_at, id` 升序
排序后的首个 `local_directory`；路由、执行指纹、旧目录匹配和 daemon 都消费
[`selectChatLocalDirectory`](../packages/contracts/src/chat-local-directory.ts) 的同一个选择。
daemon 只校验本机是否持有所选目录，不能跳过首项改用列表里的本机目录。
已使用的选择发生变化时，已有 Chat 在 `chats/<id>` 冷启动一次，后续正常续聊；
旧用户目录保持不动，不进入替换目录。只有新建 Chat 才采用当前选择。

目录选择变化的检查清单（指纹比较所选 daemon 与规范化 path，不比较整个集合）：

| 操作 | 选择及已有会话行为 |
| --- | --- |
| 新增第一个目录，或新增排在当前项之前的目录 | 选中项变化，已有会话留在/转入托管目录 |
| 删除当前项，包括删除最后一个目录 | 选择下一项或空值，已有会话转入托管目录 |
| 调整任一项 position，使首项变化 | 新首项改变指纹，已有会话不进入新目录 |
| 同 position 下 created_at 次序变化（例如删除后重建） | 遵循资源列表的次序，与路由及 daemon 一致 |
| 修改选中项 local_path 或 daemon | 选中赋值变化，已有会话转入托管目录 |
| Project 归档、删除或不可用 | 可用选择变空，同时清除旧项目上下文 |
| Project 恢复、重新添加目录 | 托管模式保持；已有会话不重新取得用户目录权限 |
| 修改 label、非目录资源，或修改/增删/重排未影响首项的目录 | 选中赋值不变，不因此重置会话 |
| 路径仅作等价规范化、position 数值变化但首项不变 | 选中赋值不变，不因此重置会话 |

资源类型不能原地修改，类型替换通过删除再新增处理。`project_ref` 不继承本地目录。
`position` 与 `created_at` 完全相同时，以唯一资源 `id` 升序打破并列，保证重复查询的选择稳定；
调用方保持此顺序，不增加另一套排序规则。

其他绑定 Project 的 Chat 在 daemon 的 `work/<chat_session_id>` 目录运行（位于 `MULTIREMI_WORKSPACES_ROOT` 下，见[存储与保留](dev/storage-retention.md)）。
首次使用时自动拉取 Project 显式声明的 `github_repo`（包括 `project_ref` 引用），
不会因 Project 未声明仓库而自动拉取整个 workspace 的目录清单。
工作分支为 `chat/<chat_session_id>`；已有 worktree 后续轮次直接复用，保留本地改动，不重复 fetch。
需要刷新或重试失败仓库时使用 `remi repo checkout <repo-id>`。

自动同步按仓库串行执行，共享 120 秒网络预算；daemon 环境变量
`MULTIREMI_REPO_CHAT_STARTUP_TIMEOUT_MS` 可指定 1–2147483647 的整数毫秒覆盖该预算。
已有 bare cache 的刷新最多占用 30 秒，也受总预算约束。Issue 的同步预算不受此配置影响。
启动过程中 Chat 显示仓库准备进度；鉴权、网络或超时失败会保留之前成功的仓库，继续启动对话，
并在智能体提示词中记录失败原因与手动获取指引。该网络预算不包含本地 worktree 文件落盘耗时。

项目绑定在创建时固定。自动准备不会删除已有仓库，也不会覆盖同名的其他目录；
Project 资源列表变化或项目不可用时，已有工作副本保留。

## 消息与执行队列

消息写入对话日志。正在运行的轮收到定向的 now 消息会插话；pending 轮合并后续消息，领取时读取连续输入范围。同一 lane 只有一个 pending 轮。
运行中有两种后续发送方式，取舍见 [ADR 0020](adr/0020-chat-follow-up-queue-and-native-steering.md)：

- **引导**：普通发送 `POST /api/sessions/:id/messages`，`wake_requested:"now"`，行为不变，送进正在运行的这一轮。Claude 与 Codex 的 daemon 用桥的原生引导把它注入正在进行的 prompt，不打断正在运行的命令（Claude 等当前工具调用结束后再注入，最多 30 s）；桥不支持、出错、这一轮恰好结束，或有待回答的权限或提问卡片时，退回到中止当前 prompt 后在同一会话重新提示（[ADR 0020](adr/0020-chat-follow-up-queue-and-native-steering.md)“原生引导”）。未读消息可用 `PATCH`/`DELETE /api/messages/:id` 编辑或删除，已进入轮输入的返回 409；编辑和删除留下日志标记。
- **排队**：`POST /api/sessions/:id/queue` 把消息存进服务端队列表，不写对话日志。lane 没有 pending、running 或 awaiting_human 轮且未暂停时立即放行；否则在当前轮 completed 的终态事务里按入队顺序放行。放行把每条转成普通成员 now request，第一条建 pending 轮，其余合并进同一轮，正文全部内联；它们排在本轮回复之后进入日志。

排队的条目只有原发送人能改：`PATCH .../queue/:qid` 可带 `expected_revision`，`DELETE` 幂等，`POST .../queue/:qid/steer` 立即放行这一条（改为引导，重复调用返回同一条消息）。
已被轮放行的条目再改或引导返回 409 `queued_message_consumed`，版本不符返回 409 `revision_conflict`，归档的 Chat 入队、引导和继续返回 409。每个 Chat 最多 50 条未放行条目，每条最多 10 个附件。

队列会暂停。`interrupted` 与 `send_failed` 期间轮结束也不放行；`turn_ended` 在该 lane 下一次有轮 completed 时自动解除并放行：

| 原因 | 触发 | 解除 |
|---|---|---|
| `interrupted` | 成员停止当前轮（`POST /api/turns/:id/cancel`） | 只由 `POST .../queue/resume` 解除，期间轮 completed 也不放行 |
| `turn_ended` | 轮 failed，或被成员以外的身份（agent、supervisor 等）取消 | 该 lane 任一轮 completed（包括失败轮重试成功、之后的直接发送完成）时自动解除并放行；或 resume |
| `send_failed` | 放行某条失败；该条标为 failed，后面的条目不越过它 | resume，或编辑、删除、引导该条后不再有 failed 条目 |

resume 清除暂停、把 failed 条目重置为 queued，lane 空闲时全部放行；队列为空时暂停自动清除。
归档时被取消的轮既不放行也不暂停；恢复后条目保留，resume、下一次入队或下一轮 completed 时放行。`wake=next_turn` 的含义不变，仍不会单独补铃。
Web 输入框运行中按偏好（设置 →「偏好」→「聊天」，默认引导）发送，⌘↵ 用默认方式，⌘⇧↵ 这一条换用另一种；空闲时都是普通发送。排队的消息显示在输入框上方的队列里，可逐条引导、编辑（载入输入框，保存时带 `expected_revision`）或删除（5 秒内可撤销）；暂停时显示原因和「继续」。没有 API 应答（网络错误、超时或网关 408/502/503/504）的排队请求标为无法确认送达，不自动重试。前端实现见[前端开发上下文](dev/frontend.md)。

收尾用 turn wrap-up，取消用 turn cancel，重试在同一轮新增 attempt。取消不撤销已执行的工具操作。
输入框在发送失败时保留草稿，删除失败时保持会话选择。

聊天记录与 provider 会话是两层状态。正常续接复用既有运行上下文，输入范围从当前 agent lane 的实际读游标开始，
包含尚未读取的请求和编辑后的 next_turn 正文，过滤已删除消息；无法续接时，Remi 使用有预算的聊天历史投影，
截断会被标识。不能据此承诺每轮携带完整历史或底层工具的全部工作记忆。

内部恢复入口可为尚无已完成谱系的首轮显式提供 Runtime、provider session 与工作目录；领取时保留这些初始值，后续用户轮使用已完成的 Chat 谱系。飞书 transport 的亲和性仍按其绑定刷新。

只读飞书 Issue 话题保留所属 Project 的仓库展示目录，自动 checkout 仍使用独立的显式仓库清单。

自动终态回复发给工作区统一操作者，成功结果和最终失败进入共享收件箱。
Chat 列表与收件箱使用共享已读游标，并按原收件人的旧 member lane 保留历史已读状态；读到较早消息仍保留最终回复未读。

## 权限与实时更新

通过平台入口鉴权的人类操作者共享工作区 Chat；历史创建者字段保留审计，不再限制人类读写。
消息范围读取 `messages?from&to`、单条展开 `log/entry`、定位 `log/locate` 和 `log` 窗口允许任务凭据读取自身绑定的 Chat，
前提是任务、凭据与 Chat 的工作区一致；飞书个人机器人 Chat 同样适用。任务凭据访问同工作区其他 Chat 返回 403，
即使目标创建者是凭据中的用户或 Runtime owner，也不回退到创建者权限。未绑定且不存在的会话同样返回 403；
已删除的 Chat 不能通过留存 attempt 或轮继续访问；详情与列表沿用统一接口的不可见过滤规则。
人类 PAT/JWT 使用统一工作区操作身份，账号身份继续用于登录与凭据管理。
范围读取按凭据中的 agent 记录实际已读进度，定位、窗口和单条展开不推进该进度。
消息、附件、attempt trace 和实时订阅各自保留对应权限检查，不能只依赖页面隐藏。
任务详情与控制接口、云友任务列表同样检查私聊权限；Issue 分享不包含 Chat 的输入与执行记录。
删除会话后，留存任务继续保留私聊标识以拒绝读取，也不能通过复用旧会话 ID 重新取得这些记录。
工作区选择沿用服务端统一解析规则：显式工作区参数优先，其次为请求头和凭据绑定的工作区。
聊天列表、创建和待处理任务在解析工作区后继续校验资源归属与凭据范围；未知 slug 不回退到 `local`。

服务端数据由 Query cache 管理，草稿和选择由工作区分区的 store 管理。WS 更新保持当前执行任务与后续队列分离，
取消某条排队消息不能清除另一条正在执行任务的状态。队列的每次变更、放行和暂停在提交后发送 `chat:queue_updated`，向有权读取该 Chat 的人类操作者推送；放行的消息经普通日志流到达。
已上传附件的草稿绑定与文本一起按工作区保存，切换浮窗、独立页或会话后仍可发送。

## 归档、来源与自动化 Chat

Chat 是 daemon 存储模型里的一类主体（见[存储与保留](dev/storage-retention.md)）：被归档即视为结束，工作区按保留期回收，置顶的 Chat 不回收。
活跃 Chat 超过工作区设置 `chat_idle_days`（默认 14 天，0 为不自动归档）没有新消息会被自动归档；归档的 Chat 收到新消息（成员、飞书或自动化续接）自动恢复活跃。
`run_only` 自动化每次运行新开一个 Chat，带 `origin: { autopilot_id, run_id }`；agent 判断没有值得报告的内容时执行 `remi automation quiet`，运行完成后该 Chat 自动归档，否则保持活跃并带未读。
Chat 列表默认只显示用户的对话，`origin=automation|all` 或 `remi chat list --origin automation|all` 查看自动化开的 Chat；独立页侧栏通过底部「自动化」入口查看。

## CLI 与验证入口

```bash
remi chat create --agent <id>
remi chat create --agent <id> --project <project-id>
remi chat create --agent <id> --runtime-workspace <runtime-workspace-id>
remi chat update <chat> --title <title>
remi message send <chat> --to <agent> --content-file <path>
remi chat pin <chat>
remi chat unpin <chat>
remi chat archive <chat>
remi chat restore <chat>
remi session list <chat>
remi session create <chat> --title <title>
remi message send <session> --to <agent> --kind request --content-file <path>
remi message list <session>
remi turn list --session <session>
remi message list <chat> --unread-by <agent>
remi message edit <message> --content-file <path>
remi message delete <message> --yes
remi inbox read <chat>
remi turn list --chat <chat>
```

接口实现见 [Chat 路由](../packages/server/src/api/routers/chat.ts)、
[ChatRepo](../packages/server/src/store/repos/chat-repo.ts) 和
[任务领取](../packages/server/src/store/repos/tasks-repo.ts)及[统一消息接口](dev/message-api.md)。前端入口见
[Chat 视图](../frontend/packages/views/chat) 与 [core/chat](../frontend/packages/core/chat)。
验证方法遵循[测试指南](../TESTING.md)；`bun run smoke:chat` 启动隔离浏览器测试。
单元测试、浏览器冒烟和真实 provider 执行分别报告结果。
跟进队列的 Store 状态机与 HTTP 鉴权、错误码分别由 `tests/unit/multiremi/inbox-chat-follow-up-queue.test.ts` 和
`tests/unit/multiremi/multiremi-api-chat-queue.test.ts` 覆盖，配置 `MULTIREMI_TEST_POSTGRES_URL` 时同时跑 PostgreSQL。
`tests/integration/daemon-protocol-v2/chat-unread-consumption.test.ts` 使用隔离的真实 daemon、API、SQLite、
ACP 子进程与 CLI 范围读取，回归连续 warm 输入和 next_turn 编辑/删除的消息 ID、正文哈希、读取次数与持久回执。
该测试使用测试 provider，不调用真实模型，也不代替 PPE 或浏览器验收。

外部会话可运行 `bun run tests/integration/external-codex-chat.ts`：使用已安装的固定版本原生 Codex CLI、
临时 Home 和本地 Responses fixture，经真实 daemon 协议及 API 验证原线程续聊、模型和目录保留、重复请求去重，
以及不创建 Remi Project / Chat、不改写来源配置。它不读取用户会话、不调用外部模型，不能代替线上 UI 验收。
