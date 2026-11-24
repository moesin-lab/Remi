---
title: 工作区系统默认行为
status: active
summary: 五槽行为文案、受保护运行协议、不可变版本与按尝试生效的契约。
---

# 工作区系统默认行为

MUL-3 将工作区的默认行为文案与平台运行协议分开。共享文本与 DTO 定义于
[system-prompt-policy.ts](../../packages/contracts/src/system-prompt-policy.ts)，服务端和 daemon 的
[shared 运行时哈希目录](../../packages/shared/src/system-prompt-policy-hash.ts)对格式版本和固定顺序的完整文档计算 SHA-256。
浏览器只依赖前者，不引入 Node crypto。此文档描述开发契约；测试及集成状态以 PR 对应 SHA 的执行证据为准。

文档包含五个纯文字槽位，保存时必须完整提交；空字符串是有效自定义，不代表跟随默认。
统一 CRLF/CR 为 LF，总长最多 8,000 Unicode code points；不执行模板、远程 include 或代码。

| 槽位 | 可编辑内容 | 条件 |
|---|---|---|
| common | 通用风格、语言和协作偏好，初始为空 | 所有会话 |
| code_delivery | 推送分支、创建/复用 PR、Issue 关联、创建前审批偏好与结果格式 | 代码工作 |
| chat_delivery | 附件与纯文本的选择、源码和日志附件偏好 | Chat |
| issue_delivery | 短图内联与完整报告附件偏好 | Issue |
| finishing | 变更、验证和风险总结，允许清空 | Issue / Product Session |

[代码交付协议](../../packages/contracts/src/remi-rules.ts)继续保留合并和直推默认分支的显式授权要求、失败诚实报告和小队交付约束。
[附件协议](../../packages/contracts/src/artifact-delivery.ts)保留 CLI 语法、目标解析、20MB/凭据限制、HTML 沙箱、真实投递回执与下载协议。
这些只读块不重复覆盖可编辑句子。身份、未读回执、问题上交、共享目录、Project Knowledge、动态 ID 和路径仍由代码生成。
Prompt 文案不授予额外工具或凭据权限。

既有 workspace appendix（`/prompts`、`settings.prompt_appendix`）独立追加，不迁移为 custom；重置系统行为不清空它。
Agent、Project、小队和宿主机本地指令沿用各自入口，不纳入本期版本管理。

`default` 每次新 claim 解析服务端当前目录；`custom` 保留完整快照与服务端权威保存的编辑基准。
未初始化的 GET 为 revision 0，不产生历史。首次 edit 建 initialize v1 后追加 edit v2；首次 reset 直接建 reset v1。
文档 revision 始终等于当前版本号。每个独立 reset 请求追加历史并恢复跟随最新默认；同 requestId 重放返回原操作。
恢复任意历史版本都复制精确快照，追加新的 custom rollback 版本，即使目标是旧 default/reset。

新资源独立 head、append-only versions 与 attempt binding；写操作在 workspace 生命周期锁后，同一事务内校验 expectedRevision、
幂等请求和当前指针，冲突 409 且不留半写历史。actor 来自鉴权，区分共享 operator 与真实登录账号；新资源写操作仅人类管理员，
task hard deny 与 CLI parity deny 同步维护。原 appendix 的既有权限不变。

保存对后续新 claim 生效。每次 claim 持久化 offer 代次，发送、回执及收回按代次校验。未接受的 offer 再次领取时重绑，已确认或运行中的尝试保留原快照。
offer 的 system_prompt_policy 对象完整发送。指令预算截短时，全文入口携带 attempt ID 和内容 SHA-256，从绑定读取五槽正文。
新 daemon 经 provider home AGENTS.md 消费，最终指令纳入驻留启动指纹；内容变化按既有 config_changed 流程重建。
当 custom 或服务端默认偏离首版等价基线时，claim 前要求 `prompt.policy.adopt.v1`。当前连接协商的能力、数据库内领取资格和设备等待原因共同决定排队诊断。诊断每次按创建时间与 ID 检查最多 32 项，正常领取沿用任务优先级。

重置默认触发调度条件更新。调度器在原有分页扫描中清理自身的等候原因，设备等候和延迟重试沿用各自的规则。首轮上界在分页期间固定，新入队任务进入后续扫描。

丢失采用请求、丢失成功回包、实际 provider 指令文件与 CLI 的同 attempt 读回见 `tests/integration/daemon-protocol-v2/task-report-recovery.test.ts`。`tests/integration/daemon-protocol-v2/planned-restart.test.ts` 覆盖升级前后 journal、双向能力协商、真实 socket 重连及冻结策略的续接。旧库发现水位、分区原件、上行回执与执行进程退出分别在 `tests/unit/daemon/task-report-outbox.test.ts` 验证。
用户文字优先让出指令预算；只读协议自身超限必须显式失败。

查看和修改入口为工作区设置的 Prompts 页，以及 `remi workspace system-prompt` 的
`get|set|reset|history|version|restore|diff|preview` 子命令；参数和文件格式见[CLI 契约](../cli-command-migration.md)。
API 统一挂在 `/api/workspaces/:id/system-prompt`：GET 当前状态、PUT 完整保存，
POST `/reset` 和 `/restore` 追加版本，GET `/versions` 和 `/versions/:versionId` 查看历史，
POST `/preview` 预览当前或未保存正文。写入须携带 `expectedRevision` 与唯一 `requestId`；
网络结果不确定时重用同一请求，收到 409 后保留草稿并重新读取，不能自动覆盖并发修改。
预览使用明确的 Issue 场景，不包含宿主机本地上下文；实际轮次的输入可查看所绑定版本和正文哈希。

组装路径见[每轮输入与指令文件](../adr/0023-turn-input-and-provider-agents-md.md)，验证方法见[测试规范](../../TESTING.md)。
针对性回归入口如下；执行结果必须以目标 SHA 的测试输出为准。

| 范围 | 测试入口 |
|---|---|
| 文本边界、规范哈希与受保护句子 | [共享契约](../../tests/unit/contracts/system-prompt-policy.test.ts) |
| 版本、默认升级、CAS/幂等、权限、审计、实际输入与清理 | [SQLite/API](../../tests/unit/multiremi/system-prompt-policy.test.ts) |
| 两进程首次保存竞争、幂等重放竞争与 level-4 迁移回滚 | [PostgreSQL](../../tests/unit/multiremi/schema-levels-postgres.test.ts)；须设置本机 `MULTIREMI_TEST_POSTGRES_URL`，否则明确跳过；CI schema job 提供 PostgreSQL 16 |
| capability、claim 重绑、offer 完整性 | [daemon offers](../../tests/unit/multiremi/daemon-task-offers.test.ts) |
| 指令文件采用与驻留进程配置替换 | [后台集成](../../tests/integration/multiremi-daemon-background-tasks.test.ts)；脚本化 ACP，不证明外部模型服从性 |
| 八个 CLI 命令的 HTTP/输出与 task deny | [CLI](../../tests/unit/remi/cli-workspace-system-prompt.test.ts)；回环 HTTP fixture，不替代领域 API 测试 |
