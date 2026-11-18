---
title: Schema level 与迁移纪律
status: active
summary: 启动兼容守卫、版本化 expand 执行器、显式 contract 维护入口及历史 DDL 门禁。
---

# Schema level 与迁移纪律

启动入口是 [runMigrations](../../packages/server/src/store/migrations.ts)。它在既有 PostgreSQL
advisory lock / SQLite migration file lock 内，先检查 schema contract floor，再执行历史链，
最后运行 [版本化 expand 注册表](../../packages/server/src/store/schema-migrations.ts)。历史链完成后才登记 level 1。
元数据不存在表示历史 level 0；元数据存在但为空、非法或损坏时拒绝启动，不自动重置。

## 两个 level 与代码兼容区间

`multiremi_schema_meta` 单行记录 `expand_level`、`contract_level`；
`multiremi_schema_steps` 记录步骤 ID、phase、level、首次发布版本和完成时间。
[代码区间](../../packages/server/src/store/schema-levels.ts) 当前为 `{minLevel: 1, maxLevel: 1}`。

- `expand_level >= minLevel`：代码需要的加法结构已存在。过旧库可以先 expand，然后启动。
- `contract_level <= maxLevel`：数据库尚未移除代码依赖的旧结构。越界时拒绝启动，提示升级代码或恢复收缩前备份。
- 更高的 expand level 本身不拒绝旧代码；加法迁移保留旧 reader/writer 的契约。不能用 `expand_level <= maxLevel` 阻止可兼容的混版。

每个新迁移声明 `id`、`phase`、`level`、`expandRelease`、`release`。
expand 在启动时运行；每个步骤的 SQL、完成标记和 level 更新处于同一事务，失败的步骤可在下一次启动重试。
重复 ID、倒序 level、已应用步骤的元数据改写会失败。新 expand 的 SQL 接口还会拒绝动态构造的破坏性 DDL。
不要在迁移中捕获原始数据库句柄绕过传入的受保护句柄。

## 显式 contract

```bash
MULTIREMI_DATABASE_URL=postgres://… remi db schema
MULTIREMI_DATABASE_URL=postgres://… remi db contract --level 1
```

命令直接使用本机数据库凭据，必须显式配置 PostgreSQL URL，不使用平台 Task token。
本版本没有声明实际 contract 步骤，因此向 level 1 收缩会明确失败，不能仅手工提升 level。
contract 的 `release` 必须晚于 `expandRelease`，执行版本也必须晚于库中记录的同 level expand 发布版本。
所有前提在破坏性回调之前检查，contract 不在启动调用路径执行。其 [独立注册表](../../packages/server/src/store/schema-contract-migrations.ts)
仅由显式维护入口导入，不得从启动链导入。

当前维护入口保守要求**所有其他数据库客户端断开**，包括 active / standby slot、只读池和后台 worker；
存在任何其他 PostgreSQL client backend 都拒绝执行。它与启动迁移使用同一把锁；等待中的新启动在获得锁后会重查兼容区间。
目前不支持 SQLite contract，也没有在线兼容 slot inventory 的放行实现。

## 历史例外与 CI

[arch test](../../tests/arch/startup-schema-ddl.test.ts) 从启动入口跟踪运行时静态/动态字面量 import，
检查 DDL 字符串、模板表达式和历史 DROP COLUMN helper 调用。DROP、RENAME、改类型、SET NOT NULL、TRUNCATE
均受约束；ADD COLUMN 中的 NOT NULL DEFAULT 不属于对已有列施加约束。
[历史 allowlist](../../tests/arch/startup-schema-ddl-allowlist.json) 精确绑定文件、表达式和出现次数，
只允许删除，不得通过重新生成 allowlist 接纳新 DDL。
设置 `SCHEMA_DDL_BASE_REF=<base SHA>` 时测试还会比较基线 allowlist，禁止增加。
[独立 CI 配置样例](../deploy/schema-migration-discipline.yml.example) 尚未启用：当前 GitHub PAT
缺少 workflow scope，无法提交新 workflow；现有 CI 的 arch 入口会发现架构测试。已有历史 DROP VIEW / DROP INDEX 也纳入冻结清单。

```bash
bun run test tests/unit/multiremi/schema-levels.test.ts tests/arch/startup-schema-ddl.test.ts
bun run test tests/unit/multiremi/store-migrations.test.ts tests/unit/multiremi/unified-model-migration.test.ts
```

这层协议尚不等于 MUL-173 整单验收：历史 bootstrap/重建和耗时 backfill 仍在旧启动链中；
旧发布版尚未具备本守卫；指纹仍由现有发布机制生成，rollbackSafeFrom 仍需人工评审。
上一发布版代码连接新 schema 的混版 CI、自动回滚声明、在线 contract inventory 和 A4 slot 切换条件接入尚需完成。
在完成这些步骤与 A5 真实升级/回滚演练前，不得宣称带迁移版本已可零停机升级。
