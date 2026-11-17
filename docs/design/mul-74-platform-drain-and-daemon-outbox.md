# 平台 Drain、备份与更新恢复

当前运行契约由 [平台部署手册](../../deploy/README.md#drain-protected-updates-mul-74) 维护；本文定位协议和验证入口。

## 入口与范围

Web 设置的「版本与服务」和 CommandRegistry 的 `platform` 命令共用
[platform router](../../packages/server/src/api/routers/platform.ts)。
管理员保存 HTTPS 更新源后，持久化设置立即使旧检查结果失效；updater
每次心跳读取设置，失败的 feed 请求不会停止心跳和操作恢复。
检查请求可以在首次更新器心跳前排队；仅检查不受旧 driver 默认值限制，所有修改服务的
操作仍要求 driver 一致。自定义源支持完整 manifest 和 `latest` 包裹；没有独立
`manifestUrl` 时保留源地址供内部升级调用。执行时再次核对版本和已知 ref，拒绝源漂移。

[更新 worker](../../packages/platform-updater/src/worker.ts) 组合
[内部容器驱动](../../packages/platform-updater/src/internal-driver.ts)、
[宿主容器应用驱动](../../packages/platform-updater/src/application-driver.ts)（Windows/macOS/Linux 的 Linux Docker）
与 [systemd 驱动](../../packages/platform-updater/src/systemd-release-driver.ts)（Linux）。
内部模式使用 [Compose 覆盖文件](../../deploy/docker/compose.internal-updates.yml)：API/Web
监管进程保持运行，独立 updater 通过共享卷切换子进程；新应用包携带 Bun/Node 可执行文件，
运行时版本可变化，CPU、glibc、原生工具及监管协议必须兼容。更新器、监管进程和 OS
仍属于基础环境。内部模式当前覆盖标准 API/Web/PostgreSQL 拓扑，拆分 api-runtime 或
额外持久路径需先扩展监管和备份配置，不直接套用。旧实例需一次性接入基础镜像与覆盖
文件，之后更新不使用 Docker socket、宿主 Docker CLI，也不重启容器。
宿主应用模式仍默认下载 API/Web 应用包，首次复用原镜像接入，之后重启相同容器；
该模式复用镜像内的 Bun/Node，运行时不兼容仍阻止更新。运行中的 api-runtime 必须显式
纳入其核心服务；daemon、数据库和 SSH 控制面不属于可重启范围。
未知数据指纹拒绝更新；指纹由打包时从源码计算。指纹变化还必须有[发版阶段审核过的回退兼容声明](../../deploy/README.md#release-rollback-review)：
发版负责人以先前已发布版本的 manifest 为依据，请人工审阅者确认兼容性，
将声明作为目标 Release 附件交给打包流程；无声明时生成空列表，updater 继续拒绝不同指纹更新。
迁移源清单统一来自 `packages/platform-updater/src/data-schema-inputs.json`。
显式 `MULTIREMI_PLATFORM_UPDATE_MODE=images` 才使用原镜像驱动和 local-profile 快照协议；
其相同迁移指纹限制继续保留。切换更新模式前需完成旧模式中的操作恢复。

## Drain 状态与切换边界

[maintenance repo](../../packages/server/src/store/repos/platform-maintenance-repo.ts)
维护 `mode/generation/operationId/expiresAt`。等待期间阻止新任务领取，已领取
任务继续运行。门闩同时检查 Runtime 对当前 generation 的确认、服务端
in-flight 数以及 Runtime 上报的本地活跃数；断线机器残留的正活跃数也阻止切换。

`drain/begin`、`drain/renew`、`drain/release` 使用 updater 双凭据；renew 同时
返回等待进度和取消标记。[协调器](../../packages/platform-updater/src/drain.ts)
默认无限等待任务完成，超时配置只取消更新，不取消任务；ready 后继续续租，
覆盖备份耗时，并在提交前重新确认。上报 switching/restarting 是服务端提交点，
必须仍持有 ready 的 drain 且没有取消请求。

提交前 updater 崩溃会在租约过期后恢复调度。提交后不能因为 TTL 过期而恢复
调度：switching/restarting/verifying/rolling_back 保持维护状态，直到程序切换或
恢复经过验证并收到终态。操作取消仅允许 queued/preparing/pulling/draining/backing_up。
服务端取消和切换更新均带条件，防止并发请求绕过边界。

## 备份与恢复

[安全工具](../../packages/platform-updater/src/safety.ts) 在 drain 后执行部署配置的
数据库一致性导出与恢复验证命令，复制持久文件，归档命名卷，并对实际落盘
文件检查大小和 SHA-256 后写完成清单。备份路径不能与源数据目录重叠。
[PostgreSQL 校验器](../../scripts/verify-platform-backup.ts) 可作为通用备份验证命令。
宿主容器应用驱动另外启动不连接生产网络的临时 PostgreSQL 容器；内部模式使用常驻的
`network_mode: none` 演练容器，在私有临时目录启动 PostgreSQL 17。两者均以隔离凭据
完整恢复备份，依次执行目标和旧版实际迁移，并检查既有列仍兼容；内部演练只删除自己的
临时目录。演练容器没有生产凭据、可写程序/备份卷或生产 API home。
缺少备份配置、恢复/迁移演练失败或兼容性未知均阻止新代码上线。

下载、校验和解包应用在 drain 前完成，失败不触碰运行服务。切换前持久化本机
恢复日志，记录旧版、目标版本和基础镜像。服务端提交后落盘 `committed` 和主机写锁，
停止 API/Web 写入，再备份数据和演练迁移；因此这一阶段备份失败也须恢复旧服务。
备份完成后补记位置，再原子切换应用指针。若切换失败，
先在本机恢复旧程序并验证，再向 API 报告；不通过不可用的新 API 阻塞回滚。
恢复失败时保留日志、备份和维护状态。服务端提交成功后、变更服务之前，
日志落盘 `committed` 标记。重启 updater 会在联系 API 之前恢复这些日志，
因此新 API 无法启动也不会阻止本机恢复；
未提交日志不会触发服务重启，已验证成功的日志仅重放结果。

自动更新和 Web/CLI 回滚不恢复旧数据库，因为更新之后的写入可能因此丢失。
local-profile 默认使用上述应用驱动和保留数据的回退。旧镜像模式的历史操作日志及
独立手动灾难恢复命令仍按其原有完整快照协议执行。不删除生产数据卷。
备份或重启失败均保留维护状态，直到主机恢复并验证完成；终态回执、drain 释放、
主机写锁清理之间崩溃也可在下次启动补全。健康检查后还核对进程实际运行的版本目录。
主机配置必须覆盖部署自己的全部持久路径/卷；不把一次 HTTP 健康响应当成
备份可恢复或所有数据完整的证据。

## Daemon Outbox

[worker outbox](../../packages/server/src/worker/outbox.ts) 将任务上报持久化并按任务
顺序重试。API 暂时不可达不会因为一次上报失败关闭 provider。永久鉴权错误
进入 blocked，存储上限仍按现有 Outbox 策略处理；这不构成任意故障下绝对不丢
数据的保证。更新流程先等待任务和本地执行归零，再切换服务。
Windows 上保留重试定时器的事件循环引用，避免 Bun 1.3.14 的无引用定时器
卡住终态回传；`close()` 仍会唤醒并清理重试，不阻塞正常关闭。
Outbox 显式缓存自己的固定 SQL 语句；关闭时等待在途投递，再 finalize 全部语句并严格关闭
SQLite，避免 Bun 1.3.14 默认 20 条 query 缓存之外的语句等到 GC 才释放文件锁。
磁盘回归在删除夹具前验证关闭：Linux 扫描 `/proc/self/fd`，Windows 由文件删除检查锁；
关闭失败直接使测试失败，不吞异常、不重试删除。

## 验证入口

- `bun test tests/unit/platform-updater`：准备失败不停止服务、备份失败恢复旧服务、二进制备份落盘、安全解包、lease 续租、取消、兼容拒绝和崩溃恢复。
- `bun run tests/integration/platform-application-smoke.ts`：独立 Docker 项目从 Web 代理调用真实鉴权 API、PostgreSQL 队列、worker 和 drain；覆盖任务等待、API 重启后的操作记录/去重、复用镜像、后续容器 ID 不变、故障回退、新增数据保留、测试 daemon/数据库进程不中断及 Web/WebSocket 恢复。Web 为轻量测试代理，真实设置按钮由组件测试覆盖；不调用真实模型。
- 加 `--internal`：运行实际内部 updater、监管进程及隔离演练容器；验证 Bun 1.3.13、Node 22.13.1 基础镜像启动应用包里的不同版本，监管 PID/容器不变、显式回滚恢复旧运行时且保留新增数据。只在测试准备阶段调用宿主 Docker，内部更新器不持有 socket。
- `bun test tests/unit/multiremi/multiremi-platform-lifecycle.test.ts tests/unit/multiremi/multiremi-platform-drain.test.ts tests/unit/multiremi/multiremi-platform-safety.test.ts`：API 鉴权、更新源、预检、调度边界和提交后维护状态。
- views 的 `settings/components/platform-tab.test.tsx`、`settings-page.test.tsx`，core 的 `api/schemas/platform.test.ts`：设置入口、来源表单、阻塞原因和响应边界。
- `.github/workflows/release-build-check.yml` 的 `platform-updater` job 在 Windows/macOS/Linux 运行相关测试。配置了矩阵不等于本次三平台运行均已验证；实际结果见任务/CI。

## CLI 更新的 daemon drain

CLI 更新在 runtimes-repo 创建带 requestId 的持久化 daemon drain，等待期间请求
保持 pending；`daemon.drain` 状态显示排空进度，无需新增请求状态。默认期限沿用
MUL-68 的 5 分钟，`MULTIREMI_DAEMON_DRAIN_TIMEOUT_MS` 可覆盖，避免引入两套期限。
服务端排空后才下发更新，HTTP heartbeat 与 WebSocket 下行均携带持久化的原 deadline；daemon 对接受任务的竞态暂停各
provider 接单，在剩余期限内等待。到期仍繁忙时更新失败，错误列出剩余任务，
解除该更新持有的 drain，已有轮次继续运行，不执行 runtime recovery。
人工和部署 drain 保持原有超时回收契约，不能被更新接管或释放。

准入在 workspace lifecycle 锁内串行：同一物理 daemon 同时最多一个 CLI 请求离开
pending。有 update owner 时只有该 owner 可准入；人工/部署 drain 没有 owner 时，
必须没有其他 running/restarting/verifying CLI 请求。所有准入均要求 drained 或
drained_forced。HTTP claim、WebSocket 下行及其迟到 ACK、pending→running 上报共用此判定；
未准入的请求保持 pending，下行不发送。pending→running 准入拒绝使用稳定错误码 `cli_update_not_admitted`（HTTP 409；WS 不可重试协议错误）。
daemon 按 code 识别后释放本地暂停、释放 WS 去重键，不安装、不切换 launcher、不上报
failed；同 id 在 WS 或 heartbeat 后续下发时可再次执行。

CLI running 回执只有 pending→running（通过上述准入）与 running→running（幂等确认）
可以成功。lifecycle 锁内对终态、restarting、verifying 的 running 一律返回
`cli_update_not_runnable`（HTTP 409；WS retryable=false），不把空操作的 HTTP 200 当作
安装许可。daemon 收到此 code 立即释放暂停并抛出以释放下行去重键，不安装、不重启、
不补报 failed，也不按未知结果重试；平台已有终态或已有执行者。终态的其它上报保持幂等成功。

running 准入确认使用非持久化同步 HTTP result，兼容没有准入逻辑的旧服务端；终态仍走
持久化 outbox。接受后才安装。超时、断线、5xx 等结果未知时，每 250ms 幂等重试，
窗口取平台剩余 drain 期限与 30 秒的较小值（旧服务端无 deadline 时取 30 秒），每次请求
也受该窗口的 AbortSignal 限制。30 秒限制避免无执行者长时间占用更新围栏，同时允许短暂
网络恢复。窗口耗尽后仅投递一次带 admission confirmation deadline exceeded 原因的 failed，
随后释放本地暂停。没有 running outbox 记录可在放弃后 replay；已到达服务端但响应丢失的
HTTP 请求由幂等 running→running 确认，终态拒绝迟到状态回退。

旧实现普通 Error 在 WS session 映射为可重试 server_error，running outbox 会持续重试；
新实现明确拒绝为不可重试，兼容清理旧队列中该条 running 记录并拒绝其 waiter，不阻塞
整个 rt 分区；`cli_update_not_admitted` 和 `cli_update_not_runnable` 均只删除被拒的那条
running 记录。旧 daemon 正常只收到已准入下行，running→running 继续幂等接受。
N-1 边界：新服务端对旧 daemon 的迟到 running 增加 HTTP 409 或不可重试 WS 错误；
升级后的 daemon 除上述投递时单条清理外，在打开 outbox DB 时做一次有界启动恢复：
仅处理 blocked-code 为 `cli_update_not_admitted` 或 `cli_update_not_runnable` 的分区；
事务内先删除其中 blocked 的 `runtime.update_result` running 记录（旧执行者已退出，
不能重放为准入），再将其余 blocked 行恢复 pending、清空 last_error/next_attempt_at，
删除该分区的 blocked/blocked-code 元数据，让后续报告重新接受服务端校验。
其它永久错误码（如 `protocol_violation`）保持 blocked，不扩大恢复范围。
未升级的 0bb8c3256 daemon 对 HTTP 409 会在原有最多 30 秒窗口内重试后补报 failed，
不会安装或无限重试，平台终态仍保持幂等。更早使用 running outbox 且不识别该 code 的
daemon 会把不可重试 WS 错误持久化为分区 blocked；平台升级后、daemon 升级前该分区
仍会阻塞。服务端无法改变其本地分支，这段窗口以 daemon 升级为界：升级后打开同一 DB
即按上述规则自愈，遗留 running 不会再次投递。正常只收到已准入下行的路径不变。
新 daemon 连接旧服务端仍按现有 HTTP 成功确认安装，旧端对终态返回 200 的许可缺口
无法由新 daemon 单独消除，需服务端升级后获得本节保证。
因此 owner 终态交接只需寻找 pending sibling，可在 restarting/verifying 保护之前处理。

下载或校验失败的终态立即释放本次 requestId 的 drain；重启期间 drain 保持持久化，
新进程完成版本注册和启动自检、确认 completed 后释放。恢复旧版本确认 rolled_back
同样释放。owner 进入终态（含排空超时）时，若同一物理 daemon 仍有 pending CLI 更新，
则把 drain 交接给最早创建的请求，并从交接时刻重新计算期限；没有 pending sibling 才释放。
人工/部署 drain 不参与交接。进入 restarting/verifying 后排空期限不干扰新进程确认，仍由更新验证期限管理。
`daemon.drain` 的 `expiry_action=fail_update` 区分更新围栏和人工/部署的 `runtime_recovery`。

验证入口：`tests/unit/multiremi/daemon-drain.test.ts`、
`tests/unit/daemon/cli-update-coordinator.test.ts`、`tests/unit/daemon/cli-update-lifecycle.test.ts`、
`tests/unit/daemon/update-admission.test.ts`（真实 HTTP result、协议 report handler 和磁盘 outbox）。
