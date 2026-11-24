---
title: IM 平台管理
status: active
summary: 主侧栏的 IM 平台、平台能力页面、飞书连接与路由边界，以及兼容导航和验证入口。
---

# IM 平台管理

主侧栏的「IM 平台」与「工作区」「配置」是同级分组，当前仅注册飞书。
所有连接、消息和权限仍属于 URL 指定的工作区；导航分组的同级关系不改变租户边界。
入口为 `/:workspaceSlug/im`，飞书为 `/:workspaceSlug/im/feishu`。

## 概念与页面

平台类型回答「通过哪个 IM 协作」；平台内分别管理机器人连接与消息采集连接。
机器人连接把应用、回复 Agent 和承载 Runtime 关联起来；会话路由在这个连接下决定私聊、群聊及指定群的 Agent。
消息采集连接使用独立授权；消息源在连接下定义会话范围、轮询和保留策略。
机器人发送者策略与消息源会话 allowlist 是不同的权限约束。

| 飞书页面 | 路径后缀 | 管理内容 |
|---|---|---|
| 概览 | 无 | 机器人状态、连接和消息源数量、能力入口；请求失败显示错误和重试 |
| 机器人 | `/bot` | 应用凭据、扫码注册、Agent/Runtime、检测与启停、菜单、已有 Agent Bot 绑定 |
| 访问控制 | `/access` | 沿用 Agent 能力或主动启用发送者白名单，账号授权与撤销 |
| 群聊与通知 | `/conversations` | 私聊/群聊默认 Agent、指定群路由、Issue 自动话题、项目与通知对象范围 |
| 消息接入 | `/ingestion` | 全部采集连接及健康状态、应用授权、消息源增改删与会话范围 |
| 消息记录 | `/messages` | 消息搜索、URL 筛选、处理结果、收件箱通知、回复草稿与 Issue 提案 |

