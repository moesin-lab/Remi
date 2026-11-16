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

摘要的 `conclusion` 是已观察检查的汇总：空集合为 `missing`，失败为 `failure`，运行中、未知、skipped/neutral 为 `pending`，全部 success 才是 `success`。它**不代表 required checks 已满足，也不授权合并**；仓库规则和项目附加要求将在 B 阶段统一判定。

GitHub `check_run` webhook 经现有签名验证后只写内部 `checks` 观测的 `check_run` 实体快照，以 `check_run:<id>` 标识，保留 app、job、check suite 身份、delivery ID 和原始签名所覆盖的 body。快照是按 revision 保留的最新证据，不是完整 delivery 历史。不同 delivery 会改变 contentHash，但相同 revision 会被 Store 拒绝；这不是忽略 delivery 的语义去重，B 不能把它当作检查状态变化通知。workflow 路径仍由实时检查接口在服务端关联。选择独立快照是为了保留证据而不扩展公开事件枚举：它不创建 canonical event，不可被 Autopilot 订阅，也不写 pipeline 快照；GitHub 适配器在来源处标记 `entityType=check_run`，reconcile 仅按此类型禁止派生事件，不按 payload.kind 或 ID 前缀猜测其他 provider 的分类。B 如需检查变化触发闸门重评，只在内部消费。

既有 `workflow_run` 的 `pipeline.*`、`workflow_run:<id>:<attempt>` 标识及去重行为不变。GitHub 后台 pipelines 轮询仍只采集 workflow runs；Codebase 既有 ListCheckRuns 轮询仍产出 pipeline 快照和 `pipeline.*` 事件；check runs 的当前证据通过上述实时检查接口读取。不能把 webhook 快照作为当前合并判据。

底层 `merge` 方法仅供后续服务端合并操作调用，固定传 GitHub merge API 的 `sha` 原子比较参数，不重试失败/超时写入。A 阶段没有公开合并 HTTP/CLI 入口；整个 Draft PR 需完成 B/C 并最终复审后才能上线。

## 已批准、尚待 B/C 实现的策略边界

MUL-35 裁定要求项目策略默认关闭，required checks 使用仓库有效保护规则与项目附加项并集，项目不得删减仓库约束。独立审阅绑定 head/base SHA 与策略版本，Agent 必须在 `independent_reviewers` 白名单，且不能是该 CR 的平台创建/更新调用者；无平台归属的 CR 不计入 Agent 审阅。人工决定使用 member-only 的 `platform_merge_approval` Question origin，直接进入人工阶段，无 provider wait；批准绑定 operation/head/base/policy revision。

合并操作需持久化与幂等恢复，超时先标 unknown、查询实际状态后再决定。完成后沿现有 `scm_merge_completed` activity 规则，不自动将 Issue 标 done（ADR 0017）。

C 阶段分离 task-writer/server-merger 凭据；任务及 daemon git-credentials 路径永不返回合并凭据。严格模式下未配置独立任务身份或无法由服务端合并身份实时证明仓库保护有效（含 bypass 列表）时拒绝发写凭据和执行合并。未启用严格凭据模式时必须显示“平台入口受控、直推未封闭”。仓库保护设置、身份创建、现有 PAT 轮换与隔离测试仓库需另获外部授权；本单不自行修改设置。

## Remi 项目 CI 的已知限制

Remi 项目采用 GitHub Actions app + `.github/workflows/release-build-check.yml` + job `build` 的身份，不复制 job 清单。目前该 workflow 的 PR 触发带 `paths:` 过滤，纯文档 PR 可能没有 build。missing 一律阻塞，后续 gate 必须输出明确的 missing 原因，不通过路径推断放行。本单不改 workflow；启用严格策略前需跟进“PR 无条件触发 + 内部变更检测”。

PR 的 build 运行采用 pr-fast，不运行 backend 全量测试；PR 绿灯不能作为发版授权。main 的完整发版证据继续由现有 `trustedReleaseRun` 判定，见[测试指南](../../TESTING.md)。

## 验证入口

`bun run test tests/unit/multiremi/scm-operations.test.ts tests/unit/multiremi/multiremi-api-scm-operations.test.ts tests/unit/multiremi/scm-providers.test.ts tests/unit/multiremi/scm-webhook.test.ts tests/unit/remi/cli-operations.test.ts` 覆盖模拟 provider 的操作、分页、证据身份、失败、HTTP 与 CLI 契约。这些测试不等于真实 GitHub 合并/保护验收；真实验证需另记录授权、仓库、SHA、检查与 provider 回执。
