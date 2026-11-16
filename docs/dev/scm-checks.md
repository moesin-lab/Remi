---
title: SCM 实时检查查询
status: active
summary: Agent 使用任务凭据读取 GitHub PR head 的 CI 观测，不获取 provider token。
---

# SCM 实时检查查询

`remi scm change-request checks <repository> <number> --json` 调用
`GET /api/workspaces/:workspaceId/scm/repositories/:repositoryId/change-requests/:number/checks`。
repository 是平台仓库 ID，number 是 GitHub PR 编号。成员和同工作区 Task 凭据可读，daemon 不可调用业务端点。
仓库必须有已启用的 SCM 绑定和连接；服务端使用连接凭据访问 GitHub，不把 provider token 返回给任务。
连接需要读取 Pull requests、Checks、Commit statuses 和 Actions 的权限；权限不足返回 provider 错误，不退回匿名 API。

响应 `summary` 包含完整 `headSha`、`observedAt`、`checks[]` 和 `conclusion`。
每个检查保留 kind、name、status、conclusion、url，以及可证明的 app ID/slug 和 workflow path。
check runs 按 latest 读取，commit statuses 每个 context 保留最新值，所有分页读全才返回。
查询前后重读 PR；head/base SHA、目标分支或 base 仓库变化时返回 409 `scm_head_changed`，调用方重新查询。
缺页、SHA 不符、provider 限流/权限错误或超时不会返回成功摘要；provider 响应正文不透传。

没有检查时 conclusion 为 missing；存在失败时为 failure；运行中、未知、neutral/skipped 为 pending；全部 success 才为 success。
这是已观察检查的汇总，不表示 required checks 已满足，也不授权合并。
此查询只向 provider 发 GET，不写 SCM 快照或触发 Issue 事件；不包含 PR 创建、更新、合并、webhook 或策略迁移。

验证入口：`bun run test tests/unit/multiremi/scm-checks.test.ts tests/unit/multiremi/multiremi-api-scm-checks.test.ts tests/unit/remi/cli-operations.test.ts`。
测试使用真实 Task 鉴权/HTTP/SQLite，远端 GitHub 为 mock；真实已部署服务的任务凭据查询需另行验收。