这一划分借鉴了 [agent-nexus 的平台适配层](https://github.com/moesin-lab/agent-nexus/blob/main/docs/dev/spec/platform-adapter.md)对平台类型、实例与能力归属的区分。
Remi 的 Agent/Runtime 绑定、Issue 话题、持久 outbox 和独立的 Messaging Core 继续由原领域实现。
一个工作区可配置多个机器人，也可有多个采集连接；两条链路不共享凭据。机器人页可新增、命名、选择和删除机器人，`?bot=<bot_id>` 在机器人、访问控制和群聊页面之间保留选择。表单和缓存同时按工作区与机器人隔离。

每个机器人使用独立飞书应用，分别保存 Agent/Runtime、路由、发送者策略、修订、运行状态和审计。当前 Runtime v1 协议只有一个 connector slot，故一个 Runtime 只能分配一个机器人（停用配置也占用这个绑定）；应用或 Runtime 重复分配返回 409。迁移保留原机器人的 `default` 标识、密文及历史记录。切换承载机、停止或删除已启用的机器人后，旧 Runtime 确认停止前，原承载机和应用都不能分配给另一个机器人。

同一 Runtime 更换应用时也先等待旧连接器确认停止，再启动新应用；连续编辑期间持续保留最初仍在运行的应用占用。停止后立即部署同样需要完成停止确认。

每个机器人独立配置一套统一菜单，不再按工作区成员、角色或外部账号编辑定向菜单。旧 Agent Bot 绑定和自动 Issue 话题设置仍由默认机器人使用，只在默认机器人的页面显示。多个企业及同一企业的多套应用可分别添加机器人；企业分组、平台实例及单 Runtime 多机器人并发尚未实现。

## 实现归属与扩展

- [平台目录](../../frontend/packages/core/im-platforms/catalog.ts)声明已支持平台和可导航的能力；只允许已注册的平台及单层页面，未知地址由 Web 返回 404。
- [路径构造器](../../frontend/packages/core/paths/paths.ts)集中生成带工作区的地址。[主侧栏分组](../../frontend/packages/views/im-platforms/sidebar-group.tsx)只读取目录，不请求平台业务数据。
- [平台页面外壳](../../frontend/packages/views/im-platforms/im-platform-page.tsx)负责面包屑、能力导航和单页挂载；飞书适配在 [feishu](../../frontend/packages/views/im-platforms/feishu)。新增平台需要声明目录并接入其实际能力组件，不能只添加占位卡片。
- 四种语言文案归属 `locales/*/im-platforms.json`。Agent 详情仍可使用飞书绑定组件，其实现归属 IM 模块。
- 查询使用工作区和机器人分区的 `feishu-bot`、`feishu`、`lark` 和 `workspace` cache key，复用原 API schema、mutation 失效与服务端权限。不引入第二套配置数据、凭据表或缓存。
- 页面切换只挂载当前能力，切换工作区会重建表单与选择。消息记录不请求连接健康；所有已登录操作者可管理当前工作区的连接、消息源及机器人配置。配置失败不会降级为空配置表单；task/daemon 凭据仍遵循对应接口的权限边界。

机器人集合使用 `GET/POST /api/workspaces/:id/feishu-bots`；已有 `/feishu-bot` 子资源通过 `?bot_id=<id>` 指定机器人，省略时仍操作原默认机器人。未知 ID 返回 404，不回退到默认配置。[CLI 命令映射](../cli-command-migration.md#im-platform-management)保留真实可执行的 `workspace`、`messaging` 与 `lark` 命令；传输行为见[飞书接入契约](../feishu-message-ingestion.md)。

## 机器人菜单

菜单读写、发布和发布状态 API 为 `/api/workspaces/:id/bot-menu` 及其子路径，全部接受 `?bot_id=<id>`；省略时选择 `default`。响应包含 `bot_id`，发布记录按工作区及机器人校验，未知机器人不会继承默认菜单。前端草稿和 Query key 同时按两种身份隔离，切换机器人丢弃未保存草稿。CLI 的四个 `workspace bot-menu` 命令使用同一个 `--bot` 选项。

默认机器人的既有 `settings.botMenu.default` 保留原位，其他机器人的菜单存于 `settings.feishuBotMenus[bot_id]`。菜单修改在工作区生命周期锁内读取并合并最新设置，避免两个机器人的并发保存互相覆盖。新写入仅支持 `default` 菜单项（空数组表示清空），非空 `users` 返回校验错误。历史 `users` 保留作为清理记录，读取响应只暴露统一菜单及 `legacy_target_count`；发布不会重新下发历史定向内容。服务端尽可能将旧成员、角色及外部账号解析为清理目标，Runtime 发布统一菜单后删除这些账号的个性化菜单。找不到身份不阻止发布，结果的 `unresolvedLegacyTargetCount` 提示需要在飞书侧确认；历史上已经丢失的账号映射无法自动还原。

发布必须由该机器人绑定且在线的 Runtime 执行，要求 `bot_menu_protocol >= 2`。请求固定机器人、应用、域名及配置修订；下发前再次核对绑定，连接器调用前校验正在运行的身份。配置变更后的排队请求失败并允许重新发布。旧 Runtime 可继续运行机器人，发布菜单前需升级 Runtime。保存和试运行均不修改飞书；真实发布才调用菜单接口，清理失败作为发布失败报告。旧发布请求仍可读取，但新连接器拒绝没有身份范围的旧请求。

## 旧地址

[Settings 路由](../../frontend/apps/web/app/%5BworkspaceSlug%5D/%28dashboard%29/settings/page.tsx)在渲染前重定向：

- `?tab=integrations` 和 `?tab=lark` → `im/feishu/bot`。
- `?tab=feishu-messages` → `im/feishu/messages`。

迁移保留工作区和其他查询参数，消息深链筛选仍有效。设置页不保留重复的编辑入口。
收件箱中的连接故障操作直接进入消息接入页；其他设置地址不受上述匹配影响。

## 验证入口

`bun run smoke:im` 使用独立 Next、真实 HTTP API 和临时 SQLite，通过 Chromium 验证侧栏、各页面保存、复数机器人新增/切换/删除与权限隔离、独立菜单保存/刷新/试运行与草稿切换、凭据保留、URL/刷新、工作区数据隔离、不同登录账号共享配置、错误重试及移动端。
飞书外部传输由测试 Provider 模拟，不读取个人配置、不启动 Agent、不发送真实飞书消息；因此它不证明真实飞书授权或出站投递。
输出目录包含检查结果 JSON 与桌面/移动截图。端口可通过 `--port=3331` 指定，浏览器可用 `CHROME_EXECUTABLE` 指定，结果目录可用 `IM_SMOKE_ARTIFACTS` 指定。浏览器 worker 使用 Node.js 22.6+，API 使用固定版本 Bun，避免 Windows 的 Bun 浏览器传输兼容性问题。
`release-build-check.yml` 的 `im-platform-smoke` job 运行同一命令并上传结果，飞书模拟边界与本地相同。

平台目录及路径测试在 [core/im-platforms](../../frontend/packages/core/im-platforms)；页面、迁移后的交互回归和按页查询测试在 [views/im-platforms](../../frontend/packages/views/im-platforms)。运行方式和 CI 覆盖见 [TESTING.md](../../TESTING.md)。

机器人与话题表单不要求人类责任人。符合发送者授权和提案策略的群消息可直接建单；事项按执行 Agent 与父子关系完成交付验收，详见 [事项责任](issue-responsibility.md)。旧可选联系人字段仅保留兼容与审计。
