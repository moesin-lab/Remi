# ADR 0026: Bridge 独立托管与 daemon 重启接管（MUL-37）

- 状态：提议，待天工评审；本 PR 仅交付 ADR，不包含运行时实现。
- 基线：Remi `aa9a924a90da415dc78822e1b7bc2fae6a7e1280`；MUL-31 已有 checkpoint / 同 attempt 续接（#128、#145）。派发说明报告 stable 已验收；本轮未重复线上验收。
- 建议：选择独立 bridge host，Linux/systemd 首先实现；fd 交接不采用，现状作为显式降级。评审接受前不开始实现。
- 关联：MUL-28 停止与回滚、MUL-31 drain/checkpoint、MUL-33 N-1。实现后修订 [ADR 0022](0022-background-tasks-keep-alive-on-demand.md) 决策 3、7；当前契约本轮不变。

## 1. 已有保证与缺口

[AcpClient](../../packages/acp/src/client.ts) 以 stdio pipe 启动桥；POSIX 的 `detached` 只创建独立进程组，不脱离 systemd cgroup，也不提供重新连接 pipe 的能力。
[ParkedLanes](../../packages/server/src/worker/parked-lanes.ts) 把驻留进程组与启动时间写入 `parked-bridges-*.json`，启动时清扫而非接管。
[daemon](../../packages/server/src/worker/daemon.ts) 在停止/排空调用 `closeAll("daemon_restart")`。
[服务模板](../../apps/remi/cli/multiremi/service.ts) 当前是 systemd `TimeoutStopSec=45` / `KillMode=control-group`，launchd `ExitTimeOut=45` / `AbandonProcessGroup=false`。所以 pipe 和服务进程边界都必须调整。

[MUL-31](../design/mul-74-platform-drain-and-daemon-outbox.md) 以 checkpoint、稳定 consumer 与 generation CAS 在同一 Turn/attempt 恢复；当前安全点要求 provider close、报告/trace ACK。
[checkpoint v1](../../packages/contracts/src/planned-restart.ts) 保存 session、工作目录、输入收据和 trace 水位引用，不保存 stdio、在途 RPC 或进程内存。同 attempt 并不保证同一次工具调用继续。
目标仅增加 daemon 自身升级时 provider 与工具继续执行的保证，不承诺 host 自身升级/崩溃、主机重启或断电无损。

### 被中断调用的实际代价如何量化

设调用原本耗时 T，升级时已执行 e，重启及续接窗口 D。若必须从头重跑，相比不中断额外工具时间约 e、完成延迟约 `e + D`；多次打断浪费 `Σeᵢ`。provider 能直接消费已落盘的调用结果时可能无需重做，不能从 attempt 数推断损失。

| 场景（算例，非测量） | MUL-31 的剩余代价 | host 路径预期 |
|---|---|---|
| 30 分钟测试跑到第 20 分钟时升级，随后从头重跑 | 浪费约 20 分钟工具执行，完成延迟约 20 分钟 + D | 原工具仍于原定第 30 分钟结束，界面在 D 后补传 |
| 10 秒查询执行到第 5 秒 | 浪费约 5 秒 + D，收益较小 | 省去约 5 秒重做 |
| 已产生外部副作用的写操作 | 重复副作用与人工核查，不能仅按时间计价 | 减少更新导致的重复执行，仍不保证外部副作用 exactly-once |

若升级在固定时长 T 内均匀发生，条件平均浪费 T/2，仅为估算假设。按月记录确实被打断且重跑的调用数 n、eᵢ、资源单价 cᵢ，汇总 `Σeᵢ` 和 `Σ(eᵢ × cᵢ)`，另记重复副作用与人工耗时；provider token 费用独立统计。
目前没有这组生产样本，不宣称实测节约率。实施验收须记录调用起止、restart 时点、PID/启动身份、重做次数与输出序号，比较新旧路径。推荐方向来自明确的长调用连续性目标。

## 2. 三种方案比较

