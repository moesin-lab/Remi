# Issue、Session 与交付

## 查找、创建和派单

Issue 跟踪目标与状态，Session 组织参与者、消息和成果，Turn 记录一轮工作，Attempt 记录其执行尝试。每个 Session 恰好由一个 Issue 或 Chat 拥有；Chat-owned Session 关联 Issue 不会改变所有者。先定位已有工作，避免把“继续这个问题”变成重复创建。

```sh
remi issue list --json
remi issue search "<query>" --json
remi issue get <issue-id> --json
remi issue create --title "<requested-title>" --description-file <brief.md> --project <project-id> --no-project-defaults --json
remi issue assign <issue-id> --to <agent-id> --to-type agent --json
remi turn list --issue <issue-id> --json
```

示例创建未分配的项目 Issue；需要自动分配时按用户意图使用项目默认值或显式 assignee。**省略 assignee 会继承项目默认执行者**，`--no-project-defaults` 才表示不继承。创建响应里的派发结果与实际 Task 状态分别检查。

派给人、云友或团队时明确 `member|agent|squad`，不要仅凭同名对象猜类型。`issue assign` 使用 `--to/--to-type`，`issue create/update` 使用 `--assignee/--assignee-type`。创建、分配、状态变化、发送 request 都可能启动工作；不能将它们当读取探针。

工作位置二选一：项目用 `--project`，Runtime 持久目录用 `--runtime-workspace`，详见 [Runtime](runtimes.md)。已执行的目录绑定不可任意移动。`issue status <issue> <status>` 改业务状态，`turn cancel <turn> --yes` 取消执行，二者不能互相代替。

## 组织工作与沟通

```sh
remi issue children <issue-id> --json
remi issue child-progress <issue-id> --json
remi issue dependency list <issue-id> --json
remi issue dependency add <issue-id> <dependency-ref> --type blocked_by --json
remi label list --json
remi issue label list <issue-id> --json
remi message list <issue-id> --json
remi message send <issue-id> --content-file <comment.md> --json
```

依赖示例表示当前 Issue 依赖另一个 Issue；`--type` 取 `blocked_by|blocks|related`，默认 `blocked_by`，位置参数与 `--blocked-by` 都接受 key 或 id。写前确认方向，随后 list 核验。子任务创建用 `issue create --parent`，可重复的 `--blocked-by` 声明前置；`issue list --parent` 只看该单的直接子单，`--top-level-only` 只看没有父单的 Issue，同时给出时 `--top-level-only` 生效。标签定义用 `label`，Issue 上的绑定用 `issue label`。订阅、反应、自定义字段分别从 `issue subscriber`、`issue reaction`、`issue metadata` 查帮助。

评论、回复、发布成果都是协作写入，沿用用户已有发送授权。`message resolve` 解决一条评论，不代表 Issue 完成。批量修改先列出精确目标 ID 并读当前值；`issue batch-update` / `batch-delete` 的 JSON 不能从单条更新参数推断。`issue delete` 与 `issue restore` 的当前归档/恢复行为以目标版本帮助和返回为准，不能用批量删除整理无关任务。

## Session、成果和归档

```sh
remi issue session list <issue-id> --json
remi issue session get <issue-id> <session-id> --json
remi turn list --session <session-id> --json
remi issue session result list <issue-id> --json
remi issue session result publish <issue-id> <session-id> --type report --title "<result-title>" --content-file <result.md> --json
remi session archive status <issue-id> --json
```

Issue 创建时已有自己的 Main；从 Issue 派发无需另建 Chat。Issue 路径的 get、update、participant 命令同时需要 Issue ID 和 Session ID；成果 publish 也接受 `--session <session-id>`。成果类型为 `mr|report|deploy|decision|doc|other`，发布可复用结论并附实际证据，不把未完成的运行写成成果。消息与派发统一使用 `remi message send <session-id> --to <agent-id> --kind request`，轮状态使用 `remi turn`；旧 Session task/message/event 命令仅提示替代命令，不执行。`session config get/update <workspace>` 配置 provider 归档，不是单个产品 Session 配置。

