---
title: SCM 主动操作与合并闸门
status: active
summary: GitHub PR 操作、检查证据与 MUL-35 分阶段交付边界。
---

# SCM 主动操作与合并闸门

## 已实现：A 阶段

[HTTP 路由](../../packages/server/src/api/routers/scm.ts)在工作区已启用的仓库绑定上提供以下操作；任务凭据遵循现有工作区范围，daemon 凭据不允许访问这些业务端点。

| 方法与后缀 | CLI | 输入 |
|---|---|---|
| `POST /change-requests` | `remi scm change-request create <repository> --file <json>` | `head`、`base`、`title`，可选 `body`、`draft` |
| `GET /change-requests/:number` | `remi scm change-request get <repository> <number>` | provider PR 编号 |
| `PATCH /change-requests/:number` | `remi scm change-request update <repository> <number> --file <json>` | `title`、`body`、`base` 至少一项 |
| `GET /change-requests/:number/checks` | `remi scm change-request checks <repository> <number>` | provider PR 编号 |

完整前缀为 `/api/workspaces/:workspaceId/scm/repositories/:repositoryId`。repository 是平台仓库 ID；number 是 GitHub PR 编号，区别于 Issue 关联命令使用的内部 change-request ID。创建默认 Draft，仅支持绑定仓库内的分支。已有同源分支开放 PR 时复用，不覆盖原描述；目标分支不一致或出现多个开放 PR 时返回冲突。并发创建的 422 会重新查询；写入超时不会自动重试，调用方应先读取 provider 状态。

读写 PR 后立即更新现有快照、change-request 投影及事件链路；没有引入第二套 Issue 关联机制。返回的 `pullRequest` 使用已有 provider-neutral snake_case 字段。GitHub 以外 provider 返回 `scm_capability_unavailable`，不把未经验证的 Codebase 能力当作成功。

[GitHub 适配器](../../packages/server/src/scm/operations.ts)分页读取完整 head SHA 的 check runs 与 commit statuses，保留 app ID/slug、job 名和 workflow 路径。Actions workflow 路径从同 head SHA、同 check suite 的服务端 API 关联读取，不信任客户端传入的路径或 details URL。无法建立关联时路径为 null。commit statuses 每个 context 只保留最新状态。分页超限、provider 错误、SHA 不一致均失败，不返回截断的成功摘要。检查读取前后复查 PR head/base SHA、规范化的 `target_branch` 与 base 仓库 `full_name`（忽略大小写），任一变化时返回 409 `scm_head_changed`。该稳定性检查不作为授权依据；B 的执行服务仍须独立绑定并在执行前重验目标分支及仓库身份。

摘要的 `conclusion` 是已观察检查的汇总：空集合为 `missing`，失败为 `failure`，运行中、未知、skipped/neutral 为 `pending`，全部 success 才是 `success`。它**不代表 required checks 已满足，也不授权合并**；仓库规则和项目附加要求由下文 B1 预检统一判定。

GitHub `check_run` webhook 经现有签名验证后只写内部 `checks` 观测的 `check_run` 实体快照，以 `check_run:<id>` 标识，保留 app、job、check suite 身份、delivery ID 和原始签名所覆盖的 body。快照是按 revision 保留的最新证据，不是完整 delivery 历史。不同 delivery 会改变 contentHash，但相同 revision 会被 Store 拒绝；这不是忽略 delivery 的语义去重，B 不能把它当作检查状态变化通知。workflow 路径仍由实时检查接口在服务端关联。选择独立快照是为了保留证据而不扩展公开事件枚举：它不创建 canonical event，不可被 Autopilot 订阅，也不写 pipeline 快照；GitHub 适配器在来源处标记 `entityType=check_run`，reconcile 仅按此类型禁止派生事件，不按 payload.kind 或 ID 前缀猜测其他 provider 的分类。B 如需检查变化触发闸门重评，只在内部消费。

