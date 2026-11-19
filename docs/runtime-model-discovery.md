# Runtime Model Capabilities

## Central Capability Groups

Execution groups choose a shared gateway endpoint or explicit local sign-in. Endpoints
store addresses, supported API protocols and credentials; default models and allowlists
belong to groups. See [execution configuration](dev/execution-configuration.md).

Each Runtime probes the selected connection after applying its binding. Codex uses
OpenAI Responses-compatible model inventory; Claude uses `/v1/models` with its selected
authentication header; Antigravity uses Google `/v1beta/models`. Per-protocol base paths
are resolved before discovery. A local-sign-in probe has a separate group home and
explicitly clears workspace gateway routing.

The report travels in `runtime.binding_state.model_catalog`, fenced by group,
Runtime, generation and endpoint revision. Configuration readiness, catalog readiness
and online status are separate. A group's catalog is the intersection of its members'
current reports, filtered by that group's model policy. New endpoint-backed groups do
not fabricate a model from a manually entered default or inherit global gateway models.
The selected model and connection are frozen on first claim. Unknown/failed catalogs
block new tasks until a usable catalog is reported.

When a Codex endpoint includes complete native `models` metadata, discovery validates
it with the actual Codex decoder. An ordinary `data` array does not imply reasoning
support. The display-only legacy workspace overlay described below remains for older
clients and unconverted connections; it does not override explicit endpoint groups.

## Context Window Declarations

Claude gateway models have a separate administrator-controlled 1M context switch
in The legacy Relay API, defaulting off. The declaration is stored independently
of discovery snapshots and reasoning levels, so a probe cannot erase it. The
reasoning-level listing includes each model's `context_window` and retains
context-only rows when an inventory entry disappears. The write command is
`remi workspace relay context-window update claude --model <id> --one-million`
(or `--clear`). It neither invents reasoning metadata nor changes model
executability. Configuration follows the daemon relay wire; Runtime-specific
Claude profiles are outside its scope. Selection and rollout are documented in
[Claude Context Windows](claude-context-window.md).

For workspace Codex relays, two gateway endpoints serve different purposes:
`<base_url>/models` supplies available IDs and labels, while
`<origin>/backend-api/codex/models` supplies the native model catalog, including
per-model reasoning options and defaults. The server stores only the compact
capability snapshot. Codex entries explicitly hidden or unsupported by the API
are excluded from the selectable inventory. It retains the existing public-host check, response size
limit, timeout and configuration-revision fence.

The daemon separately downloads the complete native catalog into its isolated
probe/session `CODEX_HOME/model-catalog.json` with mode 0600. It injects the
absolute `model_catalog_json` path at the top level of `config.toml`. Provider
fragments and inherited host settings cannot supply this path. On download or
write failure the pointer is omitted, Codex uses its bundled catalog, and the
failure is reported in task progress and model capabilities. Custom Runtime
connections retain their own ACP capability discovery; they are not assumed to
implement the workspace relay's Codex endpoint.