Issue 列表可能包含有权访问的 Chat-owned 工作投影；先读返回的 `owner_type/owner_id`。Chat-owned 的管理使用 `remi session ... <chat-id> <session-id>`；不能把 Issue ID 传给这组 Chat 命令。两种所有者的消息都按 Session ID 使用 `message`。没有 Chat ID 的 Issue-owned Session 可以直接执行，不需要 adopt。

需要基于既有讨论另开侧会话时，Issue-owned 用 `remi issue session create <issue> --from <parent-session> --title <title>`，Chat-owned 用 `remi session create <chat> --from <parent-session> --title <title>`；父会话须属于同一所有者和工作区，侧会话不能继续派生。默认 snapshot 冻结创建时的父会话快照，后续父消息不自动进入；继承内容只作参考，当前请求和后续本会话输入才是执行指令。侧会话不占用 Issue 工作区，Agent 不得从其中委派子任务；需要代码的讨论按 `--with-code` 当前帮助及执行限制操作。

`remi session show <session>` 查看会话，`remi message list <session>` 查看消息，`remi session inherited-context <session>` 查看最近一次领取记录的继承诊断；这些按 Session ID 访问的命令支持两种所有者。事件数量是截断前计数，实际上下文可能受 token 预算截断，尚未领取时不能声称继承内容已全部送入模型。

Task 凭据绑定当前 attempt；读取 Session 内容限于当前 Session。私有 Chat-owned 执行的读取与控制限于本任务，公开 Issue-owned 或没有 Chat 的任务接口保留既有工作区、owner 与各路由权限。旁聊可用 `remi message list <parent> --from X --to Y` 读取同所有者的直接父会话，但必须已有继承领取记录，且不能超过该 attempt 持久化的继承截止 seq；不要改用父会话的 window/tail 读取绕过限制。经验证的飞书群 Issue Topic 协调任务可读相关 Session/Turn 的安全 metadata，并通过定向 request 交接；协调权限不包含其他 Session 的消息历史、turn input、attempt trace 或其他私有任务的取消与 inspection。Chat-owned 目标须属于同一 Topic Chat，Issue-owned 目标须属于绑定 Issue。监督者重试使用 `remi turn retry <turn>`，仍按明确监督者或关联控制任务身份、模式与审计约束执行。

定向 request 可向同工作区其他 Issue-owned Session 派发委派工作，须满足实际 owner、工作区、Agent、来源轮血统、交接次数及旁聊限制。发送成功不额外授予 Session 内容或执行读取、控制权限；Chat-owned 目标须是当前 Session 或已验证 Topic 协调目标。消息即使已保存也可能降为 next_turn 或 inbox_only，应核对 `wake_applied/wake_reason`。Issue 触发的 Autopilot 使用 Issue-owned Session，`reuse_latest` 不复用 Chat-owned 工作投影。

`session archive verify/retry` 会执行校验或重试归档，不是单纯读取；先看 status 和 list，针对已有失败记录处理。`remi turn trace read <turn> --attempt <attempt>` 查询指定尝试的执行证据。

## 附件与分享

```sh
remi issue attachment list <issue-id> --json
remi issue attachment upload <issue-id> --attachment <artifact-path> --json
remi attachment download <attachment-id> --output-dir <destination-directory>
remi share get <issue-id> --json
remi share create <issue-id> --json
```

下载命令的 `--output` 是本地文件路径，不是 Registry 通用输出格式，不能加 `--json`；保存前检查同名文件。上传后用返回 ID 核对归属和下载内容。

分享 create/extend/delete 改变链接的访问能力，只有用户要求分享或撤销时操作；返回链接只交给预期接收者。持有 share 凭据不等于加入工作区，不用它做成员管理。
