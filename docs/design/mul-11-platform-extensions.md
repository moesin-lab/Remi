---
title: MUL-11 平台扩展化架构 RFC
status: draft
summary: 供范围与信任模型决策。建议先试点单 Hub、单工作区的进程外只读事件订阅。
---

# MUL-11 平台扩展化架构 RFC

**建议**：一期只开放一种新的执行契约：把一个经管理员审核的扩展安装到指定工作区，由一个受管 daemon 向其投递一种已提交的事件（试点用 Issue 状态变更，仅含 ID 和状态）。成功标准是能解释每一次投递、撤权和回退。Skills、Provider Plugins 和 MCP 保持原有入口。公共目录、多 Hub 分发、任意第三方代码、同步拦截 Hook 和前端面板留到后续决策。这样能先验证版本、授权与恢复三项共性问题，无需先迁移飞书或重写后端。

**状态**：当前事实限定于 GitHub `moesin-lab/Remi` 的 `d69bc1d46e35c7650a0164caef1f3be379d6ff98`。以下路径及行号均相对该提交。其余章节是建议或待定项。本单只交付 RFC，未进行运行、隔离、负载或跨语言兼容测试。

## 当前事实：入口、所有权与可复用边界

| 机制 | 基线源码与当前行为 | 对新契约的约束 |
|---|---|---|
| Skills | `packages/server/src/api/routers/skills.ts:65–106` 管理和导入；`packages/daemon/src/agent-runtime/skills/ephemeral.ts:95–155` 选择 provider 目录、按任务同步，并记录自身写入的目录。 | 消费者读取文件；启停对应绑定及下次同步。无需让每个 Skill 启动服务，文件也不能自行授予工具权限。 |
| Provider Plugins | `packages/server/src/api/routers/agent-plugins.ts:164–237` 已有版本、激活、回退与 runtime 重试。`packages/daemon/src/agent-runtime/agent-plugins/types.ts:4–35` 定义 Claude/Codex 包、摘要、任务快照及独立连接引用；`packages/daemon/src/agent-runtime/agent-plugins/materialize.ts:115–133`校验 provider 匹配。 | 借鉴不可变制品、绑定与任务固定版本；原生包格式及 provider 登录继续由对应执行器处理。增加模型/Agent Provider 另需会话、流式输出、取消、计费和恢复契约。 |
| 宿主插件 | `packages/daemon/src/agent-runtime/plugins/registry.ts:49–88,112–160,171–187` 按配置发现、同步加载外部模块并注册宿主能力。外部加载有总开关和启用规则。 | 进程内模块可接触宿主环境，只适合受信任部署；启用配置不能充当跨租户授权。 |
| MCP | `packages/daemon/src/agent-runtime/mcp/ephemeral.ts:46–51,81–118` 把 Agent 配置转成 ACP 所用的命令、参数及环境列表，忽略缺少有效命令的项。 | 当前入口提供工具服务器启动描述；工具请求/响应、审批和取消应保留在工具协议，无法据此推导事件日志、安装或回放。 |
| IM / 飞书 | `frontend/packages/core/im-platforms/catalog.ts:5–15` 静态登记飞书；`packages/server/src/api/routers/feishu-bot.ts:475,624–625` 涉及凭据验证与发送者策略；`packages/server/src/feishu-bot/credentials.ts:38–76` 处理加密凭据；`packages/connectors/src/feishu/inbound-recovery.ts:17–25` 区分本地恢复游标和服务端消费回执；`packages/server/src/worker/feishu-outbound.ts:9–36` 以 claim token 续租和报告发送。 | 渠道要映射外部身份、连接、线程和外部消息 ID；持久化入站与外发成功有不同回执。增加菜单项不足以增加渠道。 |
| Webhook / Autopilot | `packages/server/src/api/routers/webhooks.ts:10–36` 以触发器 token 路由、限流并传签名状态；`packages/server/src/api/helpers/webhooks.ts:180–198` 判断签名要求；`packages/server/src/store/repos/autopilots-repo.ts:1913–1929,1962–1971,2020–2053` 处理去重、拒绝、运行结果及人工重放。 | 这是外部请求进入业务自动化。新订阅消费已提交事实，权限、幂等键和回放范围要另行定义；不把每次事件消费变成 Autopilot run。 |
| 控制与执行 | `packages/server/src/api/daemon-protocol/runtime-input-snapshot.ts:37` 下发插件 desired revision；`packages/server/src/worker/daemon-runtime-downlinks.ts:40–46` 按 runtime 接受提示；`packages/daemon/src/agent-runtime/agent-plugins/reconciler.ts:65–85` 恢复、对齐 observed 状态；`packages/server/src/api/daemon-protocol/report-handlers.ts:365–366` 记录执行绑定 ACK。 | 复用 desired/observed 对账及鉴权通道。安装已就绪、帧已收到、业务事件已处理是三个独立条件，现有 ACK 不可相互替代。 |