既有 `workflow_run` 的 `pipeline.*`、`workflow_run:<id>:<attempt>` 标识及去重行为不变。GitHub 后台 pipelines 轮询仍只采集 workflow runs；Codebase 既有 ListCheckRuns 轮询仍产出 pipeline 快照和 `pipeline.*` 事件；check runs 的当前证据通过上述实时检查接口读取。不能把 webhook 快照作为当前合并判据。

底层 `merge` 方法仅供后续服务端合并操作调用，固定传 GitHub merge API 的 `sha` 原子比较参数，不重试失败/超时写入。A 阶段没有公开合并 HTTP/CLI 入口；整个 Draft PR 需完成 B/C 并最终复审后才能上线。

## 分阶段策略边界

MUL-35 裁定要求项目策略默认关闭，required checks 使用仓库有效保护规则与项目附加项并集，项目不得删减仓库约束。独立审阅绑定 head/base SHA 与策略版本，Agent 必须在 `independent_reviewers` 白名单，且不能是该 CR 的平台创建/更新调用者；无平台归属的 CR 不计入 Agent 审阅。人工决定使用 member-only 的 `platform_merge_approval` Question origin，直接进入人工阶段，无 provider wait；批准绑定 operation/head/base/policy revision。

合并操作需持久化与幂等恢复，超时先标 unknown、查询实际状态后再决定。完成后沿现有 `scm_merge_completed` activity 规则，不自动将 Issue 标 done（ADR 0017）。

C1 已分离 token 类型的 task-writer/server-merger 凭据；任务及 daemon git-credentials 路径永不返回合并凭据。严格模式下未配置独立任务身份或无法由服务端合并身份实时证明仓库保护有效（含 bypass 列表）时拒绝发写凭据和执行合并。未启用严格凭据模式时必须显示“平台入口受控、直推未封闭”。仓库保护设置、身份创建、现有 PAT 轮换与隔离测试仓库需另获外部授权；本单不自行修改设置。

## Remi 项目 CI 的已知限制

Remi 项目采用 GitHub Actions app + `.github/workflows/release-build-check.yml` + job `build` 的身份，不复制 job 清单。目前该 workflow 的 PR 触发带 `paths:` 过滤，纯文档 PR 可能没有 build。missing 一律阻塞，后续 gate 必须输出明确的 missing 原因，不通过路径推断放行。本单不改 workflow；启用严格策略前需跟进“PR 无条件触发 + 内部变更检测”。

PR 的 build 运行采用 pr-fast，不运行 backend 全量测试；PR 绿灯不能作为发版授权。main 的完整发版证据继续由现有 `trustedReleaseRun` 判定，见[测试指南](../../TESTING.md)。

## 验证入口

`bun run test tests/unit/multiremi/scm-operations.test.ts tests/unit/multiremi/multiremi-api-scm-operations.test.ts tests/unit/multiremi/scm-providers.test.ts tests/unit/multiremi/scm-webhook.test.ts tests/unit/remi/cli-operations.test.ts` 覆盖模拟 provider 的操作、分页、证据身份、失败、HTTP 与 CLI 契约。这些测试不等于真实 GitHub 合并/保护验收；真实验证需另记录授权、仓库、SHA、检查与 provider 回执。

## B1：持久策略、审阅与预检

[策略契约](../../packages/contracts/src/merge-policy.ts)、[服务端预检](../../packages/server/src/api/routers/merge-policy.ts)和[共同迁移 SQL](../../packages/server/src/store/merge-policy-schema.ts)属于 B1；B1 只提供预检；执行和人工审批见 B2。项目策略未启用时，预检直接返回 `policy_disabled`，不访问 provider；既有 A 操作不受策略默认值影响。

