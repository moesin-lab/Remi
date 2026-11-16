---
title: 自用实例接入产品更新链路
status: active
summary: 将手工 local-profile 和 daemon 迁移到 internal updater 与稳定 launcher，保留维护窗口和退回边界。
---

# 自用实例迁移

本手册是 MUL-26 的迁移准备，不能作为线上已切换的证明。先在 MUL-27 隔离实例演练，
再由负责人汇总到 MUL-25，取得人工批准的维护窗口后执行线上步骤。
不得在开发验证中修改 `~/.remi/profiles/stable`、重启线上 `multiremi-daemon.service`
或占用 6131–6134。平台和 daemon 自动更新在 MUL-28、MUL-30 完成前保持关闭。
本单不发布正式 Release、不打 tag、不合并 main。

## 选择和前置条件

选 **internal**，复用 [Compose overlay](../../deploy/docker/compose.internal-updates.yml)
和 supervisor v1。当前目标是标准 API/Web/PostgreSQL，internal 不需要宿主 Docker socket，
应用和 Bun/Node 在版本卷中切换，数据库/API home 经备份和隔离恢复演练后才激活候选版本。
宿主 application 模式需要宿主常驻 updater、Docker CLI 和独立备份配置，而且未来仍须迁移
到监管进程模式，故本次不选。基础 OS、监管器及 updater 镜像仍需单独维护。
额外持久挂载或 split api-runtime 拓扑不在标准 overlay 覆盖内，发现后停止并扩展备份设计。

操作者须在**目标机器、目标用户、目标 Docker context**核实以下事项，并将脱敏证据存档：

- 保存 `remi platform status --json`、`remi platform operation list --json`、
  `remi runtime list --json`、`remi daemon list --json` 和 `remi --version`。
  本单起点是 updater offline、driver 为 `systemd_release`，实际服务却是 Compose。
  必须不存在排队/执行中的更新和未恢复 journal，所有承载任务均已排空。
- 记录 Compose project、`active.json`、`deployment.json`、镜像 ID/digest、公开 API/Web URL、
  卷挂载和额外 env。不要仅凭 `remi-stable` 名字猜线上实际 project；不改 project 名或卷名。
- 检查选定 API/Web 镜像内 `/usr/local/lib/remi/supervisor.mjs` 存在且是协议 1；
  基线 Dockerfile 包含该文件不能证明线上旧镜像一定包含它。核对 API/Web/updater 同一源提交，
  固定不可变 digest，并预先拉取。updater image 来自该提交 CI 或正式发布的元数据。
- 保存 `systemctl --user cat multiremi-daemon.service` 和
  `systemctl --user show multiremi-daemon.service -p ExecStart -p FragmentPath -p DropInPaths`。
  这些输出可能含私有路径/环境，按私有配置保存，不贴完整 unit 或 token。
  保存原 unit、整个 drop-in 目录、PATH 上原 CLI/launcher、provider/state/port 参数。
- 核实磁盘能同时容纳保留版本、数据库和 API home 备份及恢复演练；rehearsal 的默认 `/tmp`
  预算为 2 GiB，数据库超出时先调整预算。现有宿主 updater 必须停止并禁用，不能双写。

## 备份与持久化边界

以实际 project 为准，默认 local-profile 的卷名如下。迁移、回退均不得 `down -v` 或删除卷。

| 默认卷/配置 | 用途与恢复边界 |
|---|---|
| `remi-stable_postgres-data` | 线上数据库；updater 用 pg_dump，不直接复制运行中的 PG 数据目录 |
| `remi-stable_api-home` | uploads、文件和应用状态；updater 只读挂到 `/remi-data` |
| `remi-stable_program` | 保留的代码、Bun/Node 与当前选择，不自动删除 |
| `remi-stable_api-seed` / `remi-stable_web-seed` | 原基础镜像的恢复程序，由 supervisor 初始化 |
| `remi-stable_update-control` | supervisor 命令、状态、维护写闸门；不可擅自清空 |
| `remi-stable_update-state` | current/history、操作 journal、`backups/` 校验备份 |
| profile 的 `api.env`、`compose.env`、Compose/active/deployment/credentials 文件 | 含密钥，窗口前单独保存到受限目录，备份目录权限 0700、文件 0600 |
| 外部 updater env、原 daemon unit/drop-in 和 CLI | 不在内部备份卷内，单独加密/受限保存 |

