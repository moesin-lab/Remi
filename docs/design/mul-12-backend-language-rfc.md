# MUL-12 后端语言与迁移路线（待决 RFC）

**建议本轮保留 Bun/TypeScript 控制面，先批准基线测量和跨进程契约整理。** 全量重写将同时替换持久化、鉴权、调度与运行时适配，现有证据不足以支持这个投入。如果优化后仍有明确的传输瓶颈，且 MUL-10 确认了独立进程边界，再单独批准 Go 试点。Rust 保留为有硬内存预算或 CPU 剖析证据时的候选。MUL-10、MUL-11 和本提案均需各自决策。本文不授权实施。

## 规模与核算边界

源码快照 `d69bc1d46e35c7650a0164caef1f3be379d6ff98`。物理行包含空行、注释及末尾无换行的一行。按已跟踪的实现语言文件统计。服务包 **406 文件 / 165,055 行**；加入其他包和应用入口（含用户 CLI 与共享契约）为 **750 / 253,836**。后者是兼容性调查范围，不能当作必须翻译的工作量。

| 包 | 文件 | 物理行 | 职责 |
|---|---:|---:|---|
| server | 406 | 165055 | API、store、后台业务、实时服务与 SCM |
| daemon | 75 | 23033 | 调度、agent runtime、外部聊天 |
| contracts | 50 | 14884 | 多端共用类型与协议 |
| acp | 33 | 9268 | provider 启动、适配、版本与计量 |
| connectors | 40 | 8333 | 飞书收发、卡片、流式呈现 |
| shared | 39 | 8012 | 共享实现 |
| platform-updater | 24 | 4353 | 更新与恢复 |
| remi | 6 | 1282 | 核心库 |
| edge | 4 | 856 | 代理与控制 |
| auth | 7 | 819 | 登录、凭据持久化与同步 |
| plugin-sdk | 1 | 147 | 扩展接口 |
| apps/remi | 59 | 17507 | CLI 入口及命令 |
| apps/platform-updater、server、edge | 3 / 2 / 1 | 216 / 56 / 15 | 应用入口 |

测试树单列 **1,184 / 331,600**，含 unit 892 / 272,384、integration 110 / 31,790、arch 30 / 4,527，其余为 manual、fixtures、helpers、setup。整树含跨端验证，不等于后端自动化覆盖率。排除前端、部署、脚本、文档、二进制、非下列后缀、声明及 `-generated.ts`（含 CLI 能力映射）；JSON 模板、运行时清单、SQL 等仍要作兼容审查。仓库根目录可直接按 Git 对象复算，不依赖当前分支内容：

```python
import collections, pathlib, subprocess
rev = 'd69bc1d46e35c7650a0164caef1f3be379d6ff98'
tree = subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', rev, '--', 'apps', 'packages', 'tests'])
groups = collections.Counter()
lines = collections.Counter()
for name in tree.decode().splitlines():
    path = pathlib.PurePosixPath(name)
    if path.suffix not in {'.ts', '.tsx', '.js', '.mjs', '.cjs'} or name.endswith(('.d.ts', '-generated.ts')):
        continue
    data = subprocess.check_output(['git', 'show', f'{rev}:{name}'])
    group = '/'.join(path.parts[:2])
    groups[group] += 1
    lines[group] += data.count(b'\n') + int(bool(data) and not data.endswith(b'\n'))
for group in sorted(groups):
    print(group, groups[group], lines[group])
```

## 哪些成本可能随语言改变

