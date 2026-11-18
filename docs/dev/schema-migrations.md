---
title: Schema level 与迁移纪律
status: active
summary: 启动兼容守卫、版本化 expand、离线历史准备、后台 usage 回填与发布混版证据。
---

# Schema level 与迁移纪律

Store 的生产入口是 [runStartupMigrations](../../packages/server/src/store/migrations.ts)。在既有
PostgreSQL advisory lock / SQLite migration file lock 内，首先检查 contract floor。
空库允许 bootstrap；有数据的 level 0 库拒绝自动升级，必须停止所有数据库客户端后执行
`MULTIREMI_DATABASE_URL=postgres://… remi db prepare`。这一次协议边界不能走在线 slot 切换。
历史链保留在同文件的维护路径，既有步骤标记和事务支持失败重试；它不是新 expand 的扩展位置。
已登记的库启动只执行 [版本化 expand 注册表](../../packages/server/src/store/schema-migrations.ts)，
不会重跑历史重建、扫描、投影修复和 backfill。历史准备不是可与旧 writer 并行的后台任务。
SQLite 历史升级仍须由离线工具调用 `runMigrations(db, { historicalMaintenance: true })`，CLI 仅提供 PostgreSQL 维护。

## Level 与查询接口

`multiremi_schema_meta` 单行记录 `expand_level`、`contract_level`；
`multiremi_schema_steps` 记录步骤 ID、phase、level、首次发布版本和完成时间。
缺少元数据表示历史 level 0；空行、非法值或损坏元数据拒绝启动，不自动重置。
[声明文件](../../packages/server/src/store/schema-compatibility.json) 同时供运行时代码、打包与 updater 读取。
当前 `{minLevel: 1, maxLevel: 1}`、expand 1、contract 0。

- `expand_level >= minLevel`：代码需要的加法结构已存在；旧库可以先执行本版 expand。
- `contract_level <= maxLevel`：库没有移除代码仍依赖的结构。
- 更高 expand level 允许旧代码运行；不能用 expand 的上界拒绝混版。

`querySchemaCompatibility(db)` / `store.querySchemaCompatibility()`、`remi db schema` 返回
`{expandLevel, contractLevel, compatibility: {minLevel, maxLevel}}`。
经过既有回环地址和 control token 鉴权的 `/internal/slot/status` 在 `schema` 字段提供同一查询。
MUL-170/A4 消费该接口；本单不改变 supervisor 切换条件、编排或在线 slot inventory。

每个新步骤声明 `id`、`phase`、`level`、`expandRelease`、`release`。
expand 的 SQL、完成标记和 level 更新位于同一事务；失败可重试。
重复 ID、倒序 level、改写已应用元数据都会失败。受保护句柄禁止动态破坏性 DDL。
不得捕获原始句柄绕过 guard；新 schema 变化必须提升 level，不能塞入已冻结的历史链。

## 后台回填

Usage scalar 回填由 [startUsageAccountingBackfill](../../packages/server/src/store/usage-migration.ts)
在 active slot 的后台工作启动，监听/standby 准备不等待历史扫描。
每批提交任务级证据与持久化 keyset cursor，批次间让出事件循环。
release / shutdown 取消并等待当前批提交，重启/重新 activate 从检查点续跑。
异常保留检查点并记录错误；解决源数据证据问题后重启可续跑。
回填完成前 `/api/usage/report` 返回 503 `usage_backfill_pending`，避免返回部分历史总数。
原有同步 `ensureUsageAccountingStartup` 仅保留给显式维护和测试，生产启动不再调用。

## 显式 contract

```bash
MULTIREMI_DATABASE_URL=postgres://… remi db schema
MULTIREMI_DATABASE_URL=postgres://… remi db contract --level 1
```

