# CI 检查结果

## 先让负责的 Agent 自己查

平台提供只读命令，任务凭据下可用：

```bash
remi scm change-request checks <仓库 ID> <PR 编号> --output json
```

- 仓库参数目前只接受平台内部 ID（`repo_…`，`remi repo list` 可查），`owner/name` 会报找不到绑定（MUL-58）。
- 只看 JSON 输出：默认表格输出目前只有一行空值（MUL-58）。
- 先核对 `summary.headSha` 等于要验收的最终 SHA，再看各项 `status` / `conclusion`。
- 要用与 daemon 同版本的 `remi`。任务 PATH 上的旧版本 CLI 可能没有这条命令，只会打印 `remi scm` 的帮助（MUL-26）。

结论规则与合并规则相同：queued、in_progress、缺失都不算通过；runner 容量导致的取消要引用 "The job was not acquired by Runner" 注解作证据；已建单的 flaky 要写单号和日志行。检查通过不等于可以合并。

下文是协调者用 `gh` 核对或代查的方法，在 Agent 查不了（命令不可用、被限流、需要读失败日志）时使用。

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
