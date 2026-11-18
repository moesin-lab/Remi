---
title: SCM Monitor
status: active
summary: SCM outbox rules notify Issue owners and subscribed Issue sessions; observations never authorize merging.
---

# SCM Monitor

`ScmRepo.dispatchPendingEvents` registers monitor effects alongside merge effects.
The scheduler consumes them through `processScmMonitorEffects` in a separate
`DatabaseRetryLoop` (`scheduler.scm-monitor`), using the scheduler poll interval.
Slow provider reads do not block the synchronous dispatch loop. Monitor drains are
serial, use the existing retry boundary, and are awaited on shutdown; no new
`setInterval` or repeated capacity polling is introduced. GitHub is supported. Codebase keeps
its current ingestion capability boundaries.

## Rules and delivery

- `pipeline.started`, `pipeline.completed`, `change.opened`, and `change.updated` read current PR checks
  through the same `GitHubScmOperations.liveChecks` implementation as the checks CLI.
  The read fetches PR/checks/PR and rejects changes to head/base/target/base repository.
  It also requires agreement with the collected PR head before delivering.
- A pending or unknown check suppresses the conclusion, including when another check
  has already failed. Empty checks produce no conclusion. Completed evidence emits
  `success` or `failure`, deduplicated per destination session by
  `checks:<repositoryId>#<number>@<headSha>:<verdict>`.
- A newly observed head after a published conclusion emits `head_changed`, includes
  the old SHA and invalidates its conclusion. A separate `monitor_head` effect uses
  the collected head so invalidation still works while provider reads are rate limited.
  This happens even if the new head is pending.
- The first pending observation creates one `monitor_capacity` effect per PR/head/Issue.
  The default deadline is 2700 seconds. At expiry it reads current checks and Actions
  jobs once. Only jobs still `queued` with no runner ID/name on the same head produce
  `capacity_blocked`. Assigned, completed, closed, or superseded work produces no alert.
  Provider failures retry the effect; successful expiry is never periodically rescheduled.
- `review.submitted` and `review.dismissed` forward the normalized GitHub review,
  including `review_commit`. Linked Issues still receive reviews after the PR closes;
  expired subscriptions receive no additional copy. The monitor does not interpret approval
  or authorize merging.

Messages are platform `status` messages, resolved to the associated Issue's execution
owner through the unified Inbox, with `wake_requested: now`. This supports an owner
whose Issue is `in_review`; ordinary dependency and recipient-availability wake guards
still apply. Additional Issue sessions may subscribe; their Issue owners receive the
same message there. Delivery to the default session is independent of subscriptions.
A default session that also subscribes receives only one copy.

The body starts with `SCM monitor` followed by a JSON block:

```json
{
  "schema": "scm_monitor.v1",
  "pr": "https://github.com/owner/repository/pull/42",
  "head_sha": "full head SHA",
  "conclusion": "failure",
  "failed_checks": [],
  "unexecuted_checks": [],
  "run_links": [],
  "next_step": "Inspect failed and unexecuted checks, then fix or rerun as appropriate."
}
```

`failed_checks` preserves failed/error/timed-out/action-required/stale/startup-failure
observations. `unexecuted_checks` separately preserves skipped/cancelled observations;
neutral checks retain their provider meaning and are not called unexecuted.
Capacity messages use queued job names/URLs in `unexecuted_checks`. Head changes add
`previous_head_sha`. Review messages use the event type as `conclusion` and add
`review_commit` and the normalized `review` object.

**Events and successful check observations do not constitute merge authorization.**
They do not assert that required checks or human review requirements are satisfied.
No monitor rule in S1 merges a PR, changes workflows, or grants GitHub permissions.

## Commands

```bash
remi scm change-request watch moesin-lab/Remi 42 --session ises_example --until settled
remi scm change-request list moesin-lab/Remi 42
remi scm change-request watch-list moesin-lab/Remi 42
remi scm change-request unwatch moesin-lab/Remi 42 --session ises_example
remi scm monitor status --json
remi scm monitor project get prj_example
remi scm monitor project set prj_example --pending-timeout-seconds 2700
remi scm event list --cursor sce_example --json
```

Repository references accept enabled binding IDs, `owner/name`, and Git URLs.
PRs must already have been collected. `--session` defaults to the task's Issue session;
outside a task specify it explicitly. Only active Issue sessions in the same workspace
are accepted. `--until` is `closed` (default), `merged`, or `settled`; all subscriptions
expire on closure/merge, while `settled` also expires after a completed check conclusion.
Without a PR number, `change-request list <issue>` retains its existing Issue-list behavior.
Project timeout changes require workspace admin authority and accept 60–86400 seconds;
reads and watches allow same-workspace task credentials. Timeout changes affect future
pending effects, not deadlines already persisted. `unwatch` is idempotent.

`monitor status` exposes each enabled polling connection/repository/stream's
`lastSuccessfulPollAt`, `lagSeconds`, `lastError`, and `stale`. Never-successful streams
measure lag from binding creation. More than five configured polling periods triggers
a platform status alert to active workspace members' inboxes, once per stalled success
watermark. A recovered stream can alert again if its later success watermark stalls.
The event CLI's `--cursor` maps to the server's exclusive `after` parameter;
`nextAfter` is the cursor for the next page. ISO timestamps are also accepted.

## Storage and extension

The expand migration preserves existing merge effects and adds payload, due time,
attempt count, lease token/deadline and unique dedupe key to `multiremi_scm_effects`.
It adds watch, concluded-head, project-timeout, and collection-alert tables.
A claimed monitor effect has a two-minute lease and a 90-second provider-read timeout.
Message delivery, conclusion state and the applied marker commit together after a
lease-token fence. Crashed workers are reclaimed; stale workers cannot commit.
Provider errors remain retryable with bounded exponential backoff. Rate limits honor
Retry-After/reset time (at least 60 seconds), measured from the actual failure time
rather than the drain start time. Stored errors contain no provider body.
Delayed monitor effects do not keep canonical events pending or repeat automation delivery.

PR-targeted rows persist `<rule-name>:<changeRequestId>` as their effect type and
include the PR ID in their dedupe key. This distinguishes multiple PRs sharing one
pipeline event and Issue under the original unique event/Issue/type constraint.
Legacy unsuffixed rows remain consumable. Capacity effects use the same PR scope,
with deduplication per PR/head/Issue. No existing merge-effect constraint is removed.

Built-in rule names are `monitor_head`, `monitor_checks`, `monitor_review`, `monitor_capacity`;
`complete_issue_on_merge` retains its existing activity-only meaning.
`registerScmMonitorRule` registers a unique `monitor_*` rule with `matches` and `prepare`.
Preparation reads external evidence and returns a synchronous database commit callback,
executed in the same lease-fenced transaction. An optional `targets` planner can
select same-workspace Issue anchors and effect payloads for events without a PR
(such as S3 default-branch events); the registered handler owns its target lifecycle
and must revalidate its authorization and state in the commit callback.
Future S2/S3 rules must use new effect
names, register before dispatch, preserve persisted payload compatibility and independently
establish any required authorization. External writes need their own idempotency contract;
read evidence or a preparation callback is not authorization to merge.

Verification: `tests/unit/multiremi/scm-monitor.test.ts`,
`tests/unit/multiremi/scm-checks.test.ts`,
`tests/unit/multiremi/multiremi-api-scm-checks.test.ts`, and
`tests/unit/remi/cli-operations.test.ts`. Provider responses are mocked; the monitor,
SQLite effects, unified Inbox, wake behavior and HTTP handlers are real. These tests
do not prove deployment or actual runner starvation in GitHub.