Codex app-server reads this file at startup. ACP exposes its model capabilities
through the `thought_level` selector; Remi probes each model and reports the
supported values and the model default. On bridges supporting recommended config
values, that metadata is authoritative: model switches can otherwise retain a
previous effort, so `currentValue` is not always the model default. User settings
are not changed by this independent probe. Before a real Codex prompt, unavailable
explicit models and unacknowledged model/effort changes produce an error; the
Codex bridge cannot silently keep a different model or effort. Claude keeps its
existing SDK model alias and 1M context negotiation.
The startup override follows the [official Codex configuration mechanism](https://developers.openai.com/zh-Hans/docs/config-file/config-advanced).

`GET /api/models` and `remi runtime model catalog --agent <agent-id> --json`
return `thinking.supported_levels`, `thinking.default_level`, and
`thinking.status` (`supported`, `unsupported`, `unknown`, or `error`). An empty
explicit declaration means unsupported; absent metadata means unknown; malformed
metadata or a failed load means error. Unknown/error states never make stale
levels selectable. The UI displays these states separately and labels the model
default as informational: an empty saved override still follows runtime settings.

Server validation, task eligibility, and the UI use the same capability catalog.
Authoritative per-model gateway metadata takes priority over runtime declarations,
except an execution runtime's load failure blocks its levels. Missing metadata
can use an exact runtime model match; it cannot borrow another provider model's
levels. Claude retains exact-model and existing unambiguous Claude-family
capabilities, without a provider-wide guess for unrelated models.

A workspace administrator can state a gateway model's reasoning levels explicitly
(`remi workspace relay reasoning-levels update`, or
`PUT /api/workspaces/:id/relay-config/:engine/reasoning-levels`). That
declaration is a source in its own right, not a borrowed set: the gateway
inventory carries ids and labels only and the bridge publishes a selector merely
for its own aliases, so for a gateway-only alias an operator stating the levels is
the only source that can exist at all. It is stored per workspace × engine ×
model, apart from the discovery snapshot — every probe rewrites that snapshot
wholesale — so re-probing never clears it, and it joins the same priority order:
gateway metadata, runtime report, manual declaration, Claude-family consensus. It
therefore only ever fills a gap. When a higher-priority source already declares
levels the declaration is stored but not applied, and the read model
(`remi workspace relay reasoning-levels get`) reports the stored declaration and
the effective levels with their source — `gateway`, `runtime`, `manual`,
`family`, or none — so the legacy reasoning API can show a declaration that is being
outranked instead of appearing to ignore it. A declaration names one model id and
never applies to any other. An empty level set removes it rather than storing an
empty list, because an empty list would read as an authoritative *unsupported*
and re-create the permanent queueing described above. Levels are validated
server-side against the engine's enum — Claude `low`/`medium`/`high`/`xhigh`/`max`,
Codex additionally `minimal` — and an unknown spelling is rejected with a 400
rather than forwarded to execution, as are a default level outside the declared
set and a missing model id. The Antigravity engine has no enum: both
reasoning-level routes, like the Claude-only context-window route, answer 400 for
it (see [Antigravity Gateway Engine](#antigravity-gateway-engine)).

A declaration does not depend on discovery ever having succeeded — that is what
makes it a source rather than a footnote to the snapshot. It applies to any model
id the administrator names, including one the gateway inventory never listed, and
a Claude model that only a declaration describes is added to the catalog as an
entry carrying `thinking_source: manual` with the declared levels, so it appears
in the Agent model dropdown with those levels selectable and is routable on any
Claude runtime. An empty snapshot, a snapshot whose last attempt failed, a
disabled discovery toggle or a model that has since left the inventory therefore
never blocks declaring levels and never hides the declaration: the legacy reasoning API
distinguishes "not discovered" from "not declared" and accepts a manually entered
model id instead of only offering 立即探测. Executability is a separate question
from reasoning levels, and the Codex boundary (#220) is unchanged: a declaration
is stored and listed like any other, but it does not make a model selectable when
the Codex execution catalog — the native capability catalog — does not contain it.
That case is not silent. The listing reports the declaration as `state: blocked`
with a `state_code` of `not_in_execution_catalog`, or `execution_catalog_unknown`
while the native catalog is unavailable, so the operator is told the declaration
is inert and why; a model the ordinary `/models` list carries but the native
catalog omits behaves the same way. A declaration that a higher-priority source
outranks is `outranked`, and one that is actually applied is `effective`.

Task eligibility reads these four states as three different questions
(`modelThinkingState`). A model that declares levels (`supported`) must offer the
saved level, and a runtime whose capability load failed (`error`) cannot claim the
task — both remain blocking. So does an empty level list for any engine that
reports reasoning levels at all (`providerDeclaresReasoningLevels`), which is the
MUL-330 behaviour for Codex and every other ACP engine. Claude is the one
exception, because it reports no reasoning metadata anywhere: the gateway
`/v1/models` inventory carries ids and labels only and the bridge publishes the
native selector solely for its own aliases. There an empty list means the level is
not applicable rather than unavailable, so the runtime stays eligible and the
ignored level is logged once per provider/model/level. Reading it as a missing
capability instead left gateway-only Claude aliases — which the same inventory
describes with ids and labels only — unclaimable on every runtime while the same
model without a saved level was claimable, so the task queued forever. The
default is the strict reading: an engine that is in fact like Claude keeps its
Agents queued, which is visible and recoverable, where the reverse would run work
at a default effort an engine had said it could not honour.

Writes converge the other way round, only for a selection the caller did not
choose and only where no engine declaration exists. An agent carrying a stored
`thinking_level` for a level-less Claude model gets it cleared on the next update,
including a metadata-only edit or a verbatim resend of the saved selection — the
cases that previously short-circuited validation and kept the value forever,
because the stale level is usually already saved and no later edit ever mentions
it. An effort the request actively sets is still judged by validation and rejected
with a 400 when the catalog cannot confirm it, so a caller is told its request was
not honoured rather than silently getting a different Agent. Engines that do
report levels are never converged: clearing there would turn a rejected selection
into a runnable one at the default effort.

A model that declares levels from any source — including an administrator's
declaration — keeps a stored level that set contains and converges away one it
does not, on the terms above: an unusable value is not kept silently, and an
effort named in the same request as a selection change is still rejected with a
400 before that convergence could hide the mismatch.

The control plane never refreshes the snapshot while answering a read. `GET
/api/models` in all three shapes (workspace, `runtime_id`, `execution_group_id`),
the reasoning-level listing, and the CLI equivalents they mirror read only what is
already stored: the persisted gateway snapshot, the Runtime reports and the manual
declarations. A stale, empty or failed snapshot is served exactly as recorded —
no probe starts in the background, so opening the Agent page or the model gateway
settings cannot emit a gateway request and cannot overwrite an operator's snapshot
with an error nobody asked for. The snapshot changes only on an explicit action:
saving that engine's relay config, enabling the auto-discovery toggle, or pressing
立即探测 (`POST /api/workspaces/:id/relay-config/:engine/probe`), each bounded by
the same 8s wait as before. A workspace that has never probed keeps an empty
catalog until one of those runs; a workspace whose gateway has gone stale keeps
listing the models it last saw. One legacy snapshot shape cannot wait for an
explicit action — a Codex snapshot written before the native catalog became the
executable authority carries no `nativeCatalogStatus`, which reads as `unknown`
and leaves every model in it unselectable, and a read is no longer allowed to fix
it. `refreshPreNativeCodexSnapshots` re-probes exactly those workspaces once at
server start. It is deliberately narrow: pre-native Codex snapshots only, for
workspaces that have discovery enabled and a stored token. Ordinary staleness is
an explicit-action concern, and no other shape is refreshed at boot.

A declaration joins the workspace-shaped catalog (`GET /api/models` with no scope).
A Runtime configured with a custom connection keeps its own catalog in the
`runtime_id` and `execution_group_id` shapes, so a workspace-wide declaration can be
listed there while an Agent explicitly bound to that Runtime cannot select it. This
asymmetry is inherited rather than introduced by declarations: a gateway snapshot
model is listed and selectable in exactly the same way in exactly the same
configuration. A workspace-level Agent is unaffected — the declared model is
claimable there just like a gateway model.

Production daemons discover capabilities at startup and refresh every 15 minutes.
Manual model-list requests use the same single-flight probe without blocking the
heartbeat loop. The probe runs as a separate `remi runtime-model-probe` process.
It receives options over stdin, not command arguments, and sends no AI prompt.
The supervisor limits runtime/output size, rejects malformed results and terminates
the process group on failure, cancellation, timeout, or completion. Provider
errors are not copied verbatim into daemon logs because they can contain secrets.

The control plane and daemon both require this update. Existing running provider
processes are not restarted. `model_catalog_json` replaces the entire Codex
bundled catalog; it changes model defaults and system templates as well as model
availability. See [MUL-330 verification](mul-330-gateway-reasoning-verification.md)
for the isolated execution evidence and observed GPT differences. Do not describe
this as a merge of catalog entries or as an already deployed change.

Disabled plugin bindings remain readable after switching engine and are excluded
before computing task snapshots. Creating/enabling bindings still validates engine
compatibility, and cross-workspace bindings remain invalid.

## Antigravity Gateway Engine

Antigravity groups select an endpoint that declares `google-generative`. The endpoint
address is the API root and omits `/v1beta` and `/v1`; the adapter appends `/v1beta/...`.
The group chooses its default model; endpoints have no model field. Native-login groups
instead probe the installed `agy acp` using an isolated copy of the local login,
and discover both models and thinking levels through ACP config options.

Binding discovery calls `/v1beta/models` on the Runtime, follows page tokens, removes
non-chat and image-only models and reports no effort selector. A failed page makes the
binding catalog fail, rather than promoting a partial list to executable capability.
Before execution, the daemon opens the existing loopback shim with the task's frozen
endpoint and credential. The ACP server still verifies actual model selection and can
reject a model even if a gateway inventory listed it. See [Antigravity Runtime](antigravity.md).

Old Relay API/CLI shapes remain compatible. Migration imports their address and key
into an endpoint and moves `default_model` into group policy. The Relay row retains an
endpoint reference for old consumers; new groups neither read nor inherit that row.

执行端点可通过 `options.models_url` 指定目录地址，通过 `fetch_models: false` 禁止自动发现并使用 `manual_models`。Runtime 合并手动条目与发现结果；发现失败且配置手动条目时使用手动目录。服务器编辑器的检查缓存只供查看，不替代执行组成员的目录确认。Codex 禁用列表时也跳过原生扩展目录请求，不能由手工条目推断原生推理能力。详见[执行配置](dev/execution-configuration.md#第三方端点接入)。

执行组的 `model_policy.blocked_models` 按精确 ID 在放行名单之后过滤成员目录；catalog、Agent 选型校验与任务调度共用 `executionModelPolicyReason`。响应的 `blocked_models` 保留屏蔽原因，即使模型已从可选列表移除或尚未发现，已保存的选项仍可解释。详见[执行配置](dev/execution-configuration.md)。
