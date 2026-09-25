# Runtime、模型连接与本地目录

## 查清执行机器

```sh
remi runtime list --json
remi runtime get <runtime-id> --json
remi runtime model list <runtime-id> --json
remi runtime task-activity <runtime-id> --json
```

Runtime 是某台 daemon 提供的执行能力，Agent 是工作区里的云友定义。修改云友模型与配置模型提供商连接是不同操作。核对 provider、归属机器、心跳新鲜度和活动任务；仅 `status: online` 或 SSH 可达不能证明目录扫描或执行已经恢复。

## 集中配置连接与能力组

先在工作区配置可复用 Profile，再把 Profile 和机器上的 Runtime 绑定到能力组，最后让云友选择组。写入需人类工作区管理员权限；组成员还受 Runtime 编辑权限约束。task/daemon 凭据不能管理配置。自动扫描只发现引擎，不创建能力组。

先核对已有对象与当前命令参数：

```sh
remi runtime profile list --json
remi runtime group list --json
remi runtime profile create --help
remi runtime group create --help
```

Codex 需要 Responses 兼容接口；Claude Code 需要 Anthropic Messages 兼容接口。根据用户提供的信息核对协议、基础地址和模型 ID，缺失且影响配置时再询问。Codex 请求文件示例：

```json
{
  "name": "团队 Codex",
  "provider": "codex",
  "profile": {
    "name": "custom-codex",
    "base_url": "https://gateway.example/v1",
    "model": "provider-model-id",
    "auth_mode": "api_key",
    "env_key": ""
  },
  "api_key": "<user-supplied-api-key>"
}
```

Claude 使用 `provider: "claude"`，在 `profile` 中加 `auth_header: "bearer"` 或 `"x-api-key"`。内层连接 `name` 只用字母、数字、下划线、连字符，外层 `name` 是展示名；`base_url` 是 HTTP(S) 基础地址，无用户信息、query 或 fragment。Claude 基础地址不包含完整 `/v1/messages` 路径。

```sh
remi runtime profile create --file <private-profile.json> --json
remi runtime profile get <profile-id> --json
```

更新使用 `remi runtime profile update <profile-id> --file <private-profile.json> --json`，提交完整配置。已有密钥时省略顶层 `api_key` 表示保留；首次使用 `api_key` 模式需提供密钥。读取只返回配置和不透明凭据引用。每次保存生成新 revision；provider 创建后不能改。

使用实际返回的 Profile ID 和查询到的 Runtime ID 创建组：

```json
{
  "name": "团队开发",
  "provider": "codex",
  "profile_id": "<profile-id>",
  "runtime_ids": ["<runtime-id>"]
}
```

```sh
remi runtime group create --file <group.json> --json
remi runtime group get <group-id> --json
remi runtime group list --json
remi runtime model catalog --execution-group <group-id> --json
```

成员必须属于当前工作区并兼容组的 provider；一个 Runtime 可以加入多个组。`profile_id: null` 使用工作区 Relay / 原生连接，不继承旧的单 Runtime 自定义连接。组修改使用 `runtime group update <group-id> --file <group.json>`；云友通过 `agent update <agent-id> --execution-group <group-id>` 选择组，执行前核对用户要求的云友和目标。

读回配置和成员后，等待各机器确认当前 Profile revision。待应用或失败的机器不能领取该受管组任务；在线不等于已应用，已应用也不等于模型调用成功。任务首次领取冻结连接快照，运行中任务不随配置变更切换。用户要求验证执行时再创建最小测试任务或 Chat，并检查终态。

若密钥已配置在每台承载机器的 daemon 进程环境，使用 `auth_mode: "env"`，省略 `api_key`。Codex 的 `env_key` 必须为 `REMI_CODEX_*`，Claude 必须为 `REMI_CLAUDE_*`。运行管理 CLI 的终端变量不会自动进入远端或后台 daemon；修改环境时核对实际服务管理方式和重启影响。

删除使用 `runtime profile delete <profile-id>` 或 `runtime group delete <group-id>`：仍被组引用的 Profile、仍被云友引用的组会拒绝删除。旧版单 Runtime 的 `runtime codex-profile get|set`、`runtime claude-profile get|set` 保留兼容，但不编辑中央组配置。迁移和下发契约见[执行配置](../../../../docs/dev/execution-configuration.md)。

## 本地工作目录

`remi workspace` 是团队租户；`remi runtime workspace` 是 daemon 所属机器上的持久执行目录。目录不要求是 Git 仓库。

```sh
remi runtime workspace list --runtime <runtime-id> --json
remi runtime workspace create <runtime-id> --name "Local workbench" --root <absolute-remote-directory> --cwd . --json
remi runtime workspace get <runtime-workspace-id> --json
remi runtime workspace rename <runtime-workspace-id> --name "Research" --json
```

根目录必须已经存在于该机器；`cwd`、`--context-path`、`--env-file` 相对根目录。注册不创建目录、不 clone 仓库、不切分支。目录配置创建后固定，改变路径需新建记录；重命名不移动文件。

需要浏览时，提交 `{"root":"~","mode":"browse"}` 的扫描 JSON，然后轮询返回的 request ID：

```sh
remi runtime directory scan <runtime-id> --file <directory-scan.json> --json
remi runtime directory status <runtime-id> <request-id> --json
```

目录扫描会创建异步请求，但不创建目录；这是用户要求浏览或排查目录时的适当验证。等到完成后使用返回的绝对路径，不复用失败扫描的旧结果。

项目与本地目录是 Issue / Chat 工作位置的两个互斥选项，按本次任务选择，不写成 Agent 永久默认。同时传 `--project` 和 `--runtime-workspace` 会被拒绝。已有任务的执行绑定不能随意更换；Chat 换目录时创建新的 Chat。

## 离线排查边界

Runtime 在线只证明近期登记状态；目录请求和 provider 执行仍需独立检查。daemon 本机生命周期、后台服务环境、SSH 临时恢复与平台升级见 [运行维护](maintenance.md)，不要从某个 Runtime 离线直接推断整个平台需要重启。
