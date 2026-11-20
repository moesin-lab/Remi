---
title: B1 历史库首次升级
status: active
summary: 历史 level 0 的离线准备、失败处置与部署预检；保留当前数据，不恢复备份。
---

# B1 历史库首次升级

B1（#126，`b9c643605` 起）禁止已有历史库在 API 启动时重跑历史迁移。
缺少 `multiremi_schema_meta` 表表示 level 0，不表示空库。2026-11-19 的 stable
事故在历史写入前被启动守卫拒绝；旧容器被替换才导致停机。

2026-11-20 已完成 stable 首次 B1 升级，部署版本为
`aa9a924a90da415dc78822e1b7bc2fae6a7e1280`（MUL-315 操作者实测记录）：

- 离线准备前备份目录：`~/.remi/profiles/stable/backups/2026-11-20T04-50-53-671Z/`；
  `complete.json` 完成时间为 04:51:07.705 UTC，备份约 15 秒。
- `db prepare` 于 04:52:16–04:52:21 UTC 执行，用时 4.9 秒、退出码 0；
  从 level 0 到 expand 3 / contract 0，目标代码兼容区间 [3,3]。
- 从停 API 到新 API healthy 的停机窗口约 3 分钟；迁移前后各主表行数完全一致，
  具体计数和单次样本的时间预算见下文。本记录不将容器 healthy 等同于登录、daemon 重连等全部业务验收。

## 预检与部署边界

`node scripts/local-profile.mjs stable deploy --ref <完整 SHA> ...` 获取候选镜像后，
在停止任何旧容器之前从候选镜像读取 `schema-compatibility.json`，对当前 PostgreSQL 执行只读检查：
历史表是否存在、元数据是否有效、contract floor 是否允许目标代码运行。
历史 level 0 遇到 B1 目标时立即拒绝，给出 `remi db prepare` 指引并恢复旧配置，旧容器继续运行。
查询失败、损坏声明或损坏元数据同样拒绝。低 expand level 允许由版本化加法迁移升级，
更高 expand level 不会单独阻止旧代码运行。旧目标没有 B1 声明时不要求登记。

2026-11-20 04:44–04:49 UTC 对 stable 的实际预检：构建目标镜像后输出
`Historical schema preparation required. Old services have not been stopped...`，
退出码 1；旧容器全程保持 healthy，验证了拒绝发生在停止旧服务之前。

internal updater 的 release preflight 也读取当前库。历史 level 0 遇到不同 schema 指纹时，
保守拒绝自动更新（manifest 指纹不携带可逆的 level 信息）。下载并验真后的目标声明还会在
probe、drain、停止监管子进程之前复查，包括 contract floor。此流程不会自动 prepare。
只选择报错并人工维护的方案，**没有 `--prepare true` 选项**。

local-profile 若新 API/Web 启动或健康等待失败，会停止失败候选、恢复上一份 Compose 配置，
启动并检查旧版本。数据库和 API home 保持当前内容，不调用 `pg_restore`。
回退成功仍以非零退出报告原部署失败；回退失败则明确报告需人工恢复容器，保留备份路径。
自动容器回退不是任意历史迁移的兼容性证明，也不会撤销已提交数据库变化。

## 获批维护窗口内的顺序

1. 固定并核验目标 SHA 与 API 镜像，预先拉取/构建；记录当前 `active.json`、镜像 ID、
   schema 状态及任务状态。等待运行中任务完成，暂停更新器和外部调度，关闭自动重启入口。
   不使用宿主旧版 `remi` 执行新版本维护命令。
2. 停止**所有**连接该库的 API slot（active、standby 均包含）、独立数据库 worker、
   updater 和其他 SQL 客户端。标准本机布局可先运行
   `node scripts/local-profile.mjs stable stop`，再只启动 PostgreSQL；非标准拓扑需逐项清点。
   daemon/provider 是独立进程，不因 API 停止而证明任务已结束，先完成排空。
3. 保持 API/Web 停止，执行 `node scripts/local-profile.mjs stable backup`。
   保存本次 `complete.json`、数据库 dump、API home（包括 `reports/migrations`）和旧配置。
   这份备份用于审计保全；本流程**禁止恢复数据库备份**。
