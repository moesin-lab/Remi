# Daemon 与 ACP / Agent SDK 配套升级

每次发版准备时查询最新稳定依赖，验证后将版本写入 [runtime-versions.json](../packages/acp/src/runtime-versions.json)，随 daemon 一起发布。机器升级 daemon 时安装该发行版的固定依赖，不运行每日检测器，不独立热切换依赖。

## 发版准备

维护者或现有夜间发版任务先执行：

```bash
git fetch origin --tags
bun run release:prepare --version <下一版本>
```

命令从公共 npm registry 的 latest 标签查询两个 ACP bridge、Claude Agent SDK、Claude Code、Codex。只接受完整稳定 SemVer，拒绝预发布、废弃版本与低于当前快照的版本。它在隔离 REMI_HOME 中安装并验证候选组合，通过后同时更新 package.json 与 runtime-versions.json；没有新依赖时也记录本次检查及目标发版版本。可加 --dry-run 完成同样验证而不修改文件。

Claude ACP 使用 @anthropic-ai/claude-agent-sdk 内的 CC 执行文件，Codex ACP 使用 @openai/codex；这条链路没有独立的 @openai/codex-sdk。通过 npm overrides 固定实际 SDK，包括桥接包的嵌套依赖。若最新 Claude SDK 携带的 CC 尚未跟上独立 CC 的 latest，真实版本验证会失败，阻止发布不一致的组合。

候选校验包含 ACP 包版本、SDK 包版本、实际执行文件 --version、Codex usage 补丁、Claude wrapper 健康检查及 ACP initialize 协商。任何步骤失败都不改发版文件；此时应处理兼容性问题或等待上游版本对齐，再重新准备。准备命令不创建提交、tag 或 Release，也不重启机器上的 daemon，不创建 Task、不向模型发 prompt。

依赖与版本号同批提交，完整 Release build check 通过后才打 tag。CI 对版本号变更检查对应依赖快照，并在 Linux/macOS 安装固定组合、验证初始化。tag 工作流在发布 CLI 前检查版本一致性、快照和同一 main 提交的完整 CI 成功记录。构建时不再解析 latest，所以检查后上游继续发新版本也不会改变本次发行内容。

依赖升级不新增发版定时器；夜间发版任务使用同一准备入口。上线机器的依赖更新频率跟随 daemon 发版和升级频率。

## 安装与启用

平台的 CLI 升级请求沿用现有排空/暂停接单流程。`remi update` 从
`MULTIREMI_RELEASE_REPO`（兼容回退为 `MULTIREMI_REPO`，默认
`Grassgod/Remi`）读取 GitHub Release。它按当前 OS/架构精确选择
`remi-<version>-<os>-<arch>.tar.gz`，核对 GitHub 资产的 SHA-256 digest、
归档路径和新二进制 `--version`，再由新包的 `remi runtime prepare` 安装并
验证该版本的固定依赖。任一步失败都不会改写现有 executable。

验证成功后，新包进入 `~/.local/lib/remi/versions/<digest-prefix>/`，旧快照
保留。稳定 launcher 仅原子替换其中的版本目标，并将原内容保存为新快照的
`previous-launcher`；已有自定义参数改写仍保留。macOS launchd 如果直接指向
旧快照，会改为指向稳定 launcher，同时保存 `previous-launchd.plist`。
updater 不停止或重启 daemon；维护者仍需在已排空且明确批准的维护窗口中执行
`remi restart`。安装脚本的首次安装路径同样先运行 runtime prepare，再替换
`remi` 与配套 Claude wrapper。

daemon 由 systemd 托管时，重启交给 `systemctl --user restart --no-block <unit>`，由 systemd 重建整个 unit cgroup，只留一个新进程；launchd 托管时使用 `launchctl kickstart -k`。unit 名只从 /proc/self/cgroup 的 `0::` 或 `name=systemd` 行取，cgroup v1 主机上其它控制器行只到 `user@<uid>.service`（见 [apps/remi/cli/multiremi/service.ts](../apps/remi/cli/multiremi/service.ts)）。管理器调用失败或进程不受管理器托管时才退回 spawn 后继进程。修复前的版本在 cgroup v1 主机上总是退回 spawn，旧进程留在 unit 里；这样启动的新进程在接管工作区和接单前自检，以下条件全部满足时请求一次 unit 重启：自己不是 unit 的 MainPID；MainPID 是前台 daemon；从自己往上直到 MainPID 的每一级父进程都是前台 daemon，也就是由 spawn 回退逐代拉起；同一 HOME 下没有其它 daemon 持有工作区 supervisor 租约。任务进程同样在 unit 里并继承 INVOCATION_ID，任务里起的 daemon 与 unit 的 daemon 之间隔着 shell 或 agent 运行时，因此无论它换了 HOME、状态目录还是端口，都只记日志、不重启。租约仍被占用说明有 daemon 可能在跑任务，同样只记日志。

每个 provider 安装到 ${REMI_HOME:-~/.remi}/acp/bundles/<provider>-<bridge>-<sdk>-<executable>/，先在同级临时目录安装。预检直接运行新 bundle，不切换旧 daemon 使用的 Codex 启动链接；新 daemon 启动时才启用。旧的 ~/.remi/acp/node_modules 和全局安装保留为兼容入口。修复同一 bundle 时旧目录保留为 .previous-<timestamp>-<pid>，可人工回收。

全局 claude、codex 命令与用户登录配置不被覆盖。显式配置的自定义执行文件仍由用户管理；发行版校验针对 Remi 托管依赖。启动和 ACP 重装入口使用相同的版本与安装逻辑。仅 bridge 版本正确不代表 SDK 与实际执行文件正确。

