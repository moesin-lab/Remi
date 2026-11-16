# CI 转达

Agent 的任务环境里 `gh` 可能是同名的另一个工具，GitHub API 也会限流，所以它们通常看不到 PR 的检查结果，曾经在 CI 红的情况下把单子验收为 done。由协调者代查并转达。

## 查

```bash
gh pr checks <n> --repo <owner/repo>                       # 汇总
gh api repos/<owner/repo>/actions/jobs/<job>               # 失败的 step
gh api repos/<owner/repo>/check-runs/<job>/annotations     # 失败断言，run 未结束也能取
gh run view <run> --repo <owner/repo> --job <job> --log-failed   # 完整日志，run 结束后才有
```

## 判定失败归属

先判断失败是不是本 PR 引起的，再决定转给谁：

| 现象 | 归属 | 处理 |
|---|---|---|
| macOS 任务 cancelled，注解是 "The job was not acquired by Runner" | GitHub runner 容量 | 稍后 `gh run rerun <run> --failed`；不阻塞合并 |
| `build`（Require every applicable check）失败 | 汇总项 | 看它汇总的是哪些任务 |
| 同一检查在 `main` 当前提交上也失败 | main | 找出引入它的提交，建单或交给相关单修，不要求每个 PR 各自修 |
| 只有本 PR 失败，且失败用例与本 PR 改动相关 | 本 PR | 转给负责的 Agent，附用例名、断言、文件行号和 job 链接 |
| 只有本 PR 失败，但用例与改动无关，main 上同一任务是绿的 | 可能 flaky | 读日志确认（例如超时）后重跑；重复出现就建单 |

PR 的 CI 按策略跳过后端测试分片，CI 绿不代表后端测试通过。要求 Agent 用 Bun 实际运行相关测试并贴出命令和结果；与基线同样失败的用例列名称。

## 转

- 用 `remi message send <session> --content-file <file> --to <agent> --to-type agent`，会话 ID 从 `remi turn list --issue <KEY> --json` 取。
- 消息写：所查提交 SHA、通过 / 跳过 / 失败数、每个本 PR 失败的用例和断言、哪些失败不用处理及原因、修完后需要回复最终 SHA。
- 对方会话正在跑轮次，或只是告知无需动作时，加 `--wake inbox_only`。
- 带 `--dedupe-key`（例如 `<issue>-ci-<sha>`），避免重复唤醒。
