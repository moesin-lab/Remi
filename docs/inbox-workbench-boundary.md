# Inbox vs. Workbench — routing and reading boundaries

Workbench answers what work needs action now. Inbox answers which visible messages
were addressed to the current identity and remain unread. They share Issue and
conversation context, but have separate state and counts.

| | Workbench (工作台) | Inbox (收件箱) |
| --- | --- | --- |
| Grain | one row per Issue | one row per canonical message |
| Storage | live Issue queries, no separate workbench rows | conversation log |
| Read state | none | monotonic member or agent lane cursor per conversation |
| Counts | Issue status partitions | visible addressed messages after the cursor |

Current entry points are the [routing registry](../packages/server/src/store/inbox-routing.ts),
[unified API](../packages/server/src/api/routers/unified.ts),
[inbox Store](dev/inbox-store.md), and [page](../frontend/packages/views/inbox/components/inbox-page.tsx).
The HTTP wire contract is [Message / Inbox / Turn](dev/message-api.md).

## Selected issue execution and recovery

The selected Issue's [execution panel](../frontend/packages/views/workbench/components/workbench-run-panel.tsx)
shares `issueKeys.tasks(issueId)` with the execution history rather than querying
every list row. Active work takes precedence over the latest terminal round.
Queued/dispatched means waiting to start; completed means ready for review, not
approval of the Issue. Loading and failed reads are explicit states.

Execution queries and controls use turns. `remi turn get <turn> --input --attempts`
reads authorized input and attempts; attempt trace is separate execution evidence.
`remi turn retry <turn>` adds an attempt to the same turn and requires an explicit
supervisor or related controller task credential, with the organizer mode and audit
checks. Human credentials alone do not grant that operation. Follow-up work is a
new directed request to the existing Session. The old Issue rerun route returns 410;
prior tool actions are not undone by cancellation, retry or a new request.

## Routing intent

The `INBOX_ROUTING` registry retains these producer decisions:

1. A personally addressed assignment, mention or decision belongs in the inbox.
2. Broadcast progress for an Issue already visible in the workbench stays in its
   activity/conversation context. It should not mint a duplicate personal notification.
3. Automation conclusions and failures are durable reports to the appropriate
   recipients, even when no human processing queue owns the work.
4. Other events remain activity only unless a producer explicitly addresses a message.

The registry supplies the route and severity for legacy producer adapters; those
adapters now emit messages through the unified transaction. They do not recreate
`inbox_items`, per-item archive state or a second unread store. Unregistered types
remain activity-only. New producers must declare routing and use the canonical
message entry point; state, notification and realtime effects are committed together.

Automations have `auto_*` conversations. Issue-mode execution still belongs to the
Issue's Session, with status messages back to the automation conversation. Reports
carry their source identifiers and result evidence; a failed run must remain a
failure, not be collapsed into a success summary.

## Inbox visibility and counts

`GET /api/inbox` returns `{items,unread_count,attention_count,next_cursor}` together.
Human credentials read their workspace member lane; task credentials read their
current agent lane. Neither can choose an unrelated reader. Items are visible,
addressed messages after that reader's cursor, ordered by `created_at DESC, id DESC`.
Counts cover all eligible messages and do not depend on the loaded page size.

Attention counts non-`inbox_only`, unresolved decisions, member requests, failed or
cancelled status, and failed/blocked/cancelled results. Resolving is separate from
reading. The sidebar uses these server counts; old severity-based summaries,
date/Issue deduplication and `/api/inbox/summary` are not the current count contract.
Workbench badge arithmetic remains its own Issue-state calculation.

Every inbox list, detail and count applies the same source visibility checks as
message reads. Chat-owned Sessions retain Chat privacy even when projected into an
Issue. Deleted Chat execution history does not become public through a retained
attempt, turn or message ID. Cross-workspace decisions and unavailable protected
sources are hidden rather than exposed as a fallback.

## Reading and browsing

The page loads 50 messages at a time via [inbox queries](../frontend/packages/core/inbox/queries.ts)
and follows the opaque `next_cursor`; the API allows up to 500. Selecting a message
loads its canonical detail, including attachments and decision controls. A deep link
may read the message directly even when it is outside loaded inbox pages. Errors
retain a retry state. The page no longer archives individual notifications or groups.

`POST /api/inbox/read` with `{session_id,to_seq?}` advances only to the final visible
message addressed to that identity within the requested upper bound. It never moves
backward or beyond the log head. `{all:true}` reads all visible conversations; it is
mutually exclusive with a single-conversation request. A conversation containing only
hidden rows is neither counted as read nor advanced. Agent lanes remain scope-specific.
Ordinary message lists and display log windows do not mark messages read.

CLI equivalents are `remi inbox`, `remi inbox read <conversation> --to <seq>` and
`remi inbox read-all`. Old item IDs and per-item read/archive commands are retired.
Old list/page/summary/notification routes return 410 except the reused unified paths.

## Realtime and invariants

Committed messages emit workspace-level `inbox:new` with `{index_only:true}`. Single
and all-conversation reads emit `inbox:read` and `inbox:batch-read`. Index events carry
no private body or conversation identity. The client refreshes inbox and message-detail
queries; it cannot infer counts or visibility from an event payload. Decision events
also refresh message detail so external answers update an open card.

- Workbench remains a live Issue query without inbox storage or read cursors.
- Issue status is derived from turns and unanswered decisions, not attempt failures
  or retries; parent/child and dependency guards retain their own rules.
- Auth carries a user identity, while a human reader lane uses the active workspace
  member identity; producers and readers resolve that mapping explicitly.
- Session ownership, Issue aggregation and lifecycle follow [the conversation model](conversation-model.md).
  A Chat-owned report or delegation return does not become public merely because its
  Session has an Issue projection.

## Verification

Verification entry points include [unified API tests](../tests/unit/multiremi/unified-api.test.ts),
[source visibility parity](../tests/unit/multiremi/unified-access-consistency.test.ts),
[page tests](../frontend/packages/views/inbox/components/inbox-page.test.tsx) and
[mutation tests](../frontend/packages/core/inbox/mutations.test.tsx). Listed tests are
methods, not evidence of execution. Performance measurements and real service/browser
prerequisites follow [TESTING.md](../TESTING.md) and [the performance guide](dev/performance.md).