| API | CLI |
|---|---|
| `GET /api/projects/:id/merge-policy` | `remi project merge-policy get <project>` |
| `PUT /api/projects/:id/merge-policy` | `remi project merge-policy update <project> --file <json>` |
| `POST /api/projects/:id/change-requests/:changeRequestId/reviews` | `remi scm change-request review submit <project> <change-request> --file <json>` |
| `GET /api/projects/:id/change-requests/:changeRequestId/reviews` | `remi scm change-request review list <project> <change-request>` |
| `GET /api/projects/:id/change-requests/:changeRequestId/merge-gate` | `remi scm change-request gate <project> <change-request>` |

这里 change-request 是平台内部 ID，必须关联该项目内的 Issue；不是 GitHub 编号。列表保留全部历史，不把旧结论标成当前授权。策略写入仅接受通过鉴权的成员（共享 operator），拒绝 Task/daemon。PUT 是整体替换，包含 `version: 1`、`expected_revision`、`enabled`、`target_branches`（精确分支名，不支持模式）、`required_checks`、`require_independent_review`、`independent_reviewers`、`require_human_approval`、`allowed_merge_methods`、`credential_enforcement_mode`（`platform_only|strict`）。未知字段和非法组合返回 400；revision 冲突返回 409 `scm_policy_conflict`。默认 revision=0 / enabled=false；启用必须有目标分支，要求独立审阅时必须明确配置工作区内有效 Agent 白名单。strict 现在使用下文 C1 的实时保护证明，缺少合并凭据或证明失败时阻塞。

检查身份示例：`{"kind":"check_run","app_id":15368,"workflow_path":".github/workflows/release-build-check.yml","job":"build"}`，或 `{"kind":"commit_status","context":"security"}`。每次预检读取目标分支的 branch protection 和有效 branch rules（包含继承 rulesets），与项目附加项取并集。仓库 API 只给 context/app 时，必须用项目显式绑定补 workflow 路径；缺失返回 `repository_check_identity_missing`，不能猜测同名 job 的 workflow。仓库 `app_id=null` 表示任意来源，必须在项目中显式绑定同名的 app/workflow/job 或 commit_status context；没有绑定返回 `repository_check_identity_missing`，多个绑定必须全部满足，不能按名称信任任意 app。项目不能移除仓库要求。并集去重后为空返回 `required_checks_empty`，即使已有有效审阅也阻塞；项目附加项本身允许为空。

规则读取权限不足、404（不能分辨权限不足和不存在 legacy protection）、分页不完整均阻塞。`repository_rules_unavailable` 表示读取失败；`repository_rules_incomplete` 表示缺字段；`repository_rules_unsupported` 表示未支持语义，例如严格 up-to-date、原生 PR 审批、merge queue、签名、部署、线性历史等。ruleset-only 的受保护分支若 legacy protection API 返回 404，同样保守阻塞。legacy `restrictions`、`allow_deletions`、`allow_force_pushes`、`block_creations` 及 ruleset `deletion`、`non_fast_forward`、`creation`、`update` 仅限制 ref 写入，不阻塞检查集合解析；预检的 `ref_write_rules` 保留来源、类型与原始结构化证据，交由 provider 在写入时执行。B1 不判断 merger/bypass 权限，C strict 模式仍须实时证明保护有效。原生审批、merge queue、签名、部署、code scanning、workflows、lock branch、conversation resolution、线性历史、strict up-to-date 以及任何未知规则仍阻塞，采用白名单分类。B1 不把 provider 的 merge 按钮状态当作已验证规则，也不修改仓库设置。

预检使用实时检查，**不读 `ScmCheckSummary.conclusion`**。Actions 另读取同 head 的最新 workflow run_number/run_attempt；最新 attempt 未 completed 时整条 workflow path 阻塞。完成后读取同一最新 run 的 `/actions/runs/{id}/jobs?filter=latest`，按 job 保留当前有效执行，以 head SHA、check_run ID、job name 和 workflow path 绑定，不能借用其他 run 的绿灯。这保留“仅重跑失败 job”时未重跑的既有成功 job；该 API 部分重跑形状本轮仅 mock，待真实 GitHub 验证。queued/in_progress 的新 attempt 不继承旧 success。只接受 required 身份的 `completed/success`；missing、pending、failure、cancelled、timed_out、action_required、stale、neutral、skipped、unknown 均阻塞。`required_check_missing` 的解释明确包含上文 paths 过滤导致文档 PR 无 build 的情况，不推断路径放行。证据读取失败为 `checks_unavailable`。

