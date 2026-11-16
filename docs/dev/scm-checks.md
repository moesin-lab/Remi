---
title: SCM 实时检查查询
status: active
summary: Agent 使用任务凭据读取 GitHub PR head 的 CI 观测，不获取 provider token。
---

# SCM 实时检查查询

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

没有检查时 conclusion 为 missing；存在失败时为 failure；运行中、未知、neutral/skipped 为 pending；全部 success 才为 success；queued/in_progress 的 workflow 即使尚无 job checks，也参与汇总并阻止 success/missing。
这是已观察检查的汇总，不表示 required checks 已满足，也不授权合并。
此查询只向 provider 发 GET，不写 SCM 快照或触发 Issue 事件；不包含 PR 创建、更新、合并、webhook 或策略迁移。

验证入口：`bun run test tests/unit/multiremi/scm-checks.test.ts tests/unit/multiremi/multiremi-api-scm-checks.test.ts tests/unit/remi/cli-operations.test.ts`。
测试使用真实 Task 鉴权/HTTP/SQLite，远端 GitHub 为 mock；真实已部署服务的任务凭据查询需另行验收。