| 方案 | 复杂度与失败模式 | Linux/systemd | macOS/launchd | Windows |
|---|---|---|---|---|
| A. 独立 host 持有桥 stdio，daemon 连接本地 socket | 高：新增服务、事件日志、单写者 fencing、在途 RPC/权限恢复、资源所有权及独立升级；host 成为新故障域 | 可落地：独立 user unit/cgroup，host spawn provider | 可行：launchd 直接启动独立 host label，须实机验证停止边界 | 后续可行：独立 SCM service、named pipe ACL、Job Object 管理后代，不能复用 POSIX 信号清扫 |
| B. fd 传递交接 | 很高：fd 不包含 parser 半帧、pending map、provider/translator 内存；需冻结、移交和失败回滚，双读者可丢帧 | Unix `SCM_RIGHTS` 可传 fd；Bun 能力待验证，可能需 native helper；桥仍需预先脱离 daemon cgroup | Darwin 可传 fd，但仍需独立 job、native 适配及状态迁移 | 无通用 SCM_RIGHTS，需 DuplicateHandle/命名管道与状态协议重写 |
| C. 维持 MUL-31 | 低：沿用恢复和清扫；当前调用仍中断/重做，可能重复副作用 | 当前基线，不满足不中断目标 | 当前降级基线 | 仅在现有 daemon/provider 支持并验证的环境采用；本 ADR 不新增 native 支持承诺 |

推荐 A。B 仍要解决 A 的服务边界和状态恢复问题，且跨平台成本更高。C 对短调用可接受，但不满足目标。首版 Linux；macOS 验收前、Windows native 未实现时保留 C，明确显示“轮次可续接，当前工具可能重做”。WSL 可按 Linux 路径另验。
不通过 `KillMode=process` 或 `AbandonProcessGroup=true` 留孤儿冒充连续性。

## 3. Host 所有权与本地协议

每 runtime/profile/操作系统用户一个 host，管理多条桥；stable 与候选实例使用不同 unit、socket、状态目录和工作目录。host 不持平台派单权，不自行启动新轮。
host 持有 AcpClient、stdio parser/pending RPC、provider 池与子会话映射、复用判断、异步任务/自主周期缓冲，以及桥使用的临时目录、插件和工作目录锁。daemon 保留平台连接、调度、trace 翻译与上传。只转发 pipe 不足以接管。
共享目录独占改为 host 资源租约，所有任务准备/GC 都核验同一所有者，不能依赖旧 daemon 的内存锁。运行中不迁移 cwd、不重新初始化目录或回收插件。

Linux/macOS 使用文件系统 Unix socket（目录 0700、socket 0600、同 UID peer 校验）；Windows 使用限定 SID 的 named pipe。握手绑定 runtime/profile、host boot ID 和本地随机认证材料；token 不进入命令行、日志或普通 checkpoint。宿主用户权限是信任边界。

下列名称为拟议协议，不是已有 API：

| 操作 | 必要语义 |
|---|---|
| `hello/welcome` | min/max 协议、caps、runtime/profile、host boot ID，能力取交集，身份不符拒绝 |
| `inventory/attach` | lane/session、launch fingerprint、attempt/generation、handoff ID、host epoch、消费水位；原子安装唯一 controller lease |
| `invoke/reply` | 稳定 operation ID 和参数摘要；同 ID 同参数重读结果，冲突拒绝；started 但结果未知时不自动再发 prompt |
| `event/ack` | lane 单调 seq、稳定 event ID、原生 session/request/tool ID、执行段绑定；ACK 表示已持久消费，非 TCP 收到 |
| `seal/detach` | 封住旧 controller 写入，返回切分水位与恢复状态；保留桥、在途 RPC，后续帧写 host 日志 |
| `stop/release/shutdown` | 区分用户工具停止、lane 生命周期结束和完整 runtime 停机；可重放并记录真实停止结果 |