原有 daemon 启动健康检查继续执行；安装校验不等同于登录授权、真实模型调用或重启后服务注册成功的端到端验收。旧发布包不含 runtime-bundle.json，安装脚本仍兼容旧版本安装；旧 daemon 需要升级到包含本改动的版本才会使用新依赖。

## 0.2.68 macOS arm64 临时恢复

`0.2.68-stable.9498e426` 的 updater 固定访问已不存在的
`grasscoder/remi`，并按已经退役的 `remi-v<version>-...` 文件名查找资产；
这个版本不能靠自身先取得修复。下面路径固定使用 2026-09-25 已核验的正式
`v0.2.81` arm64 资产。第一段只下载到临时目录并校验，不改 launcher、launchd
或正在运行的 daemon：

```bash
set -euo pipefail
recovery_dir="$(mktemp -d)"
curl -fsSL \
  https://github.com/Grassgod/Remi/releases/download/v0.2.81/remi-0.2.81-darwin-arm64.tar.gz \
  -o "$recovery_dir/remi.tar.gz"
printf '%s  %s\n' \
  c6611a25a51132726f99294a2c3971be6f751062bde8d9ca298d6175ea949f35 \
  "$recovery_dir/remi.tar.gz" | shasum -a 256 -c -
tar -tzf "$recovery_dir/remi.tar.gz"
tar -xzf "$recovery_dir/remi.tar.gz" -C "$recovery_dir"
file "$recovery_dir/remi"
"$recovery_dir/remi" --version
```

预期结果分别包含 `OK`、仅有 `remi` / `remi-claude-agent-acp` /
`runtime-bundle.json`、`arm64` 和 `0.2.81`。不要在承载当前任务的 daemon 上继续
执行激活。由 Remi 外部的宿主终端在排空并确认维护窗口后执行以下激活；它保留
旧快照与 launcher，而且不调用 `launchctl`、不重启 daemon：

```bash
set -euo pipefail
snapshot="$HOME/.local/lib/remi/versions/c6611a25"
launcher=/usr/local/bin/remi
mkdir -p "$snapshot"
"$recovery_dir/remi" runtime prepare
install -m 0755 "$recovery_dir/remi" "$snapshot/remi"
install -m 0755 "$recovery_dir/remi-claude-agent-acp" "$snapshot/remi-claude-agent-acp"
install -m 0644 "$recovery_dir/runtime-bundle.json" "$snapshot/runtime-bundle.json"
cp "$launcher" "$snapshot/previous-launcher"
python3 - "$snapshot/previous-launcher" "$snapshot/remi" "$snapshot/launcher" <<'PY'
import pathlib, re, sys
source, binary, output = map(pathlib.Path, sys.argv[1:])
text = source.read_text()
pattern = re.compile(r'^(\s*exec\s+)(?:"[^"]*/remi"|\x27[^\x27]*/remi\x27|\S*/remi)(.*)$', re.M)
updated, count = pattern.subn(lambda m: f"{m.group(1)}'{binary}'{m.group(2)}", text, count=1)
if count != 1:
    raise SystemExit("launcher did not contain exactly one remi exec target; no files changed")
output.write_text(updated)
PY
chmod 0755 "$snapshot/launcher"
plist="$HOME/Library/LaunchAgents/dev.remi.multiremi.daemon.plist"
if [ -f "$plist" ]; then
  cp "$plist" "$snapshot/previous-launchd.plist"
  python3 - "$plist" "$launcher" <<'PY'
import os, pathlib, plistlib, sys
path, launcher = pathlib.Path(sys.argv[1]), sys.argv[2]
with path.open("rb") as stream:
    data = plistlib.load(stream)
arguments = data.get("ProgramArguments")
if not isinstance(arguments, list) or not arguments:
    raise SystemExit("launchd plist has no ProgramArguments; no files changed")
arguments[0] = launcher
temporary = path.with_name(f".{path.name}.tmp")
with temporary.open("wb") as stream:
    plistlib.dump(data, stream)
os.replace(temporary, path)
PY
fi
install -m 0755 "$snapshot/launcher" "$launcher"
"$launcher" --version
```

上述命令只改 launchd 文件中的稳定入口，不 load、kickstart 或 restart。回滚时执行
`install -m 0755 "$snapshot/previous-launcher" /usr/local/bin/remi`；如果保存了
`previous-launchd.plist`，同时复制回原 plist。旧 `9498e426` 快照不删除。服务重启后
的注册、readiness 和 WebSocket 仍需在维护窗口单独验收。

服务端 `remi platform release version` 只读取
`MULTIREMI_RELEASE_DIR` 的本地镜像，不会隐式回退 GitHub。目录缺失或没有可识别的
release tarball 时返回 404 `release_catalog_empty`，错误会明确提示配置该目录或使用
GitHub installer。要启用管理式镜像，发布流程必须把同一版本的各架构 tarball 放入
该目录并持久挂载；这与修复客户端 GitHub 来源是两个独立动作。

## 本地准备与验证

```bash
remi runtime prepare                         # 已安装/配置的 provider
remi runtime prepare --provider claude
remi runtime prepare --provider claude --provider codex
```

命令无服务端鉴权要求，只操作当前用户的本地 Remi 依赖。隔离验证时给 REMI_HOME 指定新临时目录；源码运行可通过 REMI_CLAUDE_AGENT_ACP_EXECUTABLE 显式选择仓库内 bin/remi-claude-agent-acp。
