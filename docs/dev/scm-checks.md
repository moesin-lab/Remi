---
title: SCM 显式绑定与实时检查查询
status: active
summary: 通过外部 PR/MR 引用持久化绑定 Issue，并使用任务凭据读取 GitHub CI 观测。
---

# SCM 显式绑定与实时检查查询

## 按外部引用绑定 PR/MR

`<issue-id>` 使用任务上下文中的内部 `iss_...` ID。外部工具创建 PR/MR 后，可立即绑定到 Issue，无需等待首次轮询或在标题、正文、分支中写入 Issue Key：

```bash
remi scm change-request bind <issue-id> --url https://github.com/owner/repo/pull/42 --json
remi scm change-request bind <issue-id> --repository owner/repo --number 42 --json
remi scm change-request list <issue-id> --json
```

命令调用 `PUT /api/issues/:issueId/change-requests/by-reference`，请求为
`{"url":"https://github.com/owner/repo/pull/42"}` 或 `{"repository":"owner/repo","number":42}`，
两种形式互斥，不接受额外字段。repository 支持平台仓库 ID、`owner/name` 或 Git URL。
旧内部 ID 的 `link <issue> <change-request>`、`unlink`、`list` 与原 API 保留。

解析仅限 Issue 所属工作区已配置且启用的 SCM 仓库及连接。PR URL 使用 GitHub 的
`https://<host>/<owner>/<repo>/pull/<number>`；Codebase MR URL 使用已验证格式
`https://<host>/<owner>/<repo>/merge_requests/<number>`。主机、非默认端口、仓库路径及 provider
必须匹配配置；拒绝 userinfo、查询、片段、路径规范化、编码分隔符和非正整数编号。
服务端从配置坐标构造请求，不抓取用户提供的任意 URL，不向任务返回 provider token，不回退到全局 token。

已有真实投影直接绑定；尚未采集时，GitHub 复用只读 PR 查询，Codebase 复用
`ListRepoMergeRequests`，不使用 watermark，最多读取 20 页（每页 100），整个查询限时 30 秒。
Codebase 请求虽为 POST，其 Action 仅用于读取；不创建或修改远端 MR。
达到页数上限返回 `scm_pagination_limit`，与完整读取后的 `scm_change_request_not_found` 区分。
无配置为 `scm_binding_not_found`；歧义为 `scm_reference_ambiguous`；连接无权访问为
`scm_provider_forbidden`；限流为 `scm_rate_limited`；超时为 `scm_lookup_timeout`。
远端 404 也可能表示连接无权查看，不向调用方断言对象一定不存在。

网络读取发生在数据库事务外；提交时重验工作区、连接、仓库、凭据配置修订和启用状态，
期间发生变化返回 409 `scm_binding_conflict`。同一事务写入真实投影和 `source=manual` 的 active link，
200 返回 `{changeRequest, link}` 才表示绑定已提交。重复引用保留既有关联 ID 与时间戳，不重复广播；
较旧读取不会覆盖较新的同步快照，`legacy-number:*` 投影继续原位复用。
首次导入采用实体 baseline，不补放绑定前的 opened/merged 等历史事件；即使连接尚未完成首次轮询，
已有实体的后续真实状态变化仍沿用 canonical event 链路。若读取期间其他采集已建立实体，
提交时基于锁内前序快照推导变化，避免并发导入吞掉合并事件。
显式绑定只新增所请求 Issue 的 manual 关联；即使旧自动发现开关为 true 或缺省，
该入口也不会因为标题、分支或正文提及其他 Issue 而新增关联。
已存在投影不需要解密凭据；连接验证的状态、计数与时间更新不会使未变更配置的绑定请求冲突。

外部 PR/MR 创建成功而绑定失败时，保留原 URL，以同一引用重试并报告绑定尚未完成，不能重建第二个 PR。
本阶段尚未切换 poll/webhook 的全局文字自动发现、历史归属、默认交付规则或设置开关；这些切换需要配套实现后发布。
服务端绑定能力应先于依赖该命令的 daemon/CLI 默认指引上线。

