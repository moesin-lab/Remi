---
title: Phase A 候选实例验收
status: active
summary: 准备隔离 PG/internal-updates/fake-acp 候选，执行并发轮次切换和故障回退，读取报告与恢复旧路径。
---

# Phase A 候选实例验收（MUL-172）

入口是 [phase-a-acceptance.mjs](../../scripts/phase-a-acceptance.mjs)。它操作**已经准备好的候选**，
通过 A4 supervisor 的控制卷直接执行切换，不创建候选、不调用 updater、不更新 Web。
报告的 `supervisorScenariosPassed` 只表示该范围内的十个场景通过；`phaseAAccepted` 始终为 false。
完整 Phase A 还需要实际 PostgreSQL/Compose 拓扑证据，以及经 updater 的发布/回退验证。
当前仓库 main 尚未包含 A4 时不可执行；不能用假 slot 子进程代替真实 API。

## 候选前提

1. 固定 A4 基础镜像的完整 SHA。初始对照为 MUL-170 分支
   `a7579b98674c5010166d3e6e4d964c0dc3532996`（[PR #123](https://github.com/moesin-lab/Remi/pull/123)），
   执行前核对最终合入 SHA；基础 API 镜像必须包含 image-owned supervisor、slot-supervisor 和 edge。
   单纯更新应用 release 不会替换这些文件。候选应用必须包含 MUL-178 #96 的修复，
   可用 `git merge-base --is-ancestor 27a7d7cc2 <candidate-sha>` 核对。
2. 按[本机 profile 部署](../deploy/local-profiles.md)和 [internal-updates overlay](../../deploy/docker/compose.internal-updates.yml)
   创建名为 `remi-a5`（可设 `remi-a5-<唯一后缀>`）的独立 Compose 项目。使用独立 Postgres、API HOME、
   program/control/state/seed 卷与 daemon；不得复用 stable 的端口占用、数据库、卷、凭据或 daemon。
   默认绑定 `127.0.0.1:26120 -> api:6120`、Web 23000；禁止使用 stable 的 16120/13000。
   默认命名卷由 Compose 项目自动隔离，不能指定任何 stable external volume。
3. Compose 使用基础 `compose.local.yml` 加 `compose.internal-updates.yml`，并在候选专用 overlay 的
   `services.api.environment` 设置 `REMI_SLOT_SWITCH: "1"`、`MUL172_ISOLATED: "1"`。
   保持单 `all` API、不设置 `MULTIREMI_PEER_URL`。容器内 edge 公开 6120，slot 仅回环 6121/6122。
   保留默认 180000 ms 观察期，必须覆盖实际放流后 30 秒崩溃。不要将观察期缩短来获得通过结果。
4. 将候选 control 卷以独立 bind mount 提供给执行器；`controlDir` 指向其中的 `api` 目录。
   执行器必须有该目录的读写和 `edge.sock` 连接权限；socket 为 0600，不放宽权限、不公开控制接口。
   初始 `status.json` 要求心跳新鲜、`slotSwitch:true`、`releaseId=v1`、live child 存在。
   配置的候选端口必须经过这同一个 supervisor 的 edge。先用 `/readyz` 的 slot/version/term 与 status 对账。
5. 候选使用真实 daemon，provider 指向仓库的独立 [fake-acp.ts](../../deploy/zadig/ppe/fake-acp.ts)：
   候选 daemon 的 `REMI_CODEX_AGENT_ACP_EXECUTABLE` 指向该文件，Bun 为 1.3.14，配置八个独立
   codex Agents、八个各自可运行的 Session 和足够的并发 lane 容量。daemon 的 state/HOME/workspaces、
   `PPE_ACP_EVIDENCE_DIR`、CLI server URL 都指向候选。`PPE_ACP_REMI_ENTRY` 指向候选源码的
   `apps/remi/main.ts`；不要使用宿主默认 CLI 连接 stable。清空 `PPE_ACP_PAUSE`。
   另建第九个仅供读写探测的 Session。使用该候选自己的 human credential；不能用本 Issue 的 task token。
6. 准备五个完整、相同 `dataSchema` 的 retained release。v1/v2 使用不同 releaseId/version，
   v2 不修改 schema；三个坏版本是相同真实 API 的专用测试 release，按下面的包装器注入故障。
   通过正常打包/安装流程放入候选 program 卷并保留 complete.json，不能只创建假的 manifest。
   首先通过 updater 选到 v1，再运行驱动。

## Operator 可执行入口

以下命令由有 Docker 权限的 Operator 执行；Agent 不申请 Docker/docker group 权限。
先合入准备 PR #131，待 A4 #123 合入后，另建干净源码 checkout，固定其最终合入 SHA；
该 checkout 必须包含 A4 和 MUL-178，不用未合入分支 head 代替最终 SHA。
操作脚本来自已合入的准备 PR checkout，候选构建源码由 `A5_SOURCE_DIR` 单独指定。

```bash
# 在包含本操作脚本的仓库执行；仅替换以下两项实际值。
export A5_SOURCE_DIR=/absolute/clean-candidate-checkout
export A5_MERGED_SHA=<A4最终合入的40位SHA>
export A5_PROJECT=remi-a5
export A5_API_PORT=26120
export A5_WEB_PORT=23000
export A5_DATA_DIR="$HOME/.local/share/$A5_PROJECT"
node scripts/phase-a/operator.mjs init
# 仅候选控制目录需要容器 UID 1000；由 Operator 设置，不更改 Docker socket。
sudo chown 1000:1000 "$A5_DATA_DIR/control"
node scripts/phase-a/operator.mjs build
node scripts/phase-a/operator.mjs up
node scripts/phase-a/operator.mjs collect
```

`init` 不调用 Docker，生成独立随机数据库/API/updater 凭据、Compose env、A4 overlay 和环境声明，
已有文件时拒绝覆盖。默认数据目录为 `$HOME/.local/share/remi-a5`；不放入源码目录，避免污染构建。
Postgres、program、HOME、seed、state 使用 `${A5_PROJECT}_*` 命名卷；只有 control 绑定到该数据目录。
API/Web 仅绑定 loopback。`build` 再检查源码 SHA 与干净状态。`up` 使用基础 Compose 与 internal-updates
及专用 A4 overlay。使用同一组参数执行后续命令，避免误操作别的项目。
若宿主执行器不是 UID 1000，应由 Operator 以 UID 1000 运行驱动并提供私有 HOME、Chromium 和凭据，
不要放宽 edge.sock 的 0600 权限。

这组命令完成候选基础设施准备，仍需按上方第 5–6 项配置独立 daemon、九个 Session/八个 Agent、
安装五个真实 retained release 并通过 updater 选到 v1；没有自动创建这些对象。
不得在凭据文件中复用 stable 配置；`compose.env`、`api.env`、`updater.env` 不上传。
`collect` 将容器状态、镜像 ID、控制状态、edge 和受限日志集中写到 `$A5_DATA_DIR/evidence`，
缺失证据写入 collection.json 并返回非零。日志名带 `.private`，操作员检查脱敏后才可上传。
另将 PG 隔离标识、provider 配置和 updater journal 存入该目录；不把声明 SHA 当成镜像来源证明。

## 坏 release 注入

仅在三个坏 release 内保存原 API 入口为同目录的 `real-main.ts`，将
[fault-preload.mjs](../../scripts/phase-a/fault-preload.mjs) 复制到该入口同目录。
新的 `apps/server/main.ts` 用如下包装器（每个 release 替换 mode 和 releaseId）：

```ts
import { installFault } from './fault-preload.mjs';
installFault('never-ready', 'mul172-never-ready');
await import('./real-main.ts');
```

真实入口与它的相对依赖必须保留，完成包构建后再核对这些文件被包含。其余 API、PG、daemon/provider
路径不作替换。三个 mode：

| mode | 注入与证据 |
| --- | --- |
| `never-ready` | 真实 API active 后将原本为 200 的 `/readyz` 改为 503；standby status 保持真实行为；记录 `active_ready_denied` |
| `activate-crash` | 在真实 API 收到 activate POST 时退出进程，退出码 86；记录 `activate_exit`，不是返回 503 |
| `crash-after-30s` | 候选 active 后首次收到 edge 转发的成功 readyz 时开始计时，30 秒后退出码 87；记录 armedAt 和真实 `public_live_exit` 时间 |

包装器要求候选显式设置 `MUL172_ISOLATED=1`。证据以原子 rename 保存到候选控制目录
`api/mul172-fault-<releaseId>.json`；驱动要求故障记录晚于本次切换请求，避免旧记录误判。
三个 bad release 不得进入正式 release feed。包装器不提供生产故障开关。

## 运行与切换

在拥有候选控制卷权限且已安装 Chromium 的候选宿主上，使用 Node 22、Bun 1.3.14，
从干净的提交执行；`bun install --frozen-lockfile` 提供已有的 playwright-core 依赖。
复制 [candidate.example.json](../../scripts/phase-a/candidate.example.json) 到 `$A5_DATA_DIR/candidate.json`，
设置 profile 为 `$A5_PROJECT`、baseUrl 为 `http://127.0.0.1:$A5_API_PORT`、controlDir 为
`$A5_DATA_DIR/control/api`，替换所有占位符和实际 SHA。示例使用 120 秒流，为故障/回退留出余量：

```bash
bun install --frozen-lockfile
# 从候选凭据存储安全注入 MUL172_TOKEN；不要写入 JSON 或报告。
node scripts/phase-a-acceptance.mjs "$A5_DATA_DIR/candidate.json" "$A5_DATA_DIR/evidence"
node scripts/phase-a/operator.mjs collect
```

需要执行器本身能启动 Chromium；使用具有正常 sandbox 支持的宿主用户。驱动不会关闭浏览器 sandbox。
脚本只允许 loopback 独立高位端口（默认 26120，拒绝 16120）和 `remi-a5`/`remi-a5-*` profile，
拒绝 canonical 路径中的 stable 控制卷。
这些检查防止常见误配，不能替代操作员对数据库、容器和端口归属的核验。

十个场景按顺序执行：v1→v2；v2→v1→v2 交替六次；三个坏版本。每个场景并发发出至少八个新请求，
每个假 provider 在实际 CLI 范围读取并确认回执后持续输出 60–120 秒 trace（默认 90 秒）。
等待全部 running 后启动 Chromium 原生 WS 订阅其中一个 attempt；再次确认八个轮次仍在运行才切换。
每次原子写入新的 desired revision：

```json
{"revision":"unique-per-switch","mode":"run","releaseId":"complete-retained-id","strategy":"switch"}
```

每 100 ms 通过同一 edge 发 `/readyz`、鉴权 Session 消息读取、`to:none/wake:inbox_only` 的写入。
写探测不会唤醒 Agent；它会在独立 probe Session 中留下数据，运行后可删除整个候选。
探测并行，等待中的请求不会延迟下一组发起；每个请求的超时为 360 秒，超时记为失败。
容量上限超过 12000 个 pending 请求同样计失败。所有响应均消费至 body 结束再判成功。
`expectedTicks` 按固定单调时钟时隙累计，与 `tickCount` 比较；允许最多 50 ms 调度抖动。
`missedTicks` 或 `lateTicks` 非零会令场景失败，持续 190 ms 降频不能通过。

正常切换要求本 revision 的 `succeeded` 和目标实际 releaseId；坏版本要求 `rolling_back→failed`、
实际 releaseId 返回 previous、真实故障证据以及最终 readiness/version 对账。
切换控制最久等待 15 分钟；任一场景失败即停止后续场景并保留当前状态，不盲目再次发布。
每个场景等待确认期结束及轮次终态后才开始下一个。180 秒观察期会长于 90 秒轮次，
正常场景的轮次必须覆盖实际切换阶段，不要求覆盖整个观察期；坏版本场景另要求八轮覆盖实际故障和回退完成。
切换前再次检查剩余流式时间，30 秒崩溃场景至少预留 45 秒（其余 15 秒）；这只是前置门槛，
最终仍按实际故障/回退时间判定，时间不足即失败。每个场景重新创建八个轮次。

## 读结果和验收边界

`report.json` 随场景写入，包含脚本提交 SHA、声明的候选 SHA、前后 edge 计数差、三类探测计数、
阶段时间、每个 Turn 的最终状态/attempt 列表、故障记录和浏览器重连/补读结果。
脚本不保存 token、HTTP 响应 body、任意进程日志或原始 trace 文本。

- `edge.errors`（502/503/504）与 `edge.upstreamErrors` 必须全部为 0；计数器缺失或重置直接失败。
- 三类 `client.failures` 必须全为 0；不仅检查 readyz。`total` 必须非零。
- 每个 Turn 必须 completed、仅一个 completed attempt，且起止时间覆盖切换，坏版本还须覆盖故障及回退完成；
  `runtime_recovery`、lost、daemon_timeout、input_gap、platform_input_rejected 任一出现都失败。
- `holdSamples` 为约 100 ms 采样的 wall time，短 hold 可能漏采，不是精确日志；
  `edge.holdMs` 是各请求排队时间之和，不能作为 wall hold 时长。需要精确 hold 时间时必须另采 supervisor/edge 状态事件。
- 浏览器必须确实收到 ack 和 WS trace 帧，最终通过 HTTP `view=events` 分页将 1..head 补齐并确认 closed。
  gap 允许通过 HTTP 补齐，`complete:true` 不代表 Phase B 无 gap 续订已通过。
- 退出码 0 仅表示十个 supervisor 场景通过。`phaseAAccepted:false` 明确保留完整 updater 部署、
  Web 对齐和环境证明的未验项；不得将其改写为已通过。

报告引用“之前”基线：MUL-25 评论 `cmt_nyrok52lrwo3`，2026-11-17 部署 `ca654768f`，
`tsk_g9xb5353762j` 的 daemon_timeout 和 `tsk_elwh9tq1t7t5` 的 input_gap/platform_input_rejected。
真实验收后将 report.json、环境证据、精确 hold 日志、updater journal 一起作为附件回帖 MUL-172，附脚本 SHA。
没有运行候选时，只能上传“未执行/受阻报告”，不能创建零失败数据。

## 失败恢复

先保留 report、status、slot-selection、故障文件、edge status、updater journal 和容器日志。
如果自动回退已完成，确认旧 releaseId 和 readyz 200，不把 desired 文件仍指向坏版本误认为回退失败。
停止驱动只会停止采样，不会删除候选或撤销已写 desired；残留测试轮次最长 120 秒后结束，须检查其终态。

若要人工回旧版本，仍通过 supervisor 原子写新的 revision 和已保留的旧 releaseId，
等待对应终态及 actual releaseId，再经正常 updater 流程对齐 Web/current.json。不能直接 setState 绕过 fence。
如果需恢复旧单进程路径，先停止切换操作，在**候选** overlay 将 `REMI_SLOT_SWITCH` 设为 `"0"`，
重新创建 API/updater 容器；此操作会重启 API，走已有 drain/backup/rehearsal 路径，不承诺零中断。
验证旧 release/readiness/daemon 恢复后再清理候选专属 Compose 项目和卷。禁止对 stable 执行上述清理。

## 本地回归（不等于候选验收）

```bash
node --test scripts/phase-a/support.test.mjs
bun run test tests/unit/scripts/ppe-fake-acp.test.ts tests/unit/scripts/phase-a-faults.test.ts
bunx tsc --noEmit
npm run docs:test
npm run docs:check
```

本地测试分别覆盖 Unix 控制/计数器/失败判定、真实 ACP 60 秒流及取消、假 handler 上的实际进程崩溃。
它们不启动真实 PostgreSQL/internal-updates Compose，也不证明完整 Phase A 已通过。