host 只接受当前 lease/epoch/generation 的控制消息。平台 resume CAS 是执行授权权威；host 不凭本地 checkpoint 自授新 generation。新 daemon 先获平台授权，再安装新 epoch；旧 controller 晚到也只能得到 fenced。host boot ID 变化时旧 inventory 不能证明活桥存在。

## 4. 输出、等待与接管安全点

1. host 持续读取 stdout/stderr，把 ACP 事件按序写 owner-only WAL/分段日志后交付。包含 prompt 完成、用量、权限/提问、异步任务与控制结果；不能只保存输出尾部。daemon 不在线时工具可以正常结束。
2. daemon 持久提交事件、translator 全状态、原生 ID→trace item ID 映射及 trace/outbox 游标后才 ACK。平台尚未 ACK 的数据继续由本地 outbox 保留；按 event ID 去重，不重复 turn.started、用量或工具调用。必须覆盖平台提交成功但 ACK 丢失。
3. 计划内升级先停止接新轮和新 provider 控制；host seal 旧 controller，返回 H。旧 daemon 消费/上传至 H，保存 host 绑定及快照，再沿 MUL-31 suspend，收到提交 ACK 才退出。H 后的输出留 host，旧代不再上传；失败不伪造挂起证据。
4. 新 daemon 校验 host/inventory，完成更新自检、释放平台 fence，以稳定 consumer 执行 MUL-31 resume CAS。成功后 attach 新 generation，从 H+1 补传并等待**原 prompt 的完成结果，不重新发送 prompt/session resume**。H 后事件依据 handoff 绑定投影到恢复执行段；用量保留实际发生时的原授权，不把所有迟到用量改挂新 run。取消已先提交则只清理，不重新授权。
5. translator 快照需包括未完成条目、子代理、后台任务；现有 optional trace identity snapshot 不足以证明完整恢复。快照缺失、游标有缺口或 boot ID 不符时隔离活桥，确认停止旧进程树后才走冷恢复，禁止两 provider 同写目录。
6. host 保留原生权限/提问 request ID 与 pending reply，daemon 对账原 Q 后只路由一次回答，不重复建 Q；无回答不批准。断连期新权限等待，provider 自身超时则据实失败，host 不代决策。
7. attempt token 与 `MULTIREMI_TASK_CONTEXT_FILE` 原子轮换，不写 checkpoint。升级期间服务端鉴权可能暂不可用，依赖旧 token 的工具自身请求仍可能失败，不承诺此类外部请求不中断。驻留期不自动得到新 attempt 权限；自主周期沿用门铃/授权规则。

ACK 后截断日志，未 ACK 数据不静默丢弃。建议初值每 lane 256 MiB、host 总计 2 GiB、失联窗口 10 分钟；80% 告警并拒绝新 lane。此为待测配置，实施前按长调用峰值输出验证。
磁盘满/硬上限时保留控制预算、明确记录 `output_retention_exhausted`，终止受影响 lane 并按失败恢复；不能阻塞 pipe 或丢帧后仍声称输出连续。失联窗口到期在有限预算内停止无主工具。正常升级必须在窗口内完成。
host 崩溃前读出但未持久化的帧可能丢失，属于 host 故障边界，不宣称 exactly-once。

## 5. systemd / launchd 与停止、崩溃清扫

Linux 由安装器生成两个独立 user unit；示意配置，非已发布模板：

```ini
# multiremi-bridge-host@<profile>.service
[Service]
Type=simple
ExecStart=<固定版本的独立 host launcher> --profile <profile>
Restart=on-failure
TimeoutStopSec=45
KillMode=control-group

# multiremi-daemon@<profile>.service 新增依赖
[Unit]
Wants=multiremi-bridge-host@<profile>.service
After=multiremi-bridge-host@<profile>.service
# daemon 原有 ExecStart/Restart/TimeoutStopSec=45/KillMode=control-group 保留
```

