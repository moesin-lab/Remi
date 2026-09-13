# 自动化、团队与执行

## Squad

```sh
remi squad list --json
remi squad get <squad-id> --json
remi squad member list <squad-id> --json
remi agent list --json
remi squad create --name "Review team" --leader <agent-id> --json
remi squad member add <squad-id> <agent-id> --type agent --role reviewer --json
remi squad member list <squad-id> --json
```

先确认 leader 与成员的真实 Agent ID、可执行 provider 和职责；平台的人类成员与 Agent 成员用不同的 `--type`。建队或加成员不等于已经派单，读取团队定义与成员列表分别核验。

## Autopilot

```sh
remi autopilot list --json
remi autopilot get <autopilot-id> --json
remi autopilot trigger list <autopilot-id> --json
remi autopilot scheduler --json
remi autopilot create --help
remi autopilot trigger create --help
```

先明确执行者、要做的事、时间和时区、是否创建 Issue，以及用户是否要求立即执行。自动化定义和触发器分别配置，不凭自然语言猜 cron 时区或沿用别的平台默认值。

常用定义字段为 `title`、`description`、`assignee_type`、`assignee_id`、`execution_mode`、`status`；其余字段仅按目标版本已公开的契约提供。通过 `remi autopilot create --file <autopilot.json> --json` 创建，记录返回的 ID；修改用 `remi autopilot update <autopilot-id> --file <autopilot-patch.json> --json`。

`assignee_type` 为 `agent` 或 `squad`；`execution_mode` 为 `create_issue`、`run_only` 或 `trigger_issue`；`status` 为 `active`、`paused` 或 `archived`。让已有自动化只运行任务时选择 `run_only`，需要形成新 Issue 时选择 `create_issue`；`trigger_issue` 的触发配置另有约束，不能当作通用定时执行模式。启用定时任务需要自动化 active、触发器 enabled 且调度器正常；只保存了 cron 表达式不等于会执行。

对于现有自动化，增加定时触发器的 JSON 示例：

```json
{
  "kind": "schedule",
  "cron_expression": "0 9 * * *",
  "timezone": "Asia/Shanghai",
  "enabled": true
}
```

此例是上海时区每天 09:00，只有它与用户要求一致时才使用。提交后读回触发器、自动化状态和调度器状态：

```sh
remi autopilot trigger create <autopilot-id> --file <schedule.json> --json
remi autopilot trigger list <autopilot-id> --json
remi autopilot get <autopilot-id> --json
remi autopilot run list <autopilot-id> --json
```

`schedule_targets` 的更新替换整个目标选择，`null` 清除；修改其中一个项目或仓库时先保留其余目标。Webhook 的 token / secret 不出现在报告中；重放投递与 `autopilot run` 都会实际执行，只有用户要求时才触发，不拿来当保存成功的探针。

## Issue、Chat 与 Task

Issue 是跟踪的工作，Chat 是会话，Task 是一次执行；配置云友不会自动验证其工作能力。

```sh
remi issue list --json
remi issue get <issue-id> --json
remi chat create --help
remi task create --help
remi task get <task-id> --json
```

实际任务验证必须属于用户的请求。可用 `remi task create --agent <agent-id> --prompt <requested-work> --json`，保存 Task ID 并查询到终态。涉及持久本地目录时，先在 Issue / Chat 选择 `--runtime-workspace`，不要猜一个不存在的 Task 目录参数。

```sh
remi chat create --agent <agent-id> --runtime-workspace <runtime-workspace-id> --json
remi chat create --agent <agent-id> --project <project-id> --json
remi issue create --title "Inspect local state" --runtime-workspace <runtime-workspace-id> --json
```

这三条是不同的选择示例，不应为了验证而全部执行。派单、发送消息、状态变更可能启动工作；先查看相应命令帮助和当前状态，不假设 Multica 的 `--no-start` 或 mention 语义也适用于 Remi。

已有任务只需要汇报进展时，不再创建一个重复 Task。写入响应丢失时先查任务、自动化运行或消息记录；网络重试不等于可以重复提交用户工作。最终报告实际执行终态和输出，不能用 HTTP 200 或 Runtime 在线替代任务结果。