内部备份位于 `update-state:/remi-state/backups/`，包含 `database.dump`、
`volume-data-0.archive` 和校验 manifest；只有完成校验的备份才可用于恢复。
`REMI_INTERNAL_BACKUP_PATHS=/remi-data` 与 overlay 的 api-home 挂载对应。
外部配置、provider 凭据和 daemon 工作区/outbox 不属于此平台备份的自动恢复范围，
不得把它们当可重建临时目录删除。更多挂载必须先补齐备份与演练契约。

窗口内、接入 overlay **之前**，用原手工布局运行
`node scripts/local-profile.mjs stable backup`，记录返回的备份目录，核对 `complete.json`
及每个文件的 SHA-256，确认 PG dump 和 API home archive 可读。该命令会短暂停写，
完成后恢复原本运行的 API/Web；它不是纯查询。另行保存上述外部配置和 systemd 文件。
备份后到接入前保持任务排空，不让新业务写入穿过迁移窗口。

## 准备 Compose 与手动 feed

以下配置先在受限的候选目录准备、审阅，不直接覆盖线上。沿用原 profile 的网络、密码、
公开 URL、Compose project 和原数据卷。使用[外部 env 模板](../../deploy/docker/internal-updater.env.example)，
填入与 API 相同的 `MULTIREMI_TOKEN` 和独立随机 updater token；把同一个
`MULTIREMI_PLATFORM_UPDATER_TOKEN` 加入候选 API env。不要提交真实凭据。

在候选 `compose.env` 中保留原变量并设置：

```dotenv
REMI_API_IMAGE=ghcr.io/moesin-lab/remi-api@sha256:<reviewed-api-digest>
REMI_WEB_IMAGE=ghcr.io/moesin-lab/remi-web@sha256:<reviewed-web-digest>
REMI_UPDATER_IMAGE=ghcr.io/moesin-lab/remi-updater@sha256:<matching-updater-digest>
REMI_UPDATER_ENV_FILE=/absolute/private/path/internal-updater.env
```

overlay 复用仓库文件，不另写一套服务定义。将其复制为候选 profile 的
`compose.internal-updates.yml`，用原 project、原 env 和两个 `-f` 运行
`docker compose ... config --quiet`；不要把解析后的含密钥完整配置打印到日志。
手工 Docker 操作必须保留全部参数，本机管理脚本会自动合并该 overlay。
不得叠加 `compose.application.json` / `compose.host-control.yml`。

首个 feed 固定到人工选定的正式版本：
`https://github.com/moesin-lab/Remi/releases/download/vX.Y.Z/platform-release.json`。
`X.Y.Z` 是待审批后选定的真实版本，不是本单要创建的 tag。
必须是 HTTPS、无内嵌凭据或 fragment、正式 SemVer；元数据需有 Linux/实际 CPU 的
application 包、摘要、bundled Bun/Node、schema/迁移兼容声明及 `updaterImage`。
仅有镜像的旧 feed 不足以通过 internal 预检。相同 schema 的候选和旧版均须可取得。
私有源还须确认 updater 容器真实能读取，不能用宿主 gh 登录成功代替容器验证。

窗口内保存原平台设置，用[手动设置模板](../../deploy/docker/platform-settings.manual.json.example)
填入同一 feed，通过 `remi platform settings update --file <private-settings.json> --yes --json`
保存。API 的 `releaseFeedUrl` 优先于 env 默认值，二者必须一致；同时保存
`autoUpdateStable:false` 和 `autoUpdate.enabled:false`，读回确认。不要尝试 PATCH updateMode，
它由实际 updater 上报。正式 release/tag 另需人工授权；隔离演练使用
`tests/integration/platform-application-smoke.ts --internal` 的测试 feed。