| 路径与核对位置（仓库根相对路径） | 当前约束及其选型含义 |
|---|---|
| `packages/server/src/store/db/{sqlite,postgres,pg-worker}.ts`、`store/repos/`、`store/request-read-cache.ts`（后两处位于 `packages/server/src/`） | 自有 SQL 仓储与事务包装；SQLite 使用 `bun:sqlite`，PG 调用端在 `postgres.ts:441` 同步等待，worker 在 `pg-worker.ts:43` 限每桥一连接。批读、缩短事务、消除重复查询可在现栈做。改异步需追踪事务上下文及提交后通知。换语言本身不能增加 SQLite 写并行度。 |
| `packages/server/src/api/{hub,peer,realtime-fanout.ts}`、`packages/contracts/src/{live-hub,peer-events}.ts` | 浏览器副本需要授权、补读、背压和重连。现有 peer 是共享数据库进程间的批量通知；重发同一批次、按 epoch/seq 去重，接收方重启可再次投递。扩为独立节点需重新证明引用事件能补读、租约和恢复语义。 |
| `packages/server/src/api/helpers/{jwt,auth-guards,workspace-context}.ts`、`packages/auth/src/` | API 区分 JWT、access token、daemon 身份与工作区作用域。外置传输不能凭连接成功继承用户权限；需覆盖过期、撤权、跨工作区拒绝。 |
| `packages/server/src/scm/{github,codebase,poller,webhook,reconcile}.ts`、`packages/connectors/src/feishu/` | 仓库轮询与 webhook、飞书回调与出站卡片都有外部时延或重复交付。重试、去重、密钥和供应商行为需保留。换 HTTP 库不会消除配额或回调乱序。 |
| `packages/server/src/api/daemon-protocol/`、`packages/server/src/worker/outbox.ts`、`packages/daemon/src/agent-runtime/` | 握手区分权限和升级失败；offer、领取、断线补发与 trace 影响实际执行次数。先用旧 daemon 验证协议，再讨论所有权转移。 |
| `packages/acp/src/{adapters,provision.ts,runtime-versions.json}`、`scripts/build-multiremi.ts:27` | Claude/Codex 有各自版本化的 ACP、SDK、可执行程序，另有 Grok 与 Antigravity 路径。现行发布已覆盖 Linux/macOS 各两种架构，归档包含 remi、Claude 桥、运行时清单。原生 Hub 可独立分发；完整执行环境还需 provider、凭据、工作区工具，替换语言不能省掉供应链验证。 |

[已有 PG 调查](../../reports/performance/MUL-204/decisions-postgres.md)在 `902d5109` 基线记录了 52 个历史决策夹具的重复查询；局部测试调整后，带剖析基线 20,583.33 ms，对照三次中位 2,976.90 ms。该证据只覆盖隔离 PG 测试，不能推出线上 API 加速比。当前 SHA 的并发连接容量、RSS、事件循环滞后、GC 占比、端到端 p95/p99、安装体积与构建时间均未在本单实测。采集入口见[性能调查](../dev/performance.md)。若慢在 SQL/外部 provider，先减少往返；若 CPU profile 集中于序列化或高并发连接管理，才有理由对照原生实现。

## 四条路线与预算

以下为立项预算区间（人周，非实测速率）。假设一名熟悉现栈的开发、一名目标语言开发，另有可用的独立 QA/运维；允许维持现有 provider 桥，保留两种 DB 及现行客户。估算按切片加总，评审、故障演练计入；跨团队等待、长期双栈值守另算。缺少同团队历史迁移样本，全量预算只宜作量级筛选。

| 方案 | 适用条件、成本与约束 | 人周估算依据 |
|---|---|---|
| 全量 Go | goroutine、标准网络库和部署工具适合长连接；类型与取消传播可显式化。需验证 DB 驱动、SQLite 链接及跨编译、流取消、SDK 桥；GC 与排队仍须量测。只有长期维护人选、原生分发需求及多个域持续超预算时才重估。 | 控制面/DB 18–32，协议/daemon 12–22，集成/发布 8–16，兼容/切换 10–20：48–90 |
| 全量 Rust | 所有权检查和资源释放适合有硬内存上限的常驻进程；异步任务取消、跨 await 生命周期与阻塞 DB 边界增加实现和审阅成本。需为异步运行时、TLS/SQLite 链接及每个目标构建验收，外部进程仍需监管。 | 同四块分别 22–40、16–30、10–20、12–24：60–114 |
| 渐进混合 | 保留 TS API/事务和 provider 适配；选择一个无业务写入的传输切片。可按进程退回，代价是跨进程认证、序列化、版本矩阵与两套值守。试点结果只适用于该切片。 | 契约/基线 2–4，单一 Go 切片 2–4，重放/混版/演练 2–4：6–12；扩域另估 |
| 现栈优化（推荐起点） | 保留共享类型与发布节奏；先用 SQL 次数、同步等待和慢消费者定位，再选择一项修复。无法满足强制原生运行时或极低常驻内存的需求时重新评估。 | 契约/基线 2–4，定位后单项修复与回归 1–4：3–8 |

AI coding 预算应计入人审和返工。建议用同一协议任务、冻结 fixtures 和隐藏故障用例，记录首个绿构建耗时、编译轮数、人工审阅分钟、遗漏的兼容/竞态缺陷；同条件至少重复三次。Go 的代码简洁或 Rust 的编译器诊断都不能证明 Agent 在此仓库更快。没有经过该对照的能力评分不进入立项依据。