4. 用目标镜像、相同数据库与 API home 运行一次性维护进程。以下为标准本机 Compose 示例，
   先将已核验的 API 镜像引用写入 profile 外部的 `target-api.json`：

   ```json
   {"services":{"api":{"image":"<已核验目标 API 镜像引用>"}}}
   ```

   ```bash
   # profile-root 为本机 ~/.remi/profiles/stable 的绝对路径。
   # 仅启动 PostgreSQL；不要 up 整组服务。
   docker compose -p remi-stable --env-file <profile-root>/compose.env -f <profile-root>/compose.yml up -d --wait postgres
   docker compose -p remi-stable --env-file <profile-root>/compose.env -f <profile-root>/compose.yml -f <target-api.json> run --rm --no-deps api bun run apps/remi/main.ts db prepare
   docker compose -p remi-stable --env-file <profile-root>/compose.env -f <profile-root>/compose.yml -f <target-api.json> run --rm --no-deps api bun run apps/remi/main.ts db schema
   ```

   `db prepare` 和 `db schema` 的数据库连接串来自 `api` 服务环境中的
   `MULTIREMI_DATABASE_URL`；`docker compose ... run --rm --no-deps api bun run ...`
   会继承该服务的环境配置（标准 Compose 从 `POSTGRES_PASSWORD` 等配置构造连接串），
   无需在宿主额外导出连接串。直接在宿主或目标解包目录运行时，必须自行提供同一数据库的
   `MULTIREMI_DATABASE_URL`，且使用 `postgres://` 或 `postgresql://` URL。
   未设置、值为空或前缀不符时，命令报
   `Fatal: Set MULTIREMI_DATABASE_URL to the PostgreSQL database for this maintenance operation`。
   `db prepare` 没有 `--yes` 或其他选项；不要因其 `mutation: 'destructive'` 声明添加参数。

   保留退出码、schema 输出和迁移报告。已有 internal/application 覆盖文件的安装不能照搬上述命令：
   应停止监管子进程及 updater，在目标解包源码目录用其配套 Bun 执行同一命令，挂载原 API home，
   使用原数据库环境；不得通过直接 deploy 覆盖内部安装。维护命令持有迁移 advisory lock，
   并检查该数据库的其他 client backend 为零；包括监控/只读连接也必须断开。
5. 只有 prepare 成功、schema 查询达到目标 expand 且 contract 合法、持久报告存在后，
   才启动目标 API/Web。标准布局重跑 `stable deploy --ref <已核验 SHA> ...`，
   预检此时应通过。检查 `/readyz`、登录、旧 Issue/Session/任务数量和 daemon 重连，
   再恢复调度与更新器。健康端点不替代业务验证。

## prepare 会做什么、失败后怎么办

实现为 [databaseCommandSpecs](../../apps/remi/cli/commands/database.ts) 的显式维护入口，
调用 [runMigrations](../../packages/server/src/store/migrations.ts) 的 `historicalMaintenance:true`。
它先检查 contract floor，再执行冻结的历史链，最后登记 `multiremi_schema_meta` 和
`multiremi_schema_steps` 并执行目标版本 expand。不能只手工创建元数据表来绕过准备。

历史链按已有标记决定跳过还是执行：可能添加列/索引、重建历史消息/turn/lane 数据与投影，
处理 inbox/read state/decision、attempt input/counters、Chat 归属与队列、执行配置、
local records、Feishu、usage schema、daemon drain/planned restart 等。
涉及 `multiremi_schema_migrations`、消息/轮/尝试/会话/收件箱及配置相关业务表，
并在 API home 写持久迁移对账报告。已经统一模型的库走较短分支，但仍有 ensure、扫描与索引检查。
level 1 登记协议，level 2 创建 `multiremi_live_terms`，level 3 补 daemon drain identity
及 planned restart 表/索引。B1 的 usage scalar 历史回填在新 active slot 后台分批执行，
不把其完成时间算作 prepare 已完成全部 usage 报表的承诺。

整个历史链**不是一个大事务**。事务内失败回滚当前步骤；先前已提交的步骤、标记及文件报告保留。
版本化 expand 的 SQL、完成记录和 level 更新在同一事务内，不会只推进 level。
正常重复执行按步骤标记和 ensure 逻辑幂等；修复根因后使用**同一目标版本、同一 API home**重试。
幂等不表示可以同时运行旧 writer，也不表示任意损坏数据可自动修复。

失败时保持所有 writer 停止，保存错误与报告，确认具体步骤及是否有已提交变化后修复并重试；
不要删除步骤记录、降低 level 或恢复数据库备份。若错误在“其他客户端在线”、目录权限预检等
首个数据库修改之前，则数据库未被该 prepare 修改，可取消维护并启动原版本。
若已经进入历史链，**不能仅凭失败退出码保证旧版本可继续启动**：旧版不读取 B1 contract 守卫，
但可能无法解释已提交的历史重建/投影。stable 的旧版已包含大部分历史步骤，新登记 expand 为加法；
这说明预期兼容方向，不是该实际库 prepare 失败后的旧版读写验证。
应以步骤日志和独立兼容验收决定是否恢复旧容器；没有证据就继续离线修复并重试目标，不能自动恢复旧 writer。

## stable 实际规模与时间预算

2026-11-20 stable 首次离线准备的数据规模为 171 表、约 23 万行。
迁移前后主表行数完全一致（表名省略 `multiremi_` 前缀）：

| 表 | 迁移前 | 迁移后 |
|---|---:|---:|
| issues | 313 | 313 |
| turns | 2,172 | 2,172 |
| turn_attempts（attempts） | 2,226 | 2,226 |
| agents | 18 | 18 |
| workspaces | 1 | 1 |
| conversation_log | 12,822 | 12,822 |
| usage_units | 56,817 | 56,817 |

`db prepare` **已实测一次：约 5 秒**（精确用时 4.9 秒，04:52:16–04:52:21 UTC，
退出码 0）。schema 从 level 0 升至 expand 3 / contract 0，目标兼容区间 [3,3]。
整个停机窗口约 3 分钟，其中备份约 15 秒。
仍建议预留 **5–10 分钟**维护窗口，以包含备份、离线准备与启动验证。
这是单次样本，不是 SLA 或迁移耗时上限；数据规模、磁盘、锁等待及启动状态均可能影响耗时。
主表计数一致和 API healthy 不替代第 5 步的业务验证，也不表示后台 usage 回填已经全部完成。