## 建议：分层与运行形态

| 位置（MUL-10 候选拓扑） | 职责与信任边界 |
|---|---|
| Hub | 校验工作区管理员身份，保存目录、授权、绑定、期望版本、审计与投递账本。业务写入和 outbox 同事务提交；仅 Hub 可将外部输入转为内部业务动作。 |
| daemon | 以已认证 runtime 身份从所属 Hub 对账，验证制品和本机策略，监督独立子进程、限制资源、回报实际 revision 与投递结果。断连停止领取；重连读快照。 |
| link | 若 MUL-10 引入此层，可在设备侧承载连接与转发；只传授权目的地的帧。安装决策、持久游标和跨工作区凭据不下放。没有独立 link 时沿现有 daemon 通道完成试点。 |
| Hub peer | 一期每个安装只有一个权威 Hub。`packages/server/src/api/peer/peer-channel.ts:20–43` 的共享数据库引用及进程内重试有其部署前提。独立 Hub 的配对、路由、防循环和撤权传播由 MUL-10 决定后再开放；一期拒绝跨 Hub 目标。 |

| 形态 | 适用交互 | 收益、成本与决定 |
|---|---|---|
| 本地 IPC + RPC | daemon 启动固定入口，stdin/stdout 各一条有界 JSON 消息流 | 建议一期。使用独立进程便于跨语言和单独终止；需监督子进程、定义超时与消息大小。共享 OS 身份仍可访问其可读文件及网络。 |
| HTTPS RPC / Webhook | 远端服务或 IM 回调 | 无需分发本地二进制，增加远端身份、证书、地址授权、重放保护和网络分区处理；远期单独适配。 |
| MCP 风格工具 | 调用有 schema 的工具、返回结果 | 沿用已有工具栈；工具调用的时限与交互式授权独立于异步投递重试。 |
| 进程内模块 | 随部署发布的宿主集成 | 调用直接，但共享权限、崩溃域及语言 ABI；保留既有受信入口。 |
| WASM / 受限宿主 | 可移植、短时转换 | 可按导入接口限制能力，仍需限制内存、执行量与宿主调用；SDK、系统接口及调试成本待原型验证，推迟。 |

## 建议：制品、安装与协议

目录项引用一份已审核 manifest，并单独固定其摘要；manifest 内的 digest 只覆盖制品原始字节，避免自引用。示例值仅用于说明，单一目标平台用于试点。

```json
{
  "manifestVersion": 1,
  "id": "example.issue-observer",
  "version": "1.0.0",
  "protocol": { "major": 1, "minMinor": 0, "maxMinor": 1 },
  "artifact": { "target": "linux-amd64", "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  "runtime": { "placement": "daemon", "transport": "stdio", "entry": "bin/observer" },
  "subscriptions": [{ "type": "issue.status.changed", "schemaMajor": 1 }],
  "permissions": ["events.issue.status.read"],
  "configSchema": { "type": "object", "properties": { "label": { "type": "string" } }, "additionalProperties": false },
  "secretSlots": []
}
```

安装记录单独保存 `hubId/workspaceId/installationId`、runtime 目标、不可变制品及配置 revision、授权集合、操作者和 observed 状态。包自述权限仅是申请，实际权限取工作区授权、本机策略与声明三者交集。有效授权绑定到安装和具体订阅；扩展上报的 workspace 字段不参与鉴权。

启动先协商 `hello`（双方协议区间、类型与 schema 版本），同主版本取交集最高 minor。未知 manifest 主版本、未知必需能力、无交集或不支持的平台进入 `blocked`。新增可选元数据允许忽略；权限和必需能力遇未知值拒绝。事件新增必填字段或改变已有语义需升事件主版本，试点只投递双方明确支持的版本。包版本只用于标识发布，兼容判断使用协议及 schema。