## 维护窗口接入

1. 再核对活动操作为空、任务排空、备份验证完成、维护授权和回退材料齐备。
   停止原 API/Web，保持 PostgreSQL 与 Agent 状态；安装审阅过的候选配置和外部 env，
   保留原配置副本。禁止重用其他 profile 的凭据。
2. 用原 project 和两份 Compose 文件启动 API/Web、updater、rehearsal；不删除原容器数据卷。
   如果原 API/Web 已含正确 supervisor，仍须受控重建以启用 overlay 的 command 和 mounts。
   等待 seed、supervisor、rehearsal 心跳齐备；不要手写 current.json 或清理写闸门。
3. 创建 `{"kind":"check_updates"}` JSON，通过
   `remi platform operation create --file <check.json> --yes --json` 发起，保存操作 ID。
   用 `remi platform operation get <id> --json`、`remi platform status --json` 等待终态。
   必须同时看到 updater online、driver `docker_compose`、updateMode `internal_application`、
   非空 currentRelease、`preflight.ready:true` 且所有 checks 为 true。check 操作 completed
   本身不代表 checks 通过。状态不满足时停止，保留 journal/备份并排查，不直接进入更新。
4. 首次接入 daemon launcher 按下一节操作。平台与 daemon 分开取证，不能用平台版本代替 CLI 版本。

## daemon 稳定 launcher

此步骤仅在人工批准的窗口执行，期间不可存在运行任务。先停止目标 daemon，再保存 CLI
和 systemd 配置；历史 `40-*`、`50-*`、`80-*` 等 **ExecStart 覆盖移到备份目录，不删除**。
逐个检查内容，若同时包含环境配置，先将必要非 ExecStart 行保留到审阅过的配置中。
不要使用 `systemctl revert` 一并清除未知配置。

使用本 PR 的 installer（首次可用已审阅的本地脚本）准备 CLI，显式设置：

```bash
MULTIREMI_VERSION=<approved-cli-version> \
MULTIREMI_BIN_DIR="$HOME/.local/bin" \
MULTIREMI_INSTALL_ROOT="$HOME/.local/lib/remi" bash scripts/install-remi.sh
```

它保留 `versions/<归档SHA256前8位>/` 中的 remi、ACP wrapper、runtime-bundle，
准备成功后才原子替换 launcher；旧裸二进制保留在 `previous-<version>/remi`。
SHA256 在 installer 中用于内容寻址，不能当作已与远端可信摘要核验的证据；
基线 installer 没有远端摘要核验，本地 `platform local-update` 另有 GitHub asset digest 核验。
不能以本单的布局修复声称统一了二者的校验机制。

以 [drop-in 示例](../../deploy/systemd/daemon-stable-launcher.conf.example) 为基础，保留原 foreground
参数、provider、state、port 和环境配置，只将 executable 改为 `%h/.local/bin/remi`。
写入唯一受控的 launcher drop-in，确认没有后续 ExecStart 覆盖，然后
`systemctl --user daemon-reload` 并启动原 unit。用有效 ExecStart 和进程命令行确认
它经过稳定 launcher，目标在 `~/.local/lib/remi/versions/`。

交互 PATH 把 `$HOME/.local/bin` 放到旧 CLI 之前，`hash -r` 后用 `command -v remi` 和
`remi --version` 验证。daemon 必须保留同一 BIN_DIR/INSTALL_ROOT，避免 runtime 更新装到别处。
**后续不要执行 `remi daemon service install`**：当前 installer 使用 process.execPath，会将 unit
重新指向版本二进制，此缺口另单修复。本次维护之后的普通更新不得再手工编辑 unit/Compose。

runtime CLI 更新实际下载 `releases/latest/download/install-remi.sh`。必须等本 PR 修复进入
已发布 release 后才通过该入口验收，否则旧脚本仍会覆盖 launcher。不要擅自指定未发布脚本
或把本地 fixture 验证当成已发布链路通过。CLI 自动更新策略保持原关闭状态；如无法确认关闭，
不得继续接入，由负责人与 MUL-28/MUL-30 确认。

