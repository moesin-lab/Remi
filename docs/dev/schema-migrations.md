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
不会重跑历史重建、扫描、投影修复和 backfill。历史准备不是可与旧 writer 并行的后台任务。首次 B1 升级的停机顺序、真实 stable 规模估算和不恢复数据库备份的失败处置见 [升级手册](../deploy/b1-schema-upgrade.md)。
测试若合成历史 schema（删除列、表或历史步骤记录），也必须先显式执行离线 prepare，再断言启动幂等；不能以重新构造 Store 代替历史维护。

SQLite 历史升级仍须由离线工具调用 `runMigrations(db, { historicalMaintenance: true })`，CLI 仅提供 PostgreSQL 维护。

## Level 与查询接口

`multiremi_schema_meta` 单行记录 `expand_level`、`contract_level`；
`multiremi_schema_steps` 记录步骤 ID、phase、level、首次发布版本和完成时间。
缺少元数据表示历史 level 0；空行、非法值或损坏元数据拒绝启动，不自动重置。
[声明文件](../../packages/server/src/store/schema-compatibility.json) 同时供运行时代码、打包与 updater 读取。
当前 `{minLevel: 5, maxLevel: 5}`、expand 5、contract 0。level 5 新增 SCM 回滚审计停写标记；升级时已完成 level 4 分类的库需显式复核。
level 4 增加 SCM 关联归属证据与维护游标表，启动只建结构。切换流程见 [SCM 离线维护](./scm-checks.md#scm-归属切换)。
level 1 是 schema 协议登记；level 2 为 A3 的 `multiremi_live_terms` 加法建表，
同样在版本化 expand 事务内执行，已登记 level 1 的库启动也会补齐该表。
level 3 为 planned restart 的表、索引及 daemon drain_id：先补 drain identity，再建 planned restart 表；
历史两条入口仍保留 ensureDaemonDrains → ensurePlannedRestarts 顺序，已登记 level 2 库只走版本化 expand。
旧代码允许更高 expand，contract floor 仍为 0；历史 DDL allowlist 与 legacy 指纹输入列表不增加。

- `expand_level >= minLevel`：代码需要的加法结构已存在；旧库可以先执行本版 expand。
- `contract_level <= maxLevel`：库没有移除代码仍依赖的结构。
- 更高 expand level 允许旧代码运行；不能用 expand 的上界拒绝混版。

`querySchemaCompatibility(db)` / `store.querySchemaCompatibility()`、`remi db schema` 返回
`{expandLevel, contractLevel, compatibility: {minLevel, maxLevel}}`。
经过既有回环地址和 control token 鉴权的 `/internal/slot/status` 在 `schema` 字段提供同一查询。
MUL-170/A4 消费该接口；本单不改变 supervisor 切换条件、编排或在线 slot inventory。

每个新步骤声明 `id`、`phase`、`level`、`expandRelease`、`release`。
expand 的 SQL、完成标记和 level 更新位于同一事务；失败可重试。
重复 ID、倒序 level、改写已应用元数据都会失败。**运行时以 catalog diff 为准，文本检测仅为 lint**：
每个待执行 expand 在同一事务内读取前后快照，采用默认拒绝模型：已有对象的 identity → definition
必须保留；删除、改名、定义变化均回滚，步骤和 level 不推进。已经应用的步骤在快照前返回，稳态启动不查 catalog。
PostgreSQL 每次快照固定 11 条集合查询，不按 namespace 循环；范围排除 `pg_catalog`、`information_schema`、
`pg_toast*`、临时系统 namespace。建模覆盖 schema；全部 pg_class relkind（含复合类型、分区表、外部表、
视图/物化视图、索引和序列）的持久性、RLS、分区边界/键、继承顺序、视图/索引定义、视图与物化视图的排序后 reloptions、序列参数；
全部列（含复合类型属性）的顺序、类型、identity/generated 与生成表达式；type/domain/enum；
表/domain 约束定义（忽略 convalidated）；非 internal trigger 定义和启用状态；policy；rule 定义和启用状态；
function/procedure 定义；extension 版本。schema、relation、column、type、routine 的 ACL 按单项权限比较，允许增授。
另以一条 `pg_depend` + `pg_identify_object` 查询登记依赖用户 namespace/relation 的对象身份；
未建模类型的对象消失也会被拒绝。默认值的 pg_attrdef 身份除外，generated 表达式由列定义比较。

放宽白名单仅有：新增对象；列默认值的设置、修改、删除；DROP NOT NULL；enum ADD VALUE
（既有标签和相对顺序保留）；ACL 新增项（包括 grant option）；COMMENT。
但在步骤执行前已存在的表上新增 CHECK/UNIQUE/PRIMARY KEY/FK/EXCLUDE 约束、UNIQUE 索引或 policy，
以及开启/强制 RLS 都属于收紧，会拒绝旧 writer，故禁止。步骤中新建的表不受新增限制。
新增 trigger 允许，以支持 expand 双写，但其行为必须人工审查。
SQLite 同样执行 expand：index/view/trigger 的 SQL 精确比较；table 比较列的 type/notnull/pk/hidden/顺序、
命名约束定义，以及索引结构；已有表上新增 UNIQUE 索引同样禁止。

已知边界：未建模 catalog 类的同名定义变化不保证被发现；不验证数据内容变化；
新 trigger 的数据副作用需人工审查；catalog 不比较 internal trigger 的启用状态，
禁用内部 FK trigger 需要超级用户权限，此类操作不保证被间接 DDL 守卫发现。SQLite CHECK 表达式不做语义分析，命名 CHECK 的 token 变化会拒绝，
未命名 CHECK 不保证覆盖。默认值变更按决定允许，仍须评估依赖默认值的旧 writer。
受保护句柄与 arch 共用文本 lint 提供 fail-fast；函数调用等间接 DDL 由 catalog 权威守卫判断。

不得捕获原始句柄绕过 guard；新 schema 变化必须提升 level，不能塞入已冻结的历史链。

## 后台回填

Usage scalar 回填由 [startUsageAccountingBackfill](../../packages/server/src/store/usage-migration.ts)
仅在启用 backgroundJobs 且持有有效 A3 live term 的 active slot 启动，所有 SQL 经 liveTermDatabase 的事务 fence。
backgroundJobs:false 候选、standby 及没有 singleton term 的拆分角色均不启动回填；监听/standby 准备不等待历史扫描。
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
updater 的 bootstrap 通过构建时 macro 嵌入 fingerprint 源码，避免 Bun 为同一模块的
源码嵌入与可执行导入复用 text loader；资源内容和 control hash 顺序保持一致。
application-driver 回归同时检查隔离 bootstrap 加载及真实 updater 入口的打包。
updater 的隔离演练也保留未登记旧库的启动拒绝，并提示先按人工边界升级流程执行 `remi db prepare`；
不会在演练或切换时自动执行历史维护。边界恢复测试的人工迁移步骤显式使用离线维护入口。

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

## SQL 允许清单与检测边界

[arch test](../../tests/arch/startup-schema-ddl.test.ts) 扫描所有非测试 `packages/server/src/**`（含自动后台回填和新文件），
按 tsconfig 解析并递归扫描运行时 import、export-from、动态 import 的仓库依赖（跳过 type-only）；
解析失败报错。仅按固定路径排除显式 contract 模块；从 `packages/server/src/api/server.ts`（standby 初始化、
active 后台任务入口）的传递运行时依赖图断言这两个模块不可达。
文本 lint 先识别 SQL 语法候选，再默认拒绝，仅放行 CREATE（包括 OR REPLACE）、仅含 ADD/
SET DEFAULT/DROP DEFAULT/DROP NOT NULL 的 ALTER TABLE、ALTER TYPE ADD VALUE、COMMENT ON、GRANT、
IMPORT FOREIGN SCHEMA。CREATE OR REPLACE 的既有定义保护由运行时 catalog 承担。
候选对象类封闭常量及 PostgreSQL 16 SQL Commands / SQLite VIRTUAL TABLE 来源见
[schema-ddl.ts](../../packages/server/src/store/schema-ddl.ts)。B1 登记迁移使用词法**允许清单**，
运行时与 arch 共用 tokenizer；这里只维护我们自己编写的迁移 SQL，不实现完整 PG lexer。
仅允许空格、Tab、LF；`--` 到 LF 的注释；不嵌套的 `/* */`；无前缀单引号串（内部以 `''` 转义）；
普通双引号标识符（内部以 `""` 转义）；无引号标识符（不含 `$`）、数字、位置参数 `$<数字>`、运算符和标点。
arch 将源码模板插值作为不透明占位符，不能据此保证插值生成的 SQL；运行时检查实际 SQL。

以下形式在任何已知迁移 SQL 中拒绝：`U&"…"` / `U&'…'`（包括所有 UESCAPE 变体）；
E/B/X/N 前缀字符串；dollar quote；字符串换行续接（包括夹行/块注释）；嵌套块注释；
反引号、方括号（包括 ARRAY 方括号）；圆括号内的分号，以及无法识别的字符/未闭合引用。
`\r`、`\f`、`\v` 在任何位置均禁止，包括字符串和注释内部。请只用 LF，
改用普通双引号标识符和单个普通字符串。ACL catalog helper 使用 `LATERAL (VALUES …)`，
保持既有权限原子及排序，避免 ARRAY 方括号；catalog 查询仍在扫描集合内。
冻结 legacy 列表中的历史模块保留原 lint 行为，不扩大历史 allowlist。

PostgreSQL 在执行 expand 前以及每次执行 SQL 前同步读取 `SHOW standard_conforming_strings`，必须为 `on`（PG 默认）。
`exec` 每段、`run` 和 `query`/`prepare` 返回 statement 的 run/get/all/values 均复查，
不能只在创建 statement 时检查；statement 创建后通过 SET、SET LOCAL 或 set_config 修改设置也会被拒绝。
expand 只获得冻结、原型为 null 的封闭 facade：dialect（只读值）、inTransaction（getter）、exec、run、query、prepare、transaction。
statement 同样冻结且原型为 null，只提供 get/all/run/values；不提供 iterate、execute、valueOf、constructor 或其它原始句柄成员。
transaction 返回独立函数，不转发原函数或 deferred，回调的 this 为 undefined，参数只来自调用方。
close、advisoryLock、afterCommit、savepoint 等不在清单内，调用会抛错；新增迁移如需这些能力必须先报告，不能自行透传。
不能依赖关闭该设置后的反斜杠语义。所有 unsupported 形式共用一个拒绝路径，
错误说明具体形式；执行前整体拒绝，不记账、不推进 level。`exec` 由同一 tokenizer 按顶层分号切分，
整批检查后逐段通过 `query(...).run()` 执行，不经过 bridge 的 `splitStatements`。
这不是数据库协议层的多命令保证；worker 协议和通用 SQL adapter 不变，
允许清单之外的现存 SQL 必须先报告并重写，不能为其加例外。
arch 仅对 B1 扫描集合内的 SQL 候选检查允许清单，不将散文和 shell 当成已知 SQL。
运行时面对已知 SQL，任何顶层语句以 TRUNCATE 开头都直接拒绝，不依赖尾部形态或 catalog diff；
arch 仅作 fail-fast：TRUNCATE 后接 TABLE、ONLY 或引用名称时
不论尾部是否可识别都拒绝；只有裸单词名称仍需形态检查以区分散文。
DO 执行体、DROP（含 ON table）、其它 ALTER、TRUNCATE、REVOKE 等候选一律拒绝。
散文、事件名、shell 字符串不构成 DDL 候选；VACUUM/ANALYZE/REINDEX/CLUSTER/REFRESH/DISCARD 不由 lint 检查。
历史 bootstrap 的 [冻结 allowlist](../../tests/arch/startup-schema-ddl-allowlist.json)
精确绑定表达式及次数，只减不增；CI 设置 `SCHEMA_DDL_BASE_REF` 校验基线。历史一次性 DDL 仍是显式例外。
A4 切换接入和 A5 live 验收不由本单实现；本地 PG 混跑不等于已验证 slot 零失败或生产部署。

legacy 归档指纹的 [data-schema-inputs.json](../../packages/platform-updater/src/data-schema-inputs.json)
冻结为 B1 合入前 main `80f749990` 的逐项内容，不添加新版独有路径，否则 updater 从旧 `/app` 读取时会失败。
新增 DDL 模块走 level 纪律；[覆盖门禁](../../tests/arch/data-schema-inputs.test.ts)
要求 migrations.ts 可达的每个运行时源码模块要么在冻结列表中，要么在 B1 arch scanner 的实际扫描集合中；
导入的 JSON 同样纳入实际扫描集合。scanner 与覆盖门禁共用 [可达图遍历](../../scripts/schema-module-graph.mjs)，不按 DDL 源码正则过滤模块；实际扫描集合包含 schema-levels.ts，非 DDL 模块扫描结果可为零。此规则不改变 level 指纹或 legacy 哈希算法。
