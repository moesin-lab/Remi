# MUL-10 · Hub、daemon、link 与独立 Hub 互联

**状态：提请用户决策。** 建议保留 daemon v2 的单连接与本地执行模型，先让一个 Hub 能显式授权一个 daemon 上的具体 link，再让两个独立 Hub 双边配对。首次联邦仅开放只读发现，远程执行另设准入门槛。Persona 的版本、资料及对应概念待提供；本方案的依据是 Remi 源码和以下故障假设。

## 基线与缺口

源码定位固定于 `d69bc1d46e35c7650a0164caef1f3be379d6ff98`。下表描述实现；后文均为提案。

|对象|当前连接、状态与数据流|演进缺口|
|---|---|---|
|Server|[claimTask](../../packages/server/src/store/repos/tasks-repo.ts#L3346) 在事务内按 workspace 加锁并复核 runtime、能力和 drain；[offer pump](../../packages/server/src/api/daemon-protocol/task-offers.ts#L318) 按在线 runtime 取任务，复核 dispatch 后发送 `task.offer`，按应答接受、超时撤回或重新排队，恢复时对账 active IDs。DB 是下发依据。|本地锁覆盖同库并发；独立库之间需要指定每个对象的写入方。|
|Local Daemon|一个进程用 daemon 凭据连 `/api/daemon/ws`；[握手](../../packages/server/src/api/daemon-protocol/handshake.ts#L64) 携协议版本、daemon ID、runtime 列表及能力；[服务端](../../packages/server/src/api/daemon-protocol/index.ts#L418) 核对归属并在心跳更新前重验权限。[客户端](../../packages/server/src/worker/daemon-protocol-client.ts#L462) 汇总各 lane 状态；[契约](../../packages/contracts/src/daemon-protocol.ts#L1106) 定义 15 秒心跳。|已经能复用一条连接；还需绑定具体适配器实例的能力、权限和撤销。|
|Runtime|同一进程可声明多个 runtime，按 `rt` 定向。offer 准备时签发任务凭据；执行侧[持久 outbox](../../packages/server/src/worker/outbox.ts#L99) 重试可靠上报，[trace 泵](../../packages/server/src/worker/trace-streamer.ts#L31) 独立推进游标；[trace 处理器](../../packages/server/src/api/daemon-protocol/trace-handlers.ts#L38) 实现订阅、读取和归属校验。|调度用的 runtime、实际运行 attempt 和外部渠道连接有不同生命周期。|
|Cloud Node|[HTTP 路由](../../packages/server/src/api/routers/cloud-runtime.ts#L17) 声明 local 模式，列举按 owner 过滤，start/stop 更新状态；[存储实现](../../packages/server/src/store/repos/cloud-runtime-nodes-repo.ts#L18) 创建本地实例记录、更新状态，exec 返回格式化回显。|节点记录的 `running` 无法证明机器、daemon 或执行器就绪；云主机仍须完成普通 daemon 注册才能入选。|
|现有 peer / Live Hub|[实时扇出](../../packages/server/src/api/peer/peer-channel.ts#L1) 在共享数据库的 API 进程之间用共享密钥投递，有界重试、接收方重启后去重记忆消失；超限事件可退为共享库引用。|独立 Hub 无共享库、管理员或密钥。需要独立端点、持久去重和明确披露范围。|

## 单 Hub 与设备协议

Hub 持有 workspace、授权、路由、任务意图和审计。daemon 是设备上的长生命周期代理，主动出站连接所属 Hub，管理本机凭据、并发、落盘、恢复与各 link。link 是 daemon 注册的适配器实例，可随配置启停；调用上下文绑定 workspace、实例、操作与 attempt。一个执行 link 可以对应既有 runtime，一个收消息的渠道 link 只获准提交入站事件。同机多个 provider 可分别注册，多个设备各有 daemon 身份。外接执行器经 daemon 的受限代理调用，外部账户密钥留在设备密钥库。业务组织模型不因设备离线而迁移。

1. **登记与协商。** 管理员签发限 workspace、单次、短期的登记票；daemon 在 TLS 内兑换可轮换设备身份。沿用 v2 hello/welcome、版本拒绝与升级路径；新增可选 `link.inventory.v1` 能力。协商成功才发送完整清单及单调 `inventory_revision`，包含实例 ID、种类、契约版本、操作、并发及健康。Hub 将声明与已授予权限取交集；替换清单原子退役缺席实例，旧 revision 丢弃。旧客户端继续走原 runtime 路径。
2. **在线与恢复。** 注册后 `ready → draining/offline → reconciling → ready`；心跳关联连接代次，心跳超时隔离路由，旧连接帧不能恢复就绪。临时网络失败用带抖动的指数退避；撤销即停，升级拒绝走既有升级流程。重连交换 active attempts、累计确认和清单版本，先拉取取消/撤销和终态，再恢复 offer。设备不得离线领新任务；已获准执行仅在授权期限内继续，到期冻结外部写入并报告待对账。
3. **路由与执行。** Hub 在原 workspace 并发、runtime 选择和 drain 校验之内匹配 link 的操作、版本和配额。offer 附 `attempt_id, link_id, operation_id, fence, expires_at`；接收端先持久化唯一执行收据，再接受和启动。相同操作与参数重取收据，重用键且参数不同则拒绝。超时可重送同一操作；只有上一执行确定未启动、已停止或外部系统可兑现 fencing 时才可改派。不可幂等外部调用在“已发出、结果未知”时转人工核对，不能承诺外部副作用恰好一次。
4. **事件与回放。** 心跳可合并；完成、失败、取消回执先进设备 outbox，接收方事务性写入效果及去重记录再 ACK。trace 由执行设备按 attempt 保留，以 `(attempt_id, stream_id, after_seq)` 续读，连续序号才推进游标，重复丢弃，缺口按页补读。慢订阅者被暂停，超保留期返回 `cursor_expired` 和可用范围；索要快照后从快照水位恢复，已清理的历史显式标缺。限制每页字节数、每流积压与租户总量，控制及终态先于 trace；磁盘不足停止接单并报告，保留未确认的可靠记录。

## 独立 Hub 互联

**信任。** 双方管理员通过带外核对 Hub ID、公钥指纹和允许的地址，兑换绑定双方身份、限时单用的配对挑战；两边批准后通过 mTLS 建连。Hub ID 稳定，证书可轮换；更新需既有信任证明或重新人工配对。发现只读显式配置的直连目录，不自动探测、接受转介或继承第三方信任。配对仅建立身份。另行双边授权精确映射源、目标 workspace 和资源、操作、方向、期限及数据类别；同名 workspace 无隐式映射。两端逐请求校验本地 ACL、委托主体、目标受众与授权版本，续订阅也重验。撤销先在本端持久禁用并关闭相关流、停止新操作；远端离线时短租约限制残留权限，恢复先同步撤销，重新配对不能复活旧授权。

**拓扑。** 星型便于统一审批，但中心失联影响所有辐条；全网状可直接互通，但每对节点都要维护授权；按需双边联邦仅为明确的合作关系建边，可呈星状。建议首版限一跳，不设中转 Hub 或全局调度器。请求目的地必须是连接对端，来源须匹配认证身份，跳数限一，禁止再导出远程目录。未知目的地、回环和过期请求均在派活前拒绝。

**写入与恢复。** 发起方作为任务 owner Hub，唯一推进业务状态；目标 Hub 是执行收据、目标端准入与其 daemon 租约的权威。引用使用 `(owner_hub_id, workspace_id, object_id)`。owner 先在本地事务写入任务与待发命令；目标事务以 `(source_hub, grant_id, operation_id)` 去重并记录参数摘要、状态及本地 attempt 绑定，之后才 ACK。ACK 表示目标已持久接收，完成须回传独立结果。取消也有持久收据；终态以 owner 的版本条件更新，迟到结果保留审计。目标先核对 fence，再派本地 daemon。outbox 重送直至确认或截止；保留收据至最大重试窗之后，过期消息永不重新执行。若撤销发生在开始之后，取消尽力投递，已发生的外部效果单列对账。

**同步与隔离。** 默认只交换不含内容的授权能力摘要、容量档位及过期时间，只读目录仅作候选，接单时再验容量。远程执行须另授最小任务输入和结果字段；原始 trace 默认留执行端，仅经有权限的按需流读取。不转发原始 daemon/用户 token、仓库凭据、完整日志或 workspace 镜像。投影携 owner revision 和水位；缺号从 owner 补读，过期重取授权范围内快照。owner 不可达时投影显示过期时间，只允许已授权的有限本地善后；无人自动提升为 owner。单 Hub 事故恢复使用同身份备份并隔离旧实例，确认唯一写者和新 fence 后才开放写入。无法证明旧实例停写则保持只读。各 peer 按 workspace 限速、限流和独立熔断，审计关联两端 request、grant、attempt、结果及拒绝原因，日志省略正文和秘密。

## 演进与验收门槛（待执行）

|阶段|需验证的反例与通过条件|切换与回退|
|---|---|---|
|0 协议冻结|发布语言无关字段、错误、身份作用域及正反例；两种独立编解码器往返相同，拒绝未知必需特性。MUL-9 提供对象引用，MUL-11 提供 manifest/进程外契约，MUL-12 据此估算迁移。|仅样例，不迁移数据；业务组织与语言选择各自由对应 RFC 决策。|
|1 本地 link|新旧 Hub/daemon 混版不发送未协商帧；并发重复 offer 仅一次启动；换设备或越 workspace 被拒，旧清单不能将退役 link 复活。|先影子比较路由，再逐 workspace 开启；关闭新路由，排空新增操作，保留旧 runtime ID。|
|2 只读 peer|A–B、B–C 已配对时 A 无法列举 C；越权及过期缓存被拒；断网、撤销、轮钥与重启后无旧订阅复活。|每条连接独立开关；撤销导出并清理缓存，本地调度继续。|
|3 受限远程执行|目标已提交但 ACK 丢失、两端依次重启，只产生同一收据；分区时 owner 不能盲目改派。反序完成/取消、相同键不同参数及旧 fence 均留可核对结果。|先限可幂等操作与配额；关闭新 offer，按操作逐一对账，再停回传。未决任务可见。|
|4 回放与恢复演练|慢流或磁盘满不吞终态；删历史返回明确缺口。断 owner 恢复时旧 writer 被隔离，双方收据与终态收敛；证明对账前保持隔离。|快照与收据在回退窗内保留；降版前停止新协议并验证旧端不会误领未决任务。|

## 待用户拍板

|选择|建议与代价|
|---|---|
|配对范围及拓扑|按需直连、单跳、双边管理员批准；多跳或强制中心均需另做信任及可用性设计。|
|数据归属与灾备|任务 owner 单写、执行端持收据，分区宁可暂停；若要求自动接管，先另行确定仲裁、外部副作用栅栏和恢复目标。|
|首发能力与披露|先只读目录，再按 workspace 开启可幂等远程操作；trace 仅按需授权，保留时长、跨域驻留及容量预算由数据所有者确认。|
|扩展与重写顺序|先共同评审语言无关协议及兼容样例，再决定 Go/Rust 与迁移模块；link 权限随 MUL-11 契约，项目/设备组织归 MUL-9。|
|Persona 对齐|请提供产品版本、可核验设计材料或目标流程，再逐项比对；在此之前按 Remi 实际需求评审。|