审阅 JSON v1：`schema_version, head_sha, base_sha, verdict(pass|block), summary, findings[], evidence[]`。finding 必含 `id,severity(critical|high|medium|low|info),blocking,path,line,message`；未知位置用 null，evidence 是字符串数组。含 blocking finding 却 verdict=pass 返回 400；客户端声明 reviewer/turn/submitted_at 等未知字段也返回 400。身份、turn 和提交时间由认证上下文取得；Agent 不能通过请求头伪装成员。平台 create 成功时记录创建者，update 成功时追加更新者，所有历史更新者都用于独立性判断；create 的复用不会把外部 PR 冒认为平台创建。无法确立平台创建者时返回 `cr_ownership_unknown`，审阅提交也被拒。Agent 必须在白名单且从未创建/更新此 CR；成员通过显式成员凭据按共享 operator 权限提交。成员审阅不适用创建者/更新者排除；成员身份当前为共享 operator，不能区分具体成员。有效审阅在 gate `review_evidence` 中分别标记 `member_attested` 或 `agent_independent`，成员背书不声称 Agent 独立性。

提交时实时读取 PR，head/base 不符返回 409 `scm_pull_request_changed`。策略 PUT 与审阅追加在各自事务内取得同一个 project 行锁，使 PostgreSQL 中两者串行化；策略 PUT 保留 revision CAS。审阅追加不可变历史，绑定当时 head/base、目标分支、base 仓库及策略 revision。同 reviewer 的同绑定只取最高 sequence；任一有效 block 返回 `review_blocked`，另一 reviewer 的 pass 无法覆盖；要求审阅时至少一条有效 pass，否则 `independent_review_missing`。push/force-push、base、retarget、仓库或策略 revision 变化后旧结论不计入；判断实时比对，不依赖 webhook。读证据期间 PR 或策略变化同样阻塞。

响应始终有 `preflight_only=true`、`execution_authorized=false`；凭据边界按 C1 实时证明输出。`allowed=true` 只表示此次读取的 B1 证据满足要求，不能作为执行授权或缓存授权。人工策略返回 `human_approval_required`；B2 创建 operation 绑定的 Inbox 审批，并在 worker 内重新检查全部条件。B2 的执行目标仍须独立绑定和重验，本预检不代替它。

内置 code-reviewer 模板由 `api/agent-templates.ts` 实际加载，本次加入 CLI 结构化提交指引；这只影响以后从模板创建的 Agent，不自动改写现有 DB Agent 的 instructions。`.remi/pipeline/skills/` 的读取链已删除，仍是死目录，本次没有将其当成生效配置；现有审阅 Agent 应由配置维护者按当前模板补提交指引。


## B2：持久合并执行与人工审批

[执行路由](../../packages/server/src/api/routers/merge-execution.ts)、[执行服务](../../packages/server/src/scm/merge-execution.ts)复用 B1 的实时证据读取和 `evaluateMergeGate`，没有第二套检查判据。公开 `GET merge-gate` 的响应和只读语义不变：即使某 operation 已获批准，也返回 `preflight_only=true`、`execution_authorized=false`，人工策略仍显示 `human_approval_required`。

| API | CLI |
|---|---|
| `POST /api/projects/:id/change-requests/:changeRequestId/merge` | `remi scm change-request merge <project> <change-request> --expected-head <sha> --method <merge\|squash\|rebase> [--idempotency-key <key>]` |
| `GET /api/scm/merge-operations/:id` | `remi scm merge-operation get <operation>` |

