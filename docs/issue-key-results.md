# Issue key results — metadata contract

A Session result (`POST /api/issues/:id/sessions/:sessionId/results` or
`POST /api/multiremi/chats/:chatId/sessions/:sessionId/results`) carries a free-form
`metadata` object. Two keys inside it are a *convention*, not a constraint: the store persists
whatever is sent and every reader degrades instead of failing.
The source Session has one Chat or Issue owner. Results follow that source's access
permissions; an Issue work projection does not make a private Chat result public.

## `metadata.kind`

One of `mr` | `branch` | `report` | `deploy` | `decision` | `doc` | `other`.

- Absent or unknown value → readers treat it as `other` (generic icon, generic label).
- Both owner paths (`remi session result publish <chat> <session> --type <kind>` and
  `remi issue session result publish <issue> <session> --type <kind>`) reject a value outside the supported CLI kinds
  with a usage error that names the valid kinds — the agent gets told, the API stays open.
- `branch` is recognized by the UI but is not offered by the CLI. A branch result can carry
  a `metadata.worktrees` list of `{ repo_url, branch, path }`; this convention does not promise
  that every repository checkout publishes a result automatically.

## `metadata.refs`

`[{ "type": string, "value": string }]` — the same shape as project-doc refs.

- `type` is open (`issue` | `task` | `url` | `file` today). An unknown type renders as plain text.
- Anything that is not an array → no refs. A non-object entry, or an entry with an empty
  `value`, is dropped rather than failing the whole result.
- The CLI accepts repeatable `--ref <type>:<value>` (a bare `http(s)` URL is taken as `url:`),
  sharing the parser with `project doc create/update`.

## Where it is read

- [session-results.ts](../frontend/packages/core/issues/session-results.ts) — `sessionResultKind()` / `sessionResultRefs()`,
  the lenient readers used by the UI.
- [issue-key-results-section.tsx](../frontend/packages/views/issues/components/issue-key-results-section.tsx) — 关键结果 panel section
  (icon by kind, refs as badges).

最终回复是对话中的 final 消息，用 `remi message get <message>` 读取；`remi turn get <turn>` 的 reply_message_id 指向它。Session result publish 发布可复用成果，不代替轮的最终回复。