验证入口：[绑定测试](../../tests/unit/multiremi/scm-change-request-binding.test.ts)覆盖真实 Store/API 与模拟 provider；
PostgreSQL 用例需要 `MULTIREMI_TEST_POSTGRES_URL`。Codebase 使用本地 fixture；真实服务验证另行执行。

## GitHub 实时检查查询

`remi scm change-request checks <repository> <number> --json` 调用
`GET /api/workspaces/:workspaceId/scm/repositories/:repositoryId/change-requests/:number/checks`。
repository 接受平台仓库 ID、`owner/name` 或 Git URL（HTTPS、SSH URL、`git@host:owner/name.git`），number 是 GitHub PR 编号。
解析仅限当前工作区已启用的 SCM 仓库绑定；URL 按主机和仓库路径匹配，名称有歧义时需改用 ID 或 URL。
HTTP(S) URL 必须使用完整的 `http://` 或 `https://` authority，且不接受 userinfo（包括空 userinfo、只有用户名的 token）；SSH 的 `git@` 用户可用。
仓库引用拒绝首尾空白、控制字符和反斜杠，不接受 URL 解析器对这些输入的隐式规范化。
显式默认端口（SSH 22、HTTPS 443、HTTP 80）按省略端口处理；不同主机和非默认端口保持隔离。
无法匹配或存在歧义时，错误会列出当前工作区可用的绑定 ID 和名称。
默认 table 首行显示完整 head SHA、汇总结论和观察时间，随后每项检查一行显示名称、status、conclusion 和完整链接（无链接时显示 ID）。
`--json` 保留完整响应，`--output jsonl` 每项检查一行；没有检查时 table 明确显示 No checks observed。成员和同工作区 Task 凭据可读，daemon 不可调用业务端点。
仓库必须有已启用的 SCM 绑定和连接；服务端使用连接凭据访问 GitHub，不把 provider token 返回给任务。
连接需要读取 Pull requests、Checks、Commit statuses 和 Actions 的权限；权限不足返回 provider 错误，不退回匿名 API。

响应 `summary` 包含完整 `headSha`、`observedAt`、`checks[]` 和 `conclusion`。
每个检查保留 kind、name、status、conclusion、url，以及可证明的 app ID/slug 和 workflow path。
check runs 按 latest 读取，commit statuses 每个 context 保留最新值；独立按 head SHA 读取 workflow runs，
kind 为 workflow_run，保留 status、conclusion 和 runAttempt。同一 run ID 只保留最新 attempt，
不同 run 与 job checks 分别保留；通过 check suite 关联 job 的 workflow path。所有分页读全才返回。
查询前后重读 PR；head/base SHA、目标分支或 base 仓库变化时返回 409 `scm_head_changed`，调用方重新查询。
缺页、SHA 不符、provider 限流/权限错误或超时不会返回成功摘要；provider 响应正文不透传。

403 带 x-ratelimit-remaining=0 或 retry-after，以及 429，返回 502 / scm_rate_limited，
附 retryAfterSeconds 和 rateLimitResetAt（Unix 秒；不可用为 null）；普通权限 403 保持 scm_provider_error。
仅返回这些解析后的数值，不返回原始响应头或正文。

没有检查时 conclusion 为 missing；存在失败时为 failure；运行中或未知结论为 pending；全部检查 completed 且结论均为 success、skipped 或 neutral 时为 success（全部 skipped/neutral 也为 success），逐项保留原始结论；queued/in_progress 的 workflow 即使尚无 job checks，也参与汇总并阻止 success/missing。
这是已观察检查的汇总，不表示 required checks 已满足，也不授权合并。
此查询只向 provider 发 GET，不写 SCM 快照或触发 Issue 事件；不包含 PR 创建、更新、合并、webhook 或策略迁移。

