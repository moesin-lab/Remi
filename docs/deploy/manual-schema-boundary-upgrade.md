# 跨归档收缩边界的手动升级与恢复

适用：从 v0.2.90（`0aa459ba2d841940b694d4b144a96421b85cf12d`）及更早的旧归档安装，升级到包含 [ADR 0018](../adr/0018-local-records-and-recyclable-workspaces.md) 的版本。本文以 v0.2.90 为演练源；更早版本须单独演练其完整迁移链。第一个正式边界版本号由 MUL-36 发版时填写，不把当前 main 当作已发布版本。

自动 application 更新仍要求声明真实的 `rollbackSafeFrom`，并在隔离 PostgreSQL 中依次运行目标和旧版迁移，保留全部旧列签名（含类型和可空性）。跨此边界会拒绝自动更新；不引入允许收缩的开关。`operation.progress.failure.reason=schema_contract_refused` 区分本次拒绝与其他迁移失败，包含 current/target 版本、target/previous 检测阶段、消失表数、存续表的消失列数、类型/可空性变化数、受影响旧列总数，以及合计最多 20 条按确定顺序截取的示例。表重命名对旧契约而言仍是表消失。其他拒绝（例如缺少兼容声明或迁移报告）可能先发生。

旧 `multiremi_session_archives` 重命名为 `multiremi_legacy_session_archives`，归档 trace 指针复制到 `multiremi_legacy_trace_pointers`；归档 ZIP 不由此迁移删除。旧 archive requests、trace backfill progress 被删除，旧 trace 指针标记 lost，原生会话绑定作废。legacy 留存供人工恢复调查，新程序不提供旧归档读取能力。不要删除旧 ZIP、legacy 表或迁移标记来让升级通过。

## 准备与停写

在隔离副本完整演练以下步骤后再安排运维窗口。固定旧/新程序 SHA、镜像 digest、对应运行时、配置和完整 Compose 文件集合；下载验证新版本但不启动。检查空间，备份需放在待恢复卷之外。记录任务/Issue/归档/指针等关键行数、全部列签名和归档文件 SHA-256。

禁用每日自动更新，停止 updater（host 服务或 internal 的 `updater`/`rehearsal`），确认没有运行中 operation。使用平台 drain 等待所有在线 daemon ack、运行任务归零；停止 API/Web 和所有 API role（包括 api-runtime），再停止离线/外部写入端。维护期间从入口封锁业务流量，保持 daemon 不接新工作；不要依赖有时限的 pre-switch drain lease 在 API 停机期间长期锁住平台。以下命令必须在已停写后运行。