host 必须由 systemd 直接启动，不能 daemon spawn 后只 setsid。可以同 slice，必须不同 service cgroup；不配置使 daemon stop/restart 传播给 host 的 PartOf/BindsTo。Wants 不代表 readiness，仍需握手。旧模板未迁移前保留 C；首次启用必须等旧桥排空，不搬运行中 cgroup。

| 场景 | 契约 |
|---|---|
| CLI 更新/计划内 daemon restart | drain→seal/checkpoint/suspend→daemon 退出；只重启 daemon unit，host/桥不收信号，接管后补传 |
| daemon SIGKILL/意外死亡 | host 保留桥并等待；新 daemon 对账平台授权、租约、日志后恢复，不凭 PID attach；没有已确认 suspend 时不宣称获得 MUL-31 计划内交接保证 |
| 平台手工 drain | 停止接新轮；未明确要求活交接时沿用现有 drain/停止语义，不擅自无限保留后台执行 |
| 完整 stop/卸载/runtime 注销 | 编排先围栏并停止 daemon 接单，再让 host 停止全部 lane，最后停止 host unit；RPC 不通也由管理器停 host cgroup，确认所有后代退出 |
| 直接 systemctl stop daemon unit | 仅停止 daemon，host 最多保留到失联窗口；运维明确完整停机入口和单 unit 停止的区别 |
| host 崩溃/退出/超时 | systemd 清掉整个 host cgroup 后重启；新 boot ID 使旧 lane lost，走既有恢复，不假装活接管 |
| 主机关机/用户会话结束 | 管理器停止两服务，不承诺工具存活；不自行修改 linger 配置 |

继承 MUL-28：每服务优雅停止预算 30 秒、管理器 45 秒，预留 15 秒清扫。daemon 超时只清扫其直接拥有的旧模式 provider；禁止通过原 PGID 清扫 host 所有的桥。完整停机/host 升级才由 host 取消/close 后强杀，保持 KillMode=control-group。

host 是托管 lane 的唯一进程树/资源清扫者。旧 `parked-bridges-*.json` 只处理旧模式；host 记录使用独立命名空间和所有者，避免旧 daemon 误杀。身份包含 boot ID、进程启动身份、runtime/profile/lane，不能只用 PID；损坏记录隔离告警，不按裸 PID 清扫。
startup GC 在回收前合并 host inventory；`hello.parked_lanes` 在对账后发送，存活后台行不再因 daemon 重启被服务端置 `daemon_restart`。真正失联/停止才记录相应原因；非托管路径继续 ADR 0022 行为。

macOS 使用两个独立 LaunchAgent label 和固定 launcher，保持 AbandonProcessGroup=false、ExitTimeOut=45。daemon 更新只 bootout/bootstrap 自身 label；host 由 launchd 直接启动并管理 lane 进程组。须实机验证 host job 崩溃/退出的后代清理，不用 Linux cgroup 测试替代；未验收时降级 C。
Windows 后续使用两个 SCM service、host 独占带 kill-on-close 的 Job Object，daemon 不持其 handle；验证嵌套 job、进程逃逸、pipe ACL 和停止预算。当前 native 未实现/未验收，不声称 PGID 清扫通用。

## 6. N-1、回滚与 host 自身升级

沿用 [MUL-33 兼容纪律](../daemon-protocol-v2.md)：本地协议独立于 daemon↔平台协议，普通发布 additive，能力不由 build/CLI 版本推断。拟议 bridge.attach.v1、bridge.event-replay.v1、bridge.handoff.v1 及平台侧交接能力须协商；新 checkpoint 使用版本/caps gate，不能把未知字段塞入严格校验的 v1。

| 组合 | 必须支持的结果 |
|---|---|
| daemon N×host N-1、daemon N-1×host N | 握手、续传、完成/取消同一调用；持久日志/快照也保留 N-1 可读窗口，真实前版源码双向混版验证 |
| 无 host/旧平台缺交接能力 | 不开启活接管，保留 MUL-31/ADR 0022 并显示降级，不发未知必需字段 |
| 有活 host lane，回滚目标 daemon 不认识 host | 阻止其接单与旧清扫，等待 lane 自然结束后回滚；或维护者明确授权中断后清理，不能启动第二个 provider |
| 协议无交集/必需状态不认识 | 拒绝 attach/自动激活，保留旧 daemon/host，不能靠重启 host 修复活调用 |