建议按行传输 UTF-8 JSON，stdout 专用于协议，stderr 接受限长脱敏诊断。协商前采用宿主硬上限，后续只能收紧。`deliver` 携带 `requestId, eventId, subscriptionId, schemaMajor, sequence, attempt, leaseId, deadline, payload`；响应带原请求、租约及 `ack | retry | reject`，机器可读原因可选。`requestId` 每次尝试更新，`eventId` 跨尝试固定。daemon 为子进程注入的租户上下文由已鉴权安装确定。格式错、超限、超时或子进程退出均不推进游标；有界重试后隔离。控制命令和数据投递使用不同消息类型及权限。

### 生命周期与故障恢复

1. **发现与安装**：管理员从 Hub 维护的允许目录选择不可变版本。安装前展示来源、目标系统、权限差异、配置与制品摘要。禁止运行发现脚本；验证可信发布者或经管理员独立核验的固定摘要，安全解包到临时目录（拒绝绝对路径、目录逃逸与越界链接），校验相对入口后原子切换。相同安装请求键返回原结果。
2. **启停**：Hub 以比较并交换更新 `desiredRevision`，daemon 仅在制品、配置、授权与握手就绪后报告该 revision 的 `ready`。离线显示 pending；迟到报告保留审计，不覆盖更新版本。停用立即在 Hub 停发新租约；本地收到停用或离线租约过期后停止子进程。已送出的数据无法收回，在途结果按租约校验。
3. **升级**：并存旧、新只读制品，预检兼容和权限差异；权限增加须重新批准。停止新领取、等待在途到期，再切活动代次，历史事件保留原 schema。旧 daemon 缺能力时保持原绑定运行或待安装，不发送未知命令；已有任务继续使用其固定快照。
4. **回退与卸载**：以新 revision 指向上一已知可用制品、兼容配置和当前有效授权；过期密钥重新绑定，拒绝恢复已撤权限。回退沿用订阅身份与去重历史。试点禁止扩展更改平台数据库结构；有私有状态且无法读旧格式时阻断自动回退。卸载先停发、撤权、清理运行目录，再按保留策略删除配置、投递数据；保留审计。断电重启以 Hub 期望值和已验证摘要重新对账。

### 投递与可观测性

业务事务提交时产生稳定 `eventId` 和最小 payload；按工作区、安装及订阅生成唯一投递记录。事务回滚不生成可见事件。一个订阅内按序串行领取，跨订阅独立；重试阻塞本订阅。Hub 在同一事务内校验当前租约、记录 ACK 并推进连续游标。租约过期重新领取，拒绝旧租约晚到的 ACK。扩展应以 `(installationId, subscriptionId, eventId)` 持久去重，若涉及外部副作用，需目标系统接受同一幂等键或提供可查询回执。发送后崩溃且外部结果不可查，标记为待核对，禁止自动再次产生副作用。

暂时错误采用有上限的指数退避和抖动，永久拒绝或耗尽重试进入死信并暂停该订阅，管理员可核对、按原 ID 重投或记录原因后跳过。设置每安装并发、积压字节、单帧大小与保留窗口上限。慢消费者先暂停领取；达到积压配额时保留业务 outbox 的源游标并标记滞后，避免无界复制。超过源保留窗口则显示缺口，由管理员确认从快照重建或从新位置恢复。禁止静默推进。具体限额与保留时长经负载测量和数据策略决定。

按工作区查看 desired/observed revision、制品摘要、授予权限、最后心跳、握手失败原因、积压及最老事件年龄、重试/死信数量。审计关联安装、revision、event、attempt、租约及操作者；日志仅记录标识和错误类别，默认省略 payload、令牌与环境。延迟/失败率按扩展类型聚合，单次投递用跟踪 ID 查询，避免把消息 ID 当指标标签。

### 安全与配置