验证入口：`bun run test tests/unit/multiremi/scm-checks.test.ts tests/unit/multiremi/multiremi-api-scm-checks.test.ts tests/unit/remi/cli-operations.test.ts`。
测试使用真实 Task 鉴权/HTTP/SQLite，远端 GitHub 为 mock；真实已部署服务的任务凭据查询需另行验收。

## SCM 归属切换

完成 expand 6 后，停止所有 API slot、后台 writer 和旧交付轮次，排空连接和在途事务，禁用自动重启并隔离旧进程的数据库访问，包括投影及 Issue key 写入。操作员须在整个窗口维持隔离。PG 的 advisory lock 串行维护命令，客户端检查只反映检查时刻。SQLite 入口持有启动迁移锁及目标库排他锁，覆盖所有分页事务；操作员仍须关闭空闲句柄并阻止重连。

- PostgreSQL 使用目标库的 `MULTIREMI_DATABASE_URL`，执行 `remi db classify-scm-links`。
- SQLite 取消设置 `MULTIREMI_DATABASE_URL`，执行 `remi db classify-scm-links --sqlite-file /absolute/path/to/server.sqlite`，指定 Server 实际使用的既有文件。
- 冷启动空库也须执行分类。每批以 link ID 排序，证据（包括已核对的弱证据 `[]`）与游标同事务提交。中断或锁冲突时维持隔离，断开其他客户端，重试同一命令。成功后恢复兼容 writer；候选启动、standby、`db prepare` 均不做历史分类。

### 回滚与重新接管

1. 从已完成可信首切的新库回滚前，在同一离线命令追加 `--hold-for-rollback`。确认回执给出 `hold_id`、`baseline`、条数和 `writersHeld`，再允许旧 writer 启动。数据库保存独立于业务行的基线，包括未绑定投影、所有关联和墓碑。身份和归属参与比较，分支、标题、正文分别取摘要。普通检查状态刷新不改变归属。
2. 旧 writer 退出后，重新排空并隔离所有客户端。每次离线命令都重新取得锁。运行普通分类命令获取 `receipt`、`reviewed`、`pending`、`entries` 和 `next`；每页最多 25 条，用 `--after <next>` 查看下一页。退出 0 的 `writersHeld:true` 表示报告可读，仍须保持隔离。新增、删除、身份或归属差异无法核证时保持停写，已观测到的身份异常即使后来消失也阻止本代解锁。
3. 对 `text` 差异核对前后摘要。将同一页的完整 `receipt` 字段复制到 JSON 顶层，追加本页 `after` 和 `items`。每项只含 `entry_key`、`old_digest`、`new_digest`、`disposition`（`retain-frozen`）。执行 `--review-page <文件>` 顺序登记整页；错误或漏项整页回滚。同页同内容可重复。一条新观测导致快照变化即更新 revision，旧审核回执失效；按新增差异重新核对。CLI 不接受调用者声明的 `proof` 或归属数组。
4. 将报告的 `receipt` 对象单独保存，执行 `--finalize <receipt文件>`。零差异也需要此步。CLI 在离线锁内复核整库与冻结基线，所有页已审且无未核实身份才原子放行。重复完成仅返回原代回执。确认 `complete:true` 后恢复兼容 writer。维护不重建关联，不修改墓碑、Issue 状态或历史活动。

### 旧库的来源核验