POST 只接受 `{expected_head_sha, method, idempotency_key}`；HTTP 要求 key，CLI 未指定时生成 UUID。未知字段（包括 actor、reviewer、force、skip）、非法方法和策略未允许的方法返回 400；daemon 返回 403。actor 从认证上下文取得。策略未启用返回 409 `merge_policy_disabled`，不存在无闸门合并路径。CR 必须关联该项目的 Issue。重复 key 返回原 operation；同 key 不同 body 返回 409 `merge_idempotency_conflict`，不重新执行或读取 provider。

operation 持久保存 head/base SHA、规范化 target/base repository、policy revision、method、actor、原因及凭据边界。状态包含 requested、blocked、awaiting_human、approved、executing、merged、failed、unknown、rejected。数据库 partial unique index 保证每个 CR 仅一个活动 operation；unknown 也持有该唯一位置，避免结果不明时创建第二次合并。不同 key 若绑定完全一致，复用活动 operation/Q，同时持久记录该 key 的别名以支持终态后的重放；绑定不同返回 409 `merge_operation_in_progress`。终态 blocked/failed/rejected/merged 允许新 key 新建 operation，但仍须全部重验。

worker 以 version CAS 领取 120 秒租约，网络请求全部在数据库事务之外。每次执行实时重读 PR、完整规则与最新检查、策略和审阅；PR 必须 open、非 Draft，GitHub `mergeable=null` 以 `mergeability_unknown` 阻塞，不轮询等待。除人工批准外任一条件不满足时 operation=blocked、HTTP 409 `merge_gate_blocked` + reasons，不创建 Q，provider merge 调用为零。strict 必须通过 C1 实时保护证明；platform_only 可以执行，仍标注“平台入口受控、直推未封闭”。配置合并槽时使用 server-merger 执行，未配置时仅 platform_only 可回退原任务槽。

只差人工批准时返回 202、`operation_id`、`approval_message_id`，operation=awaiting_human。Agent 请求路由到原 turn 所在工作会话，source_issue_id 取该会话所有者 Issue，并保留该已验证 turn 的 execution_scope；原 scope 可读取和 present，同一 Agent 的其他 scope 不因此获得访问权。成员请求路由到关联项目 Issue 的 Main，execution_scope 为空。无法定位则 409 `merge_approval_unroutable`，不跳过审批。Q 为 `origin=platform_merge_approval`，创建即 human / wait_status=none，无 provider nonce/wait，不经执行负责人链，不使用退役 decision writer。正文展示仓库、PR、head/base、target、method、policy revision、gate 摘要；选项固定 approve/reject。

答复、改答、关闭强制 member-only；Agent 包括负责人都不能代批，escalate 返回 409。Agent 可在现有 Q 读取权限内 present，不改变执行状态。成员 approve 在同一事务以 CAS 将 awaiting_human 改为 approved，提交后唤醒 worker；reject/close 为 rejected，不合并。重复相同 approve 幂等；worker 领取后改答为 409。批准完整绑定 operation_id、head/base、target/base repository、policy revision、method；worker 重验发生绑定变化时以 `approval_stale` 原子阻塞 operation 并关闭原 Q；检查失败或审阅失效同样阻塞，不能靠批准覆盖。新请求使用新 operation/Q。

服务启动、每 15 秒扫描及批准事务提交后的进程内唤醒共同恢复任务；跨进程以数据库为准。PUT 固定带 `sha=expected_head_sha`，不自动重试。GitHub 405/409 记 failed 并保留 provider 原因；超时、不完整响应或崩溃后租约过期只通过 GET 核对：已 merged 且 head 等于预期、merge SHA 可读则 merged；明确仍 open 则 failed，之后允许显式新请求；不能判断则保持 unknown，注明待调查原因。即使崩溃发生在 PUT 之前，也不盲重发可能已经执行的调用。