一期仅接纳审核过的本地制品。daemon 用独立 OS 身份、只读制品目录、安装专属可写目录、清空继承环境、限制子进程/内存/CPU 并默认禁止出网，缺少所需执行控制时拒绝启动。基础镜像、系统依赖及网络权限需在声明目标上验证。Hub 禁止扩展直连平台数据库或继承 daemon 管理凭据。配置由 Hub 按 schema 校验并版本化；敏感项单列为工作区密钥引用，提交、回显及事件里均无明文。将来确需密钥的适配器按安装和用途解析短时凭证，轮换触发重新协商，记录引用版本，原始飞书 app secret 不因注册订阅而共享。默认事件按租户在发送前投影字段并重新检查授权。即使只投递只读事件，进程仍可能复制收到的数据，故发布者审查、最小字段和主机隔离都是准入条件。

## 建议：演进顺序与验收门槛

| 阶段 | 拟验证的交付与通过条件（均未执行） |
|---|---|
| 0：三单对齐 | MUL-10 提供身份、路由、租约失效与重连边界；本单给出 schema、错误码、版本矩阵和固定报文样例。与 MUL-12 共用黑盒样例：两种语言的读写端对同一报文生成一致判定，含未知字段、错版本、迟到 ACK。Go、Rust、混合或维持现栈均可参加，选型独立。 |
| 1：单 Hub 试点 | 用户授权实施后，在当前栈接适配层，一个审核扩展覆盖安装到卸载。验证事务回滚无事件、重复交付去重、跨租户拒收、越权升级拦截、离线撤权到期、断电对账、坏包与握手失败回退、超限隔离；记录触发输入、双方状态及重启后结果。 |
| 2：混版与容量 | 对旧 daemon、新 Hub 和新 daemon、旧 Hub 分别验证能力协商与旧链路。慢消费者压满队列时其他订阅可继续；记录投递延迟分位数、积压、资源和恢复时长，再确定生产限额。语言迁移若获批，先影子解码与对账，单安装灰度切换唯一写方；回退绑定与路由，禁止双写副作用。 |
| 3：扩展点逐项立项 | IM 先用飞书回执和身份映射做契约样例，再讨论第二渠道；模型/Agent Provider 需可取消、可恢复的执行会话测试；MCP 与 Skill 可先共用只读目录元数据。同步 Hook 需明确业务事务失败策略，前端视图需独立来源、授权数据 API 及内容隔离，WASM 和跨 Hub 分发各自验证后再准入。 |

旧 API、CLI、任务快照和目录可在现有栈继续演进。试点以新增安装记录与适配器旁路接入，旧数据无需批量改写；新写入有独立开关，关闭后仍可读审计并处理未决投递。MUL-10 已发布的基线说明 `sres_bfskpmkvlv4w` 区分共享数据库 peer 和独立 Hub；本次编写时 MUL-12 未发布 Session result。两单都是待决 RFC。公开契约只引用序列化字段和错误语义，不暴露 TS 对象、SQL 行、进程地址或特定语言 SDK。

## 待定：用户决策清单

| 选择 | 推荐 | 接受推荐的代价；选择另一项的前置条件 |
|---|---|---|
| 先开放事件、第二 IM，还是新 Provider？ | 单类异步事件 | 用户暂时不能增加渠道或执行引擎；若渠道优先，先明确账号映射、双向回执和凭据托管，若 Provider 优先，先定义会话恢复与权限提示。 |
| 私有审核目录或开放安装？ | 私有目录、固定摘要和受管主机 | 有人工审核成本；开放安装需独立签名信任、撤销、分发与恶意制品隔离验证。 |
| daemon stdio、远端 HTTPS 或 WASM？ | daemon stdio 作为首个绑定 | 需为选定 OS/架构发布制品；远端需设计网络身份及撤权，WASM 需约束宿主导入。 |
| 单 Hub 归属或 peer 间同步？ | 单 Hub 权威 | 暂无跨 Hub 接管；联邦需 MUL-10 明确命名、重放、重新授权与冲突处理。 |
| 失败时暂停、跳过还是阻断业务写入？ | 异步投递，死信暂停本订阅，人工记录跳过 | 慢订阅可能落后至保留窗口之外；若要求无缺口，需确认可承受存储预算、最长停机与超额时业务写入策略。 |
| 先定协议或绑定后端重写？ | 在现栈冻结试点 wire 样例，语言交给 MUL-12 | 需维护跨实现兼容样例；等待语言结论会推迟试点。生产配额、保留期限及可接受的离线撤权窗口需试点测量与用户确认。 |
