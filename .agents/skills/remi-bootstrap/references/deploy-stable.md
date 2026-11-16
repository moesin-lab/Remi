# 自用实例部署（stable profile）

适用条件：Linux 主机；用 `scripts/local-profile.mjs` 以本地构建（`--build-local true`）方式部署的本机 stable 实例，未接入应用更新模式（profile 里没有 `compose.application.json`）。API / Web 在 Compose 项目 `remi-stable` 中运行；daemon 是 systemd user unit `multiremi-daemon.service`，用 drop-in 覆盖 `ExecStart`，指向某个 release 目录里的二进制。其他部署方式不要照搬本页。

下文 `<profile-root>` 指 stable profile 目录（默认 `~/.remi/profiles/stable`），`<target>` 指 daemon 编译目标（例如 `bun-linux-x64`），按实际主机替换。部署前确认用户已授权「拉最新代码重新部署」。

## 1. 平台（API / Web）

1. `git fetch origin`，取 `origin/main` 的**完整 40 位 SHA**（脚本只接受完整提交；手敲容易出错，用 `git rev-parse` 取）。
   **从目标提交的检出目录运行部署脚本**（例如 `git worktree add --detach <dir> <full-sha>`），不要在别的分支的工作区里跑：脚本本身也会随版本变化，旧脚本可能缺少新提交需要的能力。
2. 主机能直接访问外网时：

   ```bash
   node scripts/local-profile.mjs stable deploy --ref <full-sha> --build-local true
   ```

3. 主机只能通过本地代理出网时（Docker 构建容器连不上外网，API 镜像下载 lark-cli 会失败），在运行部署脚本的进程里设置代理变量。脚本把 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` 及小写形式按变量名传给构建；代理地址是回环地址时，Linux 上自动使用 `build.network: host`（可用 `REMI_BUILD_NETWORK=host|default|none` 覆盖）。代理值不会写进 profile、备份或日志。

   ```bash
   export HTTP_PROXY=http://127.0.0.1:<port> HTTPS_PROXY=http://127.0.0.1:<port> NO_PROXY=localhost,127.0.0.1,::1,<内网段>
   node scripts/local-profile.mjs stable deploy --ref <full-sha> --build-local true
   ```

4. 当前用户不在 docker 组时，用一个转发到 `sudo -n docker` 的包装脚本放到 `PATH` 前面。`sudo` 默认会丢掉环境变量，包装脚本必须用 `--preserve-env=HTTP_PROXY,HTTPS_PROXY,NO_PROXY,http_proxy,https_proxy,no_proxy,REMI_BUILD_NETWORK` 保留它们，否则 Compose 拿不到代理、构建照样失败。
5. 脚本先构建镜像、再停旧服务、备份（`Backup: …` 行给出目录）、启动新服务。检查：

   ```bash
   jq '{ref,version}' <profile-root>/active.json
   curl -s http://<host>:16120/readyz     # {"ok":true}
   curl -s -o /dev/null -w '%{http_code}' http://<host>:13000/login   # 200
   ```

## 2. daemon

1. 在独立 worktree 检出同一提交，安装依赖并编译：

   ```bash
   npm exec --yes --package=bun@1.3.14 -- bun install --registry https://registry.npmjs.org --frozen-lockfile
   npm exec --yes --package=bun@1.3.14 -- bun build apps/remi/main.ts --compile --minify \
     --target <target> --define 'MULTIREMI_VERSION="<pkg-version>+main.<short-sha>"' --outfile out/remi
   out/remi --version
   ```

2. 安装到 `<profile-root>/releases/<full-sha>/daemon-bin/remi`，新增一个编号更大的 drop-in（例如 `95-main-<short-sha>.conf`），内容为清空并重设 `ExecStart=<那个路径> daemon start --foreground`，然后 `systemctl --user daemon-reload`。
3. 重启前看 `remi daemon status` 的 `Active tasks`。等空闲最多约 20 分钟；任务持续进来时直接 `systemctl --user restart multiremi-daemon.service`（systemd 约 90 秒后强杀）。
4. 重启后确认每条 lane 的 `Version` 都是新版本；用 `remi turn list --status running` 记下重启前在跑的轮次，重启后它们会以 `agent_error.unknown` 失败且**不会自动重试**，逐个 `remi turn retry <turn> --yes`（已经有新轮次在跑的会话会报 already has an active run，可以忽略）。

## 3. 验证

- 平台：readyz、Web 登录页、`active.json` 的 ref。
- daemon：`remi daemon status` 版本一致、`Outbox` 没有积压。
- 真实轮次：挑一个之前出问题的会话或一张简单的单，看新轮次正常结束（`remi turn list --issue <KEY>`），失败就读 `remi turn trace read <turn> --json` 的 `.turn.error`。
- 回滚：
  - `stable deploy` 自身不会自动回滚。新服务启动失败时，它只打印恢复提示，并保留备份目录（`Backup: …`）。
  - 平台代码回退用 host 回滚的两步：`node scripts/local-profile.mjs stable host-rollback-stage --operation-id <新的操作 ID> --ref <要回到的完整提交> --preserve-data true`，然后 `host-rollback-activate --operation-id <同一个 ID>`。`--preserve-data true` 只换代码、保留数据，要求两个版本的数据 schema 指纹一致，不一致时脚本会拒绝。
  - 不加 `--preserve-data true` 时，activate 会重建数据库并恢复备份快照，更新之后写入的数据会丢失。这属于恢复数据库，必须先停下来问用户。
  - daemon：删掉新加的 drop-in（或改回上一个 release 的路径），`systemctl --user daemon-reload` 后重启。