合并成功后主动读取 PR 经同一 canonical `change.merged` 入站路径，webhook/poll 重放共用逻辑 ID；不另写合并活动，只沿既有开关记录一次 `scm_merge_completed`，不自动 done（ADR 0017）。

B2 本地回归入口为 [merge-execution.test.ts](../../tests/unit/multiremi/merge-execution.test.ts)，覆盖真实 HTTP/SQLite/Question/签名 ingestion，provider 响应为 mock。部分重跑的真实 GitHub API 形状、真实合并、凭据隔离与仓库保护均需另行授权验证；SQLite 测试不代替 PostgreSQL 实跑。迁移为 [共同 additive SQL](../../packages/server/src/store/merge-operation-schema.ts)，兼容输入清单与指纹同批更新，不新增 rollbackSafeFrom 声明。


## C1：token 双槽位与实时保护证明

现有 `access_token` 是 task-writer：git-credentials、PR 创建/更新和检查证据仍使用它。
连接新增加密的 `merge_credential_encrypted`、hint 与 `merge_credential_kind`，C1 只支持 `token`。
成员使用现有 `PATCH /api/workspaces/:workspaceId/scm/connections/:connectionId` 更新
`mergeCredential`（可显式 `mergeCredentialKind: "token"`）或 `clearMergeCredential: true`；
两者互斥，Task/daemon 写入返回 403。连接响应仅给 `mergeCredentialSet`、hint 和 kind，永不返回明文。
CLI 续用 `remi scm connection update <connection> --file -`，从 stdin 读 JSON；合并凭据禁止用 `--data` 或文件路径传入。

`getScmConnectionCredential` 不含合并槽。只有服务端 worker/保护证明模块可经独立入口读取它，架构测试固定调用白名单。
配置合并槽后，仓库规则读取与 merge API 使用合并身份；PR/检查仍用 task-writer。
platform_only 没配合并槽时保留 B2 的任务凭据回退；strict 没配时返回 `merge_credential_missing`，不调用 merge。
GitHub App 的签发与安装身份留给 C2，真实身份、仓库设置和 PAT 轮换待外部授权，本实现不更改这些设置。

[`credential-boundary.ts`](../../packages/server/src/scm/credential-boundary.ts)读取 GitHub 证据，
[`protection-proof.ts`](../../packages/server/src/scm/protection-proof.ts)纯函数求证。
服务端分别用两个 token 调 `GET /user`，按 provider user ID 判断分离，不按 token 文本。
任务仓库权限由 collaborator permission 接口取得；custom role 无法证明其管理权限时阻塞。
对策略的**每个精确 target branch**读取完整有效规则、classic protection 和分页 restrictions；
ruleset 按有效规则携带的 ID 经 repository 端点读取（含继承规则），用合并身份读全量 bypass_actors，
用两种身份分别读取 `current_user_can_bypass`。缺失字段、权限失败、未知规则/actor/参数、分页超限均不放行。

| 证明项 | 放行条件 | 主要阻塞码 |
|---|---|---|
| 合并槽和独立身份 | 有 token，两次 `/user` ID 不同 | `merge_credential_missing` / `credential_identity_not_separated` |
| 非管理员任务身份 | 低于 admin 且为可识别标准仓库角色 | `task_identity_admin` / `protection_permissions_unsupported` |
| provider 强制检查 | 非空 required checks；classic `enforce_admins=true`，或 required-check ruleset 两身份均 `never` bypass | `protection_required_checks_bypassable` |
| 禁止任务更新目标 | classic 完整 restrictions 仅显式 users，排除任务、允许 merger；或 update ruleset 任务 `never`、merger 可 bypass，且 `update_allows_fetch_and_merge=false` | `protection_task_can_update_target` / `protection_restrictions_unsupported` |
| 禁止 force push / 删除 | classic 禁止且 enforce_admins，或相应 ruleset 两身份均不可 bypass | `protection_force_push_allowed` / `protection_deletion_allowed` |
| 完整可读证据 | 每个目标和所有页可读，规则/bypass 语义已知 | `protection_read_failed` / `protection_bypass_unreadable` / `protection_pagination_incomplete` / `protection_evidence_incomplete` / `protection_rules_unsupported` |
| 证据一致性 | 凭据和策略读取期间不变 | `protection_credentials_changed` / `scm_credential_protection_changed` |

