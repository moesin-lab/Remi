# 常见问题

每条写现象、原因和处理。遇到新的就补进来，并给对应缺陷建单。

| 现象 | 原因 | 处理 |
|---|---|---|
| 新建的单没人开工 | 用 `--no-project-defaults` 建成了未指派 | 要开工的单不加该参数或显式指派；只做规划的单才留在 backlog |
| 一个会话里之后的轮次全部以 `question_consumer_mismatch` 失败 | 通过问题接口回答了 detached 问题（MUL-40，修复前的版本） | 部署含修复的版本；修复前改为直接发消息说明决定 |
| 轮次以 `input_gap` 失败、原因显示 `agent_error.unknown` | 轮次运行中同会话到达新消息时的输入回执校验（MUL-40） | 同上；修复后失败原因会显示为平台输入校验 |
| 协调单每次子单状态变化都唤起必然失败的轮 | 协调会话被上一条问题拖坏 | 暂时取消指派协调单，修复部署后再指派回来 |
| 改了迁移相关代码，打包或 updater 报指纹未知 | 新的迁移依赖没有加入 `packages/platform-updater/src/data-schema-inputs.json` | 补清单；指纹在打包时计算，源码 PR 不提交指纹 |
| `api-route-snapshot.test.ts` 报某行与 golden 不同 | 改了 API 默认值或路由，没重新生成 golden | `bun run scripts/snapshot-api-routes.ts` 后 `--check` |
| Agent 说「已完成」但 PR 还没合，或 CI 是红的 | Agent 看不到 CI，也可能把单子提前置 done | 以合入提交和 CI 为准；必要时重开单子 |
| 平台部署构建 API 镜像失败，下载 lark-cli 报错 | Docker 构建容器没有外网 | 见部署说明的代理构建方式 |
| daemon 一直等不到空闲 | 新任务持续进来 | 用 `remi daemon drain` 先停止接单再等在跑的任务结束；重启后记得 `undrain` |
| 重启后 daemon 不接任务 | 排空状态跨重启保留 | `remi daemon undrain --daemon-id <id>` |
| daemon 重启后个别轮次以 `runtime_recovery` 结束 | 多数中断轮次会自动换新尝试（MUL-45），少数不会 | 重启前后对照在跑的轮次，没续上的 `remi turn retry <turn> --yes` |
| 附件上传报 `EACCES … /srv/multiremi/uploads/local` | 线上 API 的上传目录权限 | Agent 改为把证据写进消息或 PR 描述；建单修复 |
| `remi … --json \| jq` 报 Unfinished JSON | 大输出在管道里被截断 | 先重定向到文件再读 |
| 脚本里的 `remi` 连到了别的服务器 | 交互 shell 的 `remi` 是带 `MULTIREMI_CONFIG` 的函数 | 脚本里显式 export 该变量 |
| Agent 的提交改了 `.github/workflows/`，推送被拒 | Agent 的令牌没有 `workflow` 权限（有意保留） | 维护者核对 workflow 改动（权限、令牌用途、触发条件）后用自己的凭据推送原提交，在 PR 描述里注明；不要给 Agent 扩权 |
| 中断的会话恢复后要确认真的好了 | 修复部署后旧会话可能仍有残留状态 | 看修复后该会话的第一个新轮次是否 completed，确认后再关闭缺陷单 |
| 设了代理变量，部署时镜像构建仍然下载失败 | docker 经 `sudo` 调用，环境变量被丢掉 | 包装脚本加 `--preserve-env=` 列出代理变量 |
| 部署脚本的新参数或新行为没有生效 | 在别的分支的工作区里运行了旧版本的 `scripts/local-profile.mjs` | 在目标提交的独立 worktree 里运行脚本 |
| Agent 说读不到 CI | 任务里 PATH 上的 `remi` 是旧版本，没有 `scm change-request checks` | 用与 daemon 同版本的 CLI |
