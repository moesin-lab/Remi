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

2. 安装到 `<profile-root>/releases/<full-sha>/daemon-bin/remi`，新增一个 drop-in，内容为清空并重设 `ExecStart=<那个路径> daemon start --foreground`，然后 `systemctl --user daemon-reload`。
   - systemd 按文件名的字典序应用 drop-in，后面的覆盖前面的。新文件名必须排在所有已有文件之后；数字前缀用到 99 之后，用 `99z-…`、`99zz-…` 之类。
   - `daemon-reload` 后用 `systemctl --user show multiremi-daemon.service -p ExecStart` 确认生效的是新路径，再重启。
   - 每次部署都叠一个 drop-in 只是过渡做法，改为稳定 launcher 由 MUL-26 跟进。
3. 重启前看 `remi daemon status` 的 `Active tasks`。等空闲最多约 20 分钟；任务持续进来时直接 `systemctl --user restart multiremi-daemon.service`（systemd 约 90 秒后强杀）。
4. 重启后确认每条 lane 的 `Version` 都是新版本。重启前先用 `remi turn list --status running` 记下在跑的轮次；重启后逐个看 `remi turn get <turn>`：大多数会自动换成新尝试继续运行（`current_attempt_id` 变了）；以 `runtime_recovery` 等原因结束的，用 `remi turn retry <turn> --yes` 重试。报 already has an active run 的，说明服务端已经续上，可以忽略。

## 3. 验证

- 平台：readyz、Web 登录页、`active.json` 的 ref。
- daemon：`remi daemon status` 版本一致、`Outbox` 没有积压。
- 真实轮次：挑一个之前出问题的会话或一张简单的单，看新轮次正常结束（`remi turn list --issue <KEY>`），失败就读 `remi turn trace read <turn> --json` 的 `.turn.error`。
- 回滚分两种情况，先判断属于哪一种：
  - **部署成功之后要退回**：新服务已启动、`active.json` 已指向新提交，事后发现问题。用 host 回滚两步：先运行 `node scripts/local-profile.mjs stable host-rollback-stage --operation-id <新的操作 ID> --ref <要回到的完整提交> --preserve-data true`，再运行 `host-rollback-activate --operation-id <同一个 ID>`。`--preserve-data true` 只换代码、保留数据；此时脚本会比较当前版本与目标版本的数据 schema 指纹，不一致就拒绝。
  - **部署过程中新服务启动失败**：`stable deploy` 不会自动回滚，只打印恢复提示，并保留备份目录（`Backup: …`）。新 API 可能已经执行了迁移，但 `active.json` 还指向旧提交，脚本的指纹比较会变成「旧版本对旧版本」，检查形同虚设。这种情况不要直接用 `--preserve-data true` 退回：先用 `node scripts/platform-data-schema.mjs <源码目录>` 分别算出失败候选提交和目标提交的指纹，确认一致后才能保留数据退回；不一致或无法确认时，停下来请用户决定是否恢复数据库。
  - 不加 `--preserve-data true` 时，activate 会重建数据库并恢复备份快照，部署之后写入的数据会丢失。这属于恢复数据库，必须先问用户。
  - daemon：删掉新加的 drop-in（或改回上一个 release 的路径），`systemctl --user daemon-reload` 后重启。