required-PR 本身不能证明任务无法调用原生 PR merge，不能代替 restrictions/update。
C1 classic restrictions 的 teams/apps 需要额外成员/安装证明，暂以 `protection_restrictions_unsupported` 阻塞。
现有 B1 对 classic `/protection` 404 仍阻塞，纯 ruleset 仓库也不据此推断“无 classic”；
C1 仅支持存在 classic 保护的目标分支，可叠加 ruleset；classic 404 返回 `protection_classic_unreadable`，gate 拒绝、git-credentials 返回 409。纯 ruleset 配置尚不支持；纯 evaluator 的拆分 ruleset 测试不代表 HTTP 入口已支持。

启用前需要 Admin 配置的 classic 示例：每个 target 有明确 required checks、`enforce_admins=true`，
restrictions 只允许独立 merger 用户，不包含 task 用户/teams/apps，关闭 force push 和删除；
task 为标准 write（非 admin）角色。restrictions 仅适用于组织仓库，真实目标是否满足须外部验收确认。叠加 ruleset 时，merger 只能绕过 update，不能绕过 required checks / non_fast_forward / deletion。
不支持的原生审批、严格 up-to-date、merge queue 等 B1 原因码继续生效，不改 workflow。

strict 成功返回 `protection_proof`（checked_at、身份和逐目标证据）及
“平台入口受控、直推已由仓库保护封闭（实时证明）”；失败保留“平台入口受控、直推未封闭”并列出原因。
GET gate 仍是预检，不变成执行授权。worker 在执行时重新证明，人工批准不缓存证明；
凭据变更期间立即停止该次执行。所有证据均来自服务端，不接受任务提交或手填证明。

strict 覆盖持久化于 `multiremi_scm_strict_coverage`，按 workspace/repository/project 唯一。派生集合为 github_repo、递归 project_ref 与活跃 CR link；复用任务仓库解析，但不采用空资源时的 workspace 回退。成员 PUT enabled+strict 时整体重算，集合为空返回 400 `merge_policy_strict_coverage_empty`；关闭或 platform_only 时清空该项目覆盖。
资源创建/更新及 CR link 写入同一事务追加覆盖（包含 project_ref 的依赖项目）；每次凭据、gate 和 worker 判定再以持久 ∪ 动态补齐。Task 删除资源、解除 CR 或移动 Issue 不会收缩；只有成员 PUT 可收缩。Task 增加资源可能扩大覆盖，使其他项目取凭据也收到 409；成员删除资源并重新 PUT 可解除。

仓库只要被任一 enabled+strict 项目持久覆盖，该仓库的所有 git-credentials 调用方
（包括 daemon broker）都必须先通过全部策略的证明；失败 HTTP 409 且不含 password。
证明不缓存，每次重新读取，因此更换任一凭据、覆盖集合或策略 revision 立即重新证明。证明结束再核对覆盖集合、策略 revision 及凭据版本，变化时不下发写凭据。
返回的始终是 task-writer；原 PAT 生命周期与 helper 的 expiresAt 独立，旧凭据撤销仍需外部授权。
strict 尚未证明时私有仓库也无法克隆；只读源码获取通道不在 C1，需后续单独跟进。

C1 回归使用 mock GitHub 与本地真实 SQLite/HTTP/Task token/Question/worker。
真实 GitHub token、保护规则、拒绝直推/force-push/原生 merge 与合并身份验证均**待外部授权**，不把 mock 作为真实验收。
PostgreSQL 仅在配置隔离实例时实跑；否则交接明确标为静态核对。
