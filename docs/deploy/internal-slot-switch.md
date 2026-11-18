---
title: Internal updater 双 slot 运维
status: active
summary: 单 all API 的同指纹切换、观察期回退、状态与关闭开关。
---

# Internal updater 双 slot 运维

[internal-updates Compose](../../deploy/docker/compose.internal-updates.yml) 的 API
supervisor 在进程内持有 edge，公开端口仍为 6120。两个 API 子进程只监听回环
6121/6122，并信任 edge 的回环转发头。edge 的控制 socket 位于控制卷
`/remi-control/api/edge.sock`，权限 0600；slot 控制 token 每次启动生成，不写入状态文件。
必须先采用包含本实现的 API 基础镜像；应用包不能更新 image-owned supervisor/edge。
web 仍按旧协议重启。

仅无 peer 的 `all` API，且 live `/readyz` 返回有效 A3 term 时，声明 `slotSwitch:true`。
未接入 A3 的旧版本继续走原更新路径；候选缺少 term 时在放流前回退。updater 在更新/回退的目标与当前
`dataSchema` 指纹完全相等时使用 switch；其他情况（包括 restart）保留 drain、
write-fence、停止、备份、隔离 rehearsal、运行和验证流程。旧路径持有 host fence 时，仅真实回环来源且专用 token 正确的 slot 生命周期 POST 可通过；
业务写请求与 WebSocket 仍受围栏保护。指纹清单扩充后的第一版
可能与旧发布不同，仍需旧路径及已有的跨指纹人工审核。

updater 上报的预检会按已解析目标重算：同指纹 switch 不要求离线 rehearsal/备份工具就绪，
异指纹保留严格预检。

switch 先做在线一致性 `pg_dump` 并用 `pg_restore --list` 检查，失败记入 journal 的
`backupError` 后继续。在线备份仅包含数据库，不是 HOME 的完整灾备快照；此路径不
自动恢复数据库。随后启动 standby，等待就绪，hold edge，release 旧 slot，activate
新 slot，确认 `/readyz` 为 200，设为 live 并 unhold，最后退出旧 slot。
release 失败也回到旧 slot，不在存活旧请求仍持锁时继续交接。standby 失败不触碰旧 slot。
activate 失败会杀掉候选并重新 activate 旧 slot。新版本观察期内崩溃或连续 3 秒不就绪，
会从前一 release 重新启动 standby 并切回。观察期结束才向 updater 确认成功。
WS/SSE 按 slot release 协议断开重连；hold 缓存有界，新请求等待不代表无限期可用性。

## 查看状态

在 API 容器查看 `/remi-control/api/status.json`：`releaseId`、`childPid`、`revision`、
`transition.phase`、`transition.error`、`transition.phases`（各阶段时间）和 `heartbeatAt`。
阶段为 standby、releasing、activating、confirming、succeeded，失败时 rolling_back → failed。
`slot-selection.json` 单独保存最终选择，防止启动心跳覆盖回退结果。
updater journal 位于 `/remi-state/operations/<operation-id>.json`，保存 target、previous、
revision、备份结果及最终 verified/recovered 状态。切换等待期间 supervisor 持续写心跳。
回退失败则 supervisor 退出，由容器 restart 策略恢复；不要将此状态当作成功回退。

## 手动切换或回退

优先在平台更新界面发起更新或选保留版本回退，让 updater 验证文件并维护 journal。
紧急操作可在有控制卷写权限的容器内，以临时文件加原子 rename 更新
`/remi-control/api/desired.json`：

```json
{"revision":"manual-unique-id","mode":"run","releaseId":"retained-release-id","strategy":"switch"}
```

每次使用新的 revision。仅选择完整且指纹与当前一致的 retained release；直接写 desired
不会执行 updater 的文件校验、备份或更新 current.json，也不会重启 web。检查 transition
最终结果和实际 releaseId 后，再由平台更新流程对齐 API/Web 选择。手动回退同样写前一
releaseId 和新的 revision。不要用 edge 的 setState 绕过 release/activate 和角色锁。

## 超时与关闭

API supervisor 支持正整数毫秒环境变量：`REMI_SLOT_STANDBY_WAIT_MS`（120000）、
`REMI_SLOT_RELEASE_WAIT_MS`（30000）、`REMI_SLOT_ACTIVATE_WAIT_MS`（60000）、
`REMI_SLOT_CONFIRM_WAIT_MS`（180000）。edge hold 上限按 release + 两次 activate + standby + 30 秒退出宽限计算（默认 5 分钟），
覆盖观察期崩溃后等待旧 slot 退出并重启的预算；updater 等待结果上限为 15 分钟。
调高预算应同时审视 updater 的上限。live slot 意外退出先 hold，再按
1 秒至 30 秒退避重启，连续失败 5 次退出；健康运行一分钟后清除失败计数。

在 Compose 环境设置 `REMI_SLOT_SWITCH=0` 并重新创建 API/updater 容器，恢复旧的单子进程
路径；此操作会重启服务。不要在正在切换时改变开关。关闭开关不需要改映射端口或 web URL。
本地假 release 验证入口：

```bash
bun run test tests/integration/supervisor-slots.test.ts tests/arch/data-schema-inputs.test.ts tests/unit/platform-updater/internal-driver.test.ts
```

这些测试使用真实 edge 和假 slot 子进程，不代替真实 PostgreSQL/Compose 的上线验收。