首次引入前一版本没有 host，不能凭空满足 N-1。先发布默认关闭的双栈兼容准备版，使之理解 inventory、清扫隔离和状态格式；验证回滚后，下一版才启用，并将准备版作为 MUL-28 previous-launcher。没有安全回滚基线则关闭功能或等待空闲升级。

host 有独立版本目录和 launcher；运行中 pin host 二进制、桥依赖和插件资源，daemon 安装器不能覆盖或 GC。更新 daemon 默认不更新 host。
host 更新先拒绝新 lane，旧 host 继续持有全部活 lane，等自然结束；候选预检后只在空 host 上停止/切换/自检，失败回滚旧 launcher，不迁移活 stdio。等待超时报 deferred，不杀长调用。紧急安全修复需明确维护操作、告知中断并落 MUL-31 降级，不承诺 host 热升级。
状态格式先 expand，N-1 可读且混版恢复验证后再 contract；不兼容迁移只在 host 空闲且可回滚时进行。MUL-28 verifying 增加 host 握手、inventory/恢复能力自检，仍保留原平台注册和启动屏障。

## 7. 与 MUL-31 集成及后续实现范围

保留 request/suspend/resume、同 attempt、consumer、generation CAS、drain fence 与 ACK。增量是安全点从“关闭 provider”切到“host 封住旧 controller，继续执行并记录输出”，只在三方能力满足时启用。
托管后台驻留仍有原上限、生命周期和授权；单纯 daemon 升级不再 closeAll(daemon_restart)，改为移交 inventory。全部停止、lane reset、归档/删除仍停止原进程。

ADR 接受后建议依次实施：兼容准备版与混版/回滚测试；Linux host、服务安装卸载和资源所有权；完整 translator/权限恢复及 MUL-31/MUL-28 集成；隔离候选验收和独立审阅。macOS 实机、Windows native 后续排期。ADR 接受不等于实现已完成或部署获准。

## 8. 待实现后的验收

Linux/systemd 使用真正 unit/cgroup、真实受支持 provider、独立 profile/目录/端口，不触碰 stable 或 6131–6134。不启动本机被禁用的 Claude；可用获准 Codex/provider 并记录版本。

- 启动至少 30 分钟且每秒刷出序号的工具，至少运行 20 分钟后走真实更新链替换 daemon。记录 daemon/host/bridge/tool PID、启动身份、cgroup、attempt/generation、tool start 次数。bridge/tool 身份不变、工具仅启动一次，持久化输出序号完整且投影不重复，同 attempt 完成；界面可短暂积压但补齐。
- 覆盖断连期完成、半帧/重复帧、平台 ACK 丢失、suspend/resume 响应丢失、双 daemon/旧代迟到、取消/归档竞争、子代理/自主周期/用量；权限等待保持同 Q，回答只消费一次。
- 覆盖 daemon SIGKILL、候选启动即退出并回滚、host SIGKILL、磁盘满/硬上限/失联超时。后几项应明确失败并清扫，不能标输出连续通过；无权威证据不活接管。
- 完整 stop/卸载及 30/45 秒停止超时无孤儿；单 daemon restart 保留 host cgroup/PID；startup sweep/GC 不杀活 lane、不回收资源。
- 双向 N-1 用真实前版 host/daemon 验证 attach、续传、取消、状态读写及回滚。macOS/Windows 未实跑列为未验收，不用 Linux 或 mock 结果代替。

本轮仅源码调查与文档校验；provider、systemd、macOS、Windows、性能及候选更新验收均未执行。请天工评审推荐方向、首版平台范围，以及“host 升级等空闲、超限明确中断”的保证边界；通过前不进入运行时实现。
