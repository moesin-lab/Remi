# 自用实例部署（stable profile）

适用于用 `scripts/local-profile.mjs` 部署的本机 stable 实例：API / Web 在 Compose 项目 `remi-stable` 中运行，daemon 是 systemd user unit `multiremi-daemon.service`，以 drop-in 覆盖 `ExecStart` 指向某个 release 目录里的二进制。部署前确认用户已授权「拉最新代码重新部署」。

## 1. 平台（API / Web）

1. `git fetch origin`，取 `origin/main` 的**完整 40 位 SHA**（脚本只接受完整提交；手敲容易出错，用 `git rev-parse` 取）。
2. 主机能直接访问外网时：

   ```bash
   node scripts/local-profile.mjs stable deploy --ref <full-sha> --build-local true
   ```

3. 主机只能通过本地代理出网时（Docker 构建容器连不上 GitHub，API 镜像下载 lark-cli 会失败），先手工构建镜像，再让脚本复用：

   ```bash
   S=~/.remi/profiles/stable/releases/<full-sha>   # 第一次运行 deploy 会建好这个快照目录；失败也会保留
   docker build --network host \
     --build-arg HTTP_PROXY=<proxy> --build-arg HTTPS_PROXY=<proxy> --build-arg NO_PROXY=<no-proxy> \
     --build-arg MULTIREMI_VERSION=<version> --build-arg REMI_APPLICATION_BASE_REF=<full-sha> \
     --label org.opencontainers.image.revision=<full-sha> \
     -f $S/deploy/docker/Dockerfile.api -t remi-api:stable-<full-sha> $S
   # Web 同理：--target runtime，另加 REMOTE_API_URL、REMI_APP_VERSION、NEXT_BUILD_CPUS、
   # NEXT_PUBLIC_SITE_URL、NEXT_PUBLIC_LOCAL_PROFILE、NEXT_PUBLIC_WS_URL，取值见 profile 的 compose.env 与 compose.yml
   ```

   `<version>` 取 `~/.remi/profiles/stable/deployment.json` 的 `version`。脚本会检查镜像的 revision label，不匹配会拒绝覆盖。构建完再运行第 2 步的命令。
4. 当前用户不在 docker 组时，用一个只转发到 `sudo -n docker` 的包装脚本放到 `PATH` 前面再运行部署脚本。
5. 脚本先构建镜像、再停旧服务、备份（`Backup: …` 行给出目录）、启动新服务。检查：

   ```bash
   jq '{ref,version}' ~/.remi/profiles/stable/active.json
   curl -s http://<host>:16120/readyz     # {"ok":true}
   curl -s -o /dev/null -w '%{http_code}' http://<host>:13000/login   # 200
   ```

## 2. daemon

1. 在独立 worktree 检出同一提交，安装依赖并编译：

   ```bash
   npm exec --yes --package=bun@1.3.14 -- bun install --registry https://registry.npmjs.org --frozen-lockfile
   npm exec --yes --package=bun@1.3.14 -- bun build apps/remi/main.ts --compile --minify \
     --target bun-linux-x64 --define 'MULTIREMI_VERSION="<pkg-version>+main.<short-sha>"' --outfile out/remi
   out/remi --version
   ```

2. 安装到 `~/.remi/profiles/stable/releases/<full-sha>/daemon-bin/remi`，新增一个编号更大的 drop-in（例如 `95-main-<short-sha>.conf`），内容为清空并重设 `ExecStart=<那个路径> daemon start --foreground`，然后 `systemctl --user daemon-reload`。
3. 重启前看 `remi daemon status` 的 `Active tasks`。等空闲最多约 20 分钟；任务持续进来时直接 `systemctl --user restart multiremi-daemon.service`（systemd 约 90 秒后强杀）。
4. 重启后确认每条 lane 的 `Version` 都是新版本；用 `remi turn list --status running` 记下重启前在跑的轮次，重启后它们会以 `agent_error.unknown` 失败且**不会自动重试**，逐个 `remi turn retry <turn> --yes`（已经有新轮次在跑的会话会报 already has an active run，可以忽略）。

## 3. 验证

- 平台：readyz、Web 登录页、`active.json` 的 ref。
- daemon：`remi daemon status` 版本一致、`Outbox` 没有积压。
- 真实轮次：挑一个之前出问题的会话或一张简单的单，看新轮次正常结束（`remi turn list --issue <KEY>`），失败就读 `remi turn trace read <turn> --json` 的 `.turn.error`。
- 回滚：平台用部署脚本自己的 rollback 子命令和备份目录；daemon 把 drop-in 删掉或改回上一个 release 后 `daemon-reload` 并重启。恢复数据库要先问用户。