## 隔离演练及验收记录

在 MUL-27 就绪后执行真实 Docker 演练，隔离地址、凭据、project、state、systemd user/service
和端口均与线上分开。基础 smoke 命令为
`bun run tests/integration/platform-application-smoke.ts --internal`，依赖见 [测试指南](../../TESTING.md)。
随后用该隔离实例的产品 CLI 入口保留以下证据，不以 mock 结果替代：

| 验收 | 操作与证据 |
|---|---|
| 接入前后状态 | 保存迁移前后 platform status；确认 offline/systemd_release 到 online/docker_compose/internal_application，currentRelease 和全部 preflight checks |
| 一次同 schema 平台更新 | 创建 `{"kind":"update","targetVersion":"<candidate>"}` operation；保留 ID、终态、旧/新 schema 和 currentRelease、API/Web readiness；日常更新中未编辑 Compose/unit |
| 一次 daemon CLI 更新 | `remi runtime release start <runtime-id> --file <request.json> --yes --json`，内容 `{"scope":"cli","targetVersion":"<candidate>"}`；记录 request ID，以 `runtime release status <runtime-id> <request-id> --json` 查终态，再检查新心跳 |
| 版本同源 | 保存 PATH CLI、launcher 指向、daemon get 与所有同机 runtime 版本，忽略展示用前缀 v 后必须一致；completed 不等于重启后的心跳已确认 |
| 失败与退回 | 保存 smoke 恢复日志、旧配置/备份路径、回退后 readiness 和任务 canary；重启后确认新请求仍经 launcher |

CLI 更新和回滚确认、canary 仍受 MUL-28/MUL-30 的门禁；本单演练不提前打开自动更新。

## 退回原手工布局

仅在新的批准窗口、任务和操作排空且没有未恢复 journal 时执行。若失败 journal/维护闸门
仍在，先由 internal updater 完成恢复并确认终态，不能删除状态卷或强行解除闸门。

1. 保存当前所有配置和七个卷的身份，保留内部 journal/备份/版本。
   用仍含 overlay 的原 Compose 命令先停止 updater 与 rehearsal，再停止 API/Web；
   PostgreSQL 保持原数据卷。不能先移除服务定义再尝试停止 updater。
2. 将 overlay 移到受限备份目录，移除 compose.env 中 `REMI_UPDATER_IMAGE` /
   `REMI_UPDATER_ENV_FILE`；恢复备份的手工 Compose、compose.env、active/deployment 和 API env，
   镜像恢复为备份的 `remi-api/web:stable-<sha>`，并核对镜像 ID，防止同名 tag 漂移。
   若期间变更了 URL/身份配置，逐项核对，不能盲目覆盖。
3. **仅在数据库兼容已证实且未发生不兼容迁移时**，用原手工 Compose 启动 API/Web，
   保留当前数据库与 API home，验证 readiness、登录、任务和文件。若 internal 期间发生过
   schema 迁移，退回旧镜像不再默认安全：停止，由负责人批准 DB/API home 快照的灾难恢复，
   明确会丢失备份后的写入；数据库与文件按配套快照恢复并先验证。不自动恢复旧数据库。
4. 停止 daemon，移走本次 launcher drop-in，逐个恢复备份的历史 drop-in 和原 unit；
   如 PATH CLI 被切换，恢复备份的 CLI/原 PATH。`daemon-reload` 后启动原 unit，
   确认 ExecStart、心跳和版本回到记录的手工布局。保留新的版本目录便于调查。
5. API 可用且活动操作为空后，经产品入口恢复旧 releaseFeedUrl，**保留自动更新关闭**。
   状态应真实显示 updater offline，不能伪造 online。保存回退原因、版本、备份身份和验证结果。

只退程序而保留业务数据是正常回退；完整快照恢复是独立灾难恢复。两者都需要真实
健康/任务证据后才能解除维护窗口，不以发出命令或容器 running 代替成功。