- 从 main level 0–6 首次升级且无历史 cutover 记录的库，经显式分类完成。已有 SCM level 4/5 或 7/8 谱系或 checkpoint 的库，即使当前库空、已有 complete 或强证据，也保持隔离。原 SCM level 4 或正式 7 已处理的弱关系用缺行表示；SCM level 5 或正式 8 无回滚前快照。事后快照不能证明过去的绑定。
- 具备**独立受控、确认属于目标库的历史快照**时，针对隔离副本使用 `--export-inventory`，保存原始输出字节。需由独立的备份/审计管理方核验来源、版本、快照时间及旧 writer 隔离记录，并从受控副本计算文件 SHA-256。确认这份记录先于旧 writer 重入。SCM level 5 或正式 8 还须确认所有历史强度已有可信依据。若无这样的记录，继续保持停写。
- 支持主机独立预置的 `/etc/remi/scm-cutover-anchors.json`。`/etc`、`/etc/remi` 和文件必须由 root 持有、禁止组及其他用户写入，路径不得含符号链接。审核操作员不应拥有修改该文件的权限。`targets` 按 `sqlite:<规范绝对路径>` 或 `postgres://<主机>:<端口>/<库名>` 分别列出目标的 `sha256`。有独立连续隔离证明的旧部分分类才可登记 `continuousIsolation:true`。凭据、查询参数和调用者提供的哈希不用于选择信任来源。主机不能提供此来源时保持隔离。
- PostgreSQL 历史采纳要求 `MULTIREMI_DATABASE_URL` 指定真实监听 IP、显式端口和区分大小写的库名，例如 `postgres://127.0.0.1:5432/Remi` 或 `postgres://[::1]:5432/Remi`。管理员须独立确认直连拓扑和对应 IP 键，DNS 名（含 localhost）、代理、池化器和端口转发均不适用。无法确认时保持隔离。清除 `PGDATABASE`、`PG_DATABASE`、`PGPORT`、`PG_PORT`、`PGHOST`、`PG_HOST`、`PGHOSTADDR`、`PG_HOSTADDR`、`PGSERVICE`、`PGSERVICEFILE` 和 `PGOPTIONS`。凭据仅用于认证，保留 TLS 验证。CLI 先以指定目标查受管 pin，worker 核对实际驱动参数；同一写事务获取迁移锁、排查其他连接并验证后端库名、IP 和端口。身份不符即中止，不能据此改选 pin。
- 未设置 `PGSSLMODE` 时沿用驱动默认行为。显式设置 `disable` 会关闭 TLS，`prefer` 会优先尝试 TLS。端点要求 TLS 时可设置 `require`、`verify-ca` 或 `verify-full`。使用 `verify-full` 时证书须覆盖指定 IP。如果无法验证，请保持隔离并核对证书。
- 目标离线 CLI 使用 `--adopt-inventory <历史文件>` 校验预置摘要并保存历史完整基线。之后使用同一查询、审核和 `--finalize` 流程。原 SCM level 4 或正式 7 已处理的缺行只能在最终提交时补弱 `[]`；未处理尾页仅在有连续隔离证明且快照一致时续跑。已证强度与 inactive 保留。SCM level 5 或正式 8 无来源的缺行不可恢复。从当前文件自身计算哈希并自行注册会破坏来源证明，维护过程不提供注册命令。

捕获中断后继续隔离，再执行 `--hold-for-rollback`。若完整预捕获摘要已落库且仍与现状一致，可以补齐缺页；缺少该摘要或内容已变则维持停写。存储量随基线与差异行数增长，维护锁窗包括全量枚举和重验。前后快照只能证明端点，证明期间行为需可信日志。旧版不识别新门禁，数据库锁及连接清点不能替代进程隔离。

poll、webhook、baseline 和 bind 都不会依据标题、分支或正文新增关联，旧 `scm_auto_link_enabled` 设置仅保留序列化兼容。显式 manual 关联具有归属；已存在的 auto/legacy 关联按切换时可证实的分支、标题、声明式正文保存归属。普通提及保持可见，解绑记录继续隐藏。后续文本更新不改变归属，合并只记录活动。切换前已丢失证据的关联可按原 URL 显式绑定，不补录历史活动。

### 显式绑定协议混版发布

先排空代码交付任务，保留运行中 attempt 身份，确认所有执行这些任务的 daemon 均已排空。升级 daemon、CLI 和 server，再用实际任务验证固定提示、bind 与 list 的同一引用后恢复调度。无法确认排空时保持暂停。`prompt.policy.adopt.v1` 仅确认可接收策略，旧 daemon 的固定段来自其自身二进制。新默认仅为首次投递的独立无代码上下文 Chat 提供经验证的 legacy 执行快照，见[协议 §7.4b](../daemon-protocol-v2.md#74b-n-1-与-contract-发布)。
