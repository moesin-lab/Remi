# 平台 Drain、备份与更新恢复

当前运行契约由 [平台部署手册](../../deploy/README.md#drain-protected-updates-mul-74) 维护；本文定位协议和验证入口。

## 入口与范围

Web 设置的「版本与服务」和 CommandRegistry 的 `platform` 命令共用
[platform router](../../packages/server/src/api/routers/platform.ts)。
管理员保存 HTTPS 更新源后，持久化设置立即使旧检查结果失效；updater
每次心跳读取设置，失败的 feed 请求不会停止心跳和操作恢复。

[更新 worker](../../packages/platform-updater/src/worker.ts) 组合
[Compose 驱动](../../packages/platform-updater/src/compose-driver.ts)（Windows/macOS/Linux）
与 [systemd 驱动](../../packages/platform-updater/src/systemd-release-driver.ts)（Linux），
并保留 [local-profile 驱动](../../packages/platform-updater/src/local-profile-driver.ts)
及数据库外的操作回执。Compose 默认切换 API/Web，也支持显式配置 api-runtime；
不重启 daemon、数据库或 SSH 控制面，即使旧配置列出了这些受保护服务。
平台发布工作流生成 amd64/arm64 镜像和数据迁移源指纹；未知或不一致的
指纹拒绝自动更新，不能把代码回滚等同于数据库恢复。

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

[安全工具](../../packages/platform-updater/src/safety.ts) 在 drain 后执行主机配置的
数据库一致性导出与恢复验证命令，复制持久文件，归档命名卷，并对实际落盘
文件检查大小和 SHA-256 后写完成清单。备份路径不能与源数据目录重叠。
[PostgreSQL 校验器](../../scripts/verify-platform-backup.ts) 把备份恢复到随机命名的
临时数据库，并只删除该临时库。缺少备份配置、失败或数据兼容性未知均阻止切换。

准备镜像使用独立 env 文件，失败不会改写运行配置，也不会重建旧容器。
切换前持久化本机恢复日志，记录旧版本、原配置及备份位置。若切换失败，
先在本机恢复旧程序并验证，再向 API 报告；不通过不可用的新 API 阻塞回滚。
恢复失败时保留日志、备份和维护状态。服务端提交成功后、变更服务之前，
日志落盘 `committed` 标记。重启 updater 会在联系 API 之前恢复这些日志，
因此新 API 无法启动也不会阻止本机恢复；
未提交日志不会触发服务重启，已验证成功的日志仅重放结果。

自动更新和 Web/CLI 回滚不恢复旧数据库，因为更新之后的写入可能因此丢失。
local-profile 的自动路径使用相同迁移源检查和保留数据回滚；历史操作日志及
独立手动灾难恢复命令仍按其原有完整快照协议执行。不删除数据卷。
local-profile 的原生备份会暂时停止 API/Web，因此重启流程先提交维护锁，
再执行备份；备份或重启失败均保留维护状态，直到主机恢复并验证完成。
主机配置必须覆盖部署自己的全部持久路径/卷；不把一次 HTTP 健康响应当成
备份可恢复或所有数据完整的证据。

## Daemon Outbox

[worker outbox](../../packages/server/src/worker/outbox.ts) 将任务上报持久化并按任务
顺序重试。API 暂时不可达不会因为一次上报失败关闭 provider。永久鉴权错误
进入 blocked，存储上限仍按现有 Outbox 策略处理；这不构成任意故障下绝对不丢
数据的保证。更新流程先等待任务和本地执行归零，再切换服务。
Windows 上保留重试定时器的事件循环引用，避免 Bun 1.3.14 的无引用定时器
卡住终态回传；`close()` 仍会唤醒并清理重试，不阻塞正常关闭。

## 验证入口

- `bun test tests/unit/platform-updater`：准备/备份失败不重启、二进制备份落盘、lease 续租、取消、兼容拒绝和崩溃恢复。
- `bun test tests/unit/multiremi/multiremi-platform-lifecycle.test.ts tests/unit/multiremi/multiremi-platform-drain.test.ts tests/unit/multiremi/multiremi-platform-safety.test.ts`：API 鉴权、更新源、预检、调度边界和提交后维护状态。
- views 的 `settings/components/platform-tab.test.tsx`、`settings-page.test.tsx`，core 的 `api/schemas/platform.test.ts`：设置入口、来源表单、阻塞原因和响应边界。
- `.github/workflows/release-build-check.yml` 的 `platform-updater` job 在 Windows/macOS/Linux 运行相关测试。配置了矩阵不等于本次三平台运行均已验证；实际结果见任务/CI。