命令使用本机数据库凭据，必须显式配置 PostgreSQL URL。本版没有实际 contract 步骤，
向 level 1 收缩会失败，不能只提升元数据。
contract 的 release 必须晚于其 expandRelease，也必须晚于库中该 level 的 expand 发布版本。
所有前提在破坏性回调前检查。[独立 contract 注册表](../../packages/server/src/store/schema-contract-migrations.ts)
只由维护入口导入，不得进入启动图。
当前保守要求所有其他 PostgreSQL client backend 断开（含 standby、只读池和 worker）。
维护与启动共用锁，等待中的启动取得锁后重查 floor。SQLite contract 不支持。
在线兼容 slot inventory 与 updater orchestration 由 A4 后续接入；没有放行开关。

## 指纹、混版检查与 workflow 交付

现代 `dataSchema` 对 `{format, expandLevel, contractLevel}` 的规范 JSON 计算哈希，
源码排版/重构和 reader 区间改变不会改变 schema 指纹；旧发布归档仍用原算法验真。
声明损坏失败，不能用源码哈希代替现代 level。打包继续核对镜像和解包归档。

[prepare-schema-rollback.ts](../../scripts/prepare-schema-rollback.ts) 从 GitHub 已发布的稳定平台
Release 解析上一版，建立独立 worktree；[check-schema-rollback.ts](../../scripts/check-schema-rollback.ts)
绑定 tag、commit、package version、已发布 manifest，在隔离 PostgreSQL 库上执行旧版真实 Store 的
启动与 create/claim/start/complete/cancel，再执行本版迁移，再次运行旧版同组核心读写。
旧版模块按旧 worktree 的 tsconfig 解析，不导入本版 Store。
成功才生成绑定目标 SHA / schema 的 `rollback-evidence.json` 与 `rollbackSafeFrom`；失败先删除旧证据。
有 contract 的 schema 不生成自动回退声明。核心探针不能替代所有产品行为的兼容验证。

```bash
bun scripts/prepare-schema-rollback.ts ci-schema
(cd ci-schema/previous && bun install --frozen-lockfile --ignore-scripts --registry https://registry.npmjs.org)
MULTIREMI_TEST_POSTGRES_URL=postgres://… bun scripts/check-schema-rollback.ts ci-schema/previous ci-schema/previous-release.json ci-schema/rollback-evidence.json
PLATFORM_SCHEMA_ROLLBACK_EVIDENCE=ci-schema/rollback-evidence.json node scripts/package-platform-application.mjs platform-release.json
```

发布负责人只能使用同一目标 SHA 成功可信 main CI 的证据。打包核对 SHA、schema、前版身份、探针完整性
和版本先后；没有证据时沿用人工审核或空声明。当前 platform-release workflow 不自动下载此 artifact，
须显式提供 `PLATFORM_SCHEMA_ROLLBACK_EVIDENCE`；发布侧自动取证接线仍需 owner 配合。

[完整 workflow 补丁](../deploy/MUL-173-workflow.patch) 修改现有 release-build-check，加入 PostgreSQL
守卫、历史回归和上一发布版混跑 job，并加入总 build 的 needs。本 PR 不提交 workflow 本体：
owner 在本 PR 合入后另开 PR 应用补丁，经 CI 通过再合入；因此该 job 在补丁合入前尚未常态运行。
补丁可用 `git apply --check docs/deploy/MUL-173-workflow.patch` 检查。

[arch test](../../tests/arch/startup-schema-ddl.test.ts) 跟踪启动运行时 import，禁止新 DROP、RENAME、
改类型、SET NOT NULL 和 TRUNCATE。历史 bootstrap 的 [冻结 allowlist](../../tests/arch/startup-schema-ddl-allowlist.json)
精确绑定表达式及次数，只减不增；CI 设置 `SCHEMA_DDL_BASE_REF` 校验基线。历史一次性 DDL 仍是显式例外。
A4 切换接入和 A5 live 验收不由本单实现；本地 PG 混跑不等于已验证 slot 零失败或生产部署。