- **host_application**：保留原 project、env 文件和所有 overlay，尤其 `compose.application.json`/`compose.host-control.yml`。停止 host updater 后用同一组 Compose 参数停止 api/web/api-runtime。备份 host state（`application-current.json`、history、journals、control）、配置、原镜像和 application releases 卷；新版本的应用选择与基础镜像必须匹配，不能仅改 `current-release.json`。
- **internal_application**：使用同一 project、env 文件和 `compose.internal-updates.yml`；先停 updater/rehearsal，再停 api/web/api-runtime，避免 supervisor 自动重启孩子。备份 program、api/web-seed、update-control、update-state、API HOME 和外部配置。跨边界采用已核验的目标基础镜像重新建 API/Web seed 与 program/control/state 卷的独立集合，在隔离 project 中先验证；不要混用旧 selection 与新 seed，也不要在原卷内清空 journal/fence。数据服务和 API HOME 使用明确选定的迁移副本。内部更新模式的 adopting/mode 切换约束仍见[部署文档](../../deploy/README.md#internal-compose-updater)。

## 备份、迁移和校验

以下是与 PostgreSQL 集成演练一致的核心命令；`PG_CONTAINER`、`PG_USER`、`PG_DATABASE`、`API_HOME`、`BACKUP` 均由运维明确指定为本次停写安装及外置目录。保留原程序/配置选择状态另作成套备份。容器名称不使用生产示例，密码不写入命令或证据。

```bash
mkdir -p "$BACKUP"
docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -d "$PG_DATABASE" -Fc > "$BACKUP/database.dump"
docker exec -i "$PG_CONTAINER" pg_restore --list < "$BACKUP/database.dump" > "$BACKUP/database.list"
tar -C "$API_HOME" -cf "$BACKUP/volume-api-home.archive" .
tar -tf "$BACKUP/volume-api-home.archive" > "$BACKUP/api-home.list"
sha256sum "$BACKUP/database.dump" "$BACKUP/volume-api-home.archive" > "$BACKUP/SHA256SUMS"
```

API HOME 必须包含旧归档目录和 `reports/migrations`，包括本次统一模型 before/after 报告；自定义 `MULTIREMI_MIGRATION_REPORT_DIR` 的路径也要一并备份。缺失报告时停止，不删除迁移标记绕过报告门禁。

在**停写的迁移副本**上，用固定目标源码及其依赖/运行时启动 Store 迁移（真实 API 启动也执行此过程），HOME 指向本次 API HOME 副本：

```bash
MULTIREMI_DATABASE_URL="$MIGRATION_DATABASE_URL" MULTIREMI_HOME="$MIGRATION_API_HOME" \
  MULTIREMI_MIGRATION_REPORT_DIR="$MIGRATION_API_HOME/reports/migrations" \
  bun --eval 'const {openMultiremiDatabase}=await import("./packages/server/src/store/db/postgres.ts"); const {MultiremiStore}=await import("./packages/server/src/store/store.ts"); const db=openMultiremiDatabase(); try { new MultiremiStore(db); } finally { db.close(); }'
```

使用 PostgreSQL 原版本或已验证兼容的新版本。源/目标依赖必须各自安装，不以手写 DDL 代替旧迁移。与升级前比较全部 `information_schema.columns` 签名：

```sql
SELECT table_schema||'.'||table_name||'.'||column_name||':'||data_type||':'||udt_name||':'||is_nullable
FROM information_schema.columns WHERE table_schema='public' ORDER BY 1;
```

核对业务行数与内容，legacy archives/trace pointers 行数及 sha256/路径与旧值一致、旧请求/回填表消失，归档文件哈希不变。确认迁移报告完整。先在封闭入口启动新 API/Web，校验 readyz、登录页、实际版本/SHA、Issue/任务读取和新会话行为；任一失败保持入口关闭，按下一节恢复。验证通过后再打开入口、恢复 daemon 和自动更新；今后只有经过兼容审查的收缩后基线可自动升级/回切。

## 失败时成套恢复

跨此边界不承诺只切代码可回退。保持所有写入端、updater 和业务入口关闭，验证 `SHA256SUMS`，将 dump 恢复到**新空库**、HOME 归档解压到**新空目录/卷**，避免新版本遗留表/文件混入。不要把旧程序连到已经收缩的数据库。

```bash
sha256sum -c "$BACKUP/SHA256SUMS"
# RESTORE_DATABASE 是新建空库，绝不与源库同名；RESTORE_HOME 是新建空目录。
docker exec "$PG_CONTAINER" createdb -U "$PG_USER" --template=template0 "$RESTORE_DATABASE"
docker exec -i "$PG_CONTAINER" pg_restore -U "$PG_USER" -d "$RESTORE_DATABASE" \
  --no-owner --no-privileges --exit-on-error --single-transaction < "$BACKUP/database.dump"
mkdir -p "$RESTORE_HOME"
tar -C "$RESTORE_HOME" -xf "$BACKUP/volume-api-home.archive"
```

恢复后的列签名集合必须与备份前完全相等；关键行数、归档路径/哈希、迁移报告也须一致。恢复匹配的旧配置、程序/运行时及选择状态：host 模式恢复 application release 卷和 host state/overlays；internal 模式恢复同一批 program/seed/control/state 卷及旧镜像。连接恢复的新库与 HOME 后，先在封闭入口启动旧程序，确认旧 SHA/版本和 readyz、登录页、读取行为，再开放流量。未验证成功时保留 fence/备份并继续维修，不手动解除 maintenance 来宣称恢复成功。

## 发版列车检查清单（MUL-36）

- 填写首个正式手动边界版本号、目标 SHA/digest、支持的收缩后自动升级基线；发布说明明确「≤v0.2.90 不能自动跨越本边界，按本手册停写、备份、迁移；回退须成套恢复」。
- 声明旧归档/原生会话处理和失去旧归档读取能力，不把 legacy 留存描述为产品读取兼容。
- 核对真实 `rollbackSafeFrom` 与严格 schema gate，不伪造跨旧归档边界的兼容声明。
- 附本 PR Linux PostgreSQL 演练的固定 SHA、实际命令、前后 shape、行数、归档哈希、恢复完全一致及清理证据；没有证据不得标为已验证。
- MUL-27 正向 drain→升级→回滚使用批准的收缩后基线，旧 v0.2.90 作为预期拒绝；其 PR 独立保持严格断言。