## 顺序、兼容与退出条件

1. **先确认需求和基线（MUL-12）。** 由实施在隔离环境固定提交、DB 快照、硬件、provider 模拟延迟；录制空闲、稳态、突发重连、慢订阅四组负载。分别量 API p99、帧积压、重连补齐时间、每连接 RSS 增量、CPU、SQL 次数，区分 transport、store 与 provider 等待。每组预热后至少五次，报告中位和波动区间。用户先选首要预算及支持目标；能在现栈满足预算即停止迁移。
2. **与 MUL-10 确定通信边界，同时供 MUL-11 审阅。** 把现有 daemon v2、Live Hub、peer 流与拟议 Hub → daemon → link 拓扑分别画出责任表，逐消息定义版本协商、鉴权、顺序范围、持久化/重放所有者、重复/超限/缺口、降级；先冻结与语言无关的 wire fixtures。现有 peer 不能直接承诺跨库联邦。MUL-11 基于相同 envelope 定义扩展 capability、权限、超时、故障隔离与版本协商；进程外插件只经宿主命令请求副作用。仅先交付已承诺的现栈修复、安全、兼容、公共契约和验收夹具；暂停新进程内插件 ABI、第二套调度器或永久绑定 Bun 对象的接口。两案落点有变即重估切片。
3. **只在获批后做无写入 Go 试点。** 取一个只读订阅转发路径，原服务继续鉴权并持有存储与游标；匿名化流量重放至隔离 sink，按订阅序号对照正常、断线、超限和慢消费者。统一协议与等价背压配置，同台对比已优化 TS。建议门槛为必测语义差异 0、越权/重复副作用 0，五轮主指标中位改善至少 20% 且超出基线波动，次指标 p99/RSS 劣化均不超过 5%；用户可预先替换为业务 SLO。未达到即下线试点。若硬内存预算仍未达且剖析支持，再批准同样范围的 Rust 对照。
4. **按消费者与事务验证。** HTTP 固定状态码、错误体、分页、空值、ID/时间格式；用旧/新 CLI 验命令、退出码和 JSON，核对 `cli-capabilities.json`；以旧/新前端回放列表、订阅、授权撤回与 resync。daemon 新旧两端交叉握手，覆盖拒绝、升级、重连、重复 offer、ack 丢失、trace gap、取消和重启。DB 用 SQLite WAL 与真实 PG 跑历史快照、并发领取、事务回滚、提交后通知、schema level 兼容及重启恢复。测试旧端的 golden、真实 provider 冒烟及发行平台安装，结果逐格归档；类型检查通过仅是其中一项。
5. **灰度与回退。** 先镜像到丢弃输出的观察者，禁止派活、外发 IM 或写业务库；再以白名单 workspace 固定分流，一次一个 owner。涉及写域时，必须先排空旧 owner、持久化 checkpoint、隔离旧写者并验证 fencing，再让新 owner 获取租约；业务变更与 outbox 在同一事务，以稳定幂等键投递。影子不双写。按 1 个内部工作区、小批、全量分阶段，每阶段覆盖一次峰值与重连演练。任一越权、状态分歧、重复副作用或 SLO 超预算即停止放量。切回先停新入口、排空或重放未确认事件、交还租约、恢复旧路由并对账。仅 expand 兼容变更可在线回退，contract 等旧版本退出并完成备份恢复演练后另行批准。演练不通过，保留旧实现及读写所有权。

## 请用户拍板

- 当前首要目标是哪一项（自举迭代速度、内存上限、长连接容量、原生分发）？请指定目标平台、业务 SLO 和可接受的回退时间；若优先迭代，建议只批准第一阶段。
- 是否接受 TS 长期持有控制面和 provider 桥、按 MUL-10/11 契约演进？若要求完整离线单文件安装，应另立 provider 许可、下载和外部工具清单后重估。
- 是否预留 2–4 人周做共同基线，以及达标失败后单独申请 Go 试点？是否接受上述量化门槛、独立 QA 和双栈值守成本？预算未确认前维持现栈。
- 是否允许独立工作区灰度、保留旧版本一段兼容窗口，并指定 DB/协议 owner 和回退负责人？未明确 owner 或确需不可逆迁移时停在影子验证。
