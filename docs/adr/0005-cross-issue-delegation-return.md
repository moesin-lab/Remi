# ADR 0005: Cross-issue delegation returns to the dispatcher's Session

## Status

Accepted (MUL-400 S1b, child Issue MUL-456), updated for the unified model in
[ADR 0016](0016-unified-message-inbox-and-turn.md). Dispatch qualification and
pair limits follow [ADR 0014](0014-every-agent-dispatch-is-a-delegation.md);
deliverable and bounded doorbell separation follows
[ADR 0013](0013-deliverable-is-comment-wakeup-is-doorbell.md).

## Context

Cross-Issue dispatch originally omitted delegation lineage unless source and
target shared an Issue, so terminal child work could leave its dispatcher asleep.
The recorded decision was to return to the dispatcher's actual working Session,
with audited lineage and one automatic report. It also required child-status
wakes and delegation completion to avoid starting duplicate pending rounds.
The unified model expresses that intent through canonical messages and turns.
Earlier bridge-row and return-task mechanics remain traceable in Git history.

## Decision

1. **Keep the source Session as the return target.** A task-token request obtains
   sender and source turn from its authenticated current attempt. The service
   derives Issue, Agent, source Session, delegation and parent lineage; callers
   cannot override those identities through request fields. A Chat-owned Session
   with an Issue work projection remains a valid source subject to its privacy
   checks. Side-Session delegation restrictions, workspace access, Agent access
   and the pair round-trip limit still apply.

2. **Send directed requests instead of creating work through old task routes.**
   Use `remi message send <session> --to <agent> --kind request`. A running lane
   receives eligible now messages as interruptions; pending input merges into
   one pending turn per lane. A message that exceeds the pair limit remains
   saved with `wake_applied=next_turn` and `wake_reason=pair_round_trip_limit`.
   Neither a saved message nor a pending turn proves execution has started.

3. **Return via the unique message transaction.** A delegated terminal result
   emits a bounded `status/report` message to the recorded return conversation
   and recipient through `sendMessageWithinTransaction`. The complete reply/final
   remains at its own canonical location; a report points to that evidence rather
   than copying a full transcript. `multiremi_turns` records return coverage, while
   retries remain attempts of the same turn. Message dedupe and lane scheduling
   replace the old bridge-row, return-task and manual-wake suppression contract.

4. **Preserve the return owner's privacy.** Chat-owned return Sessions receive
   private messages even if projected into an Issue; there is no automatic public
   Issue-comment mirror. Issue-owned return Sessions remain visible under Issue
   permissions. Sending a request or report does not grant the sender other
   private messages, turn input, attempt trace or control authority.

5. **Coordinate structural wakes through the same lane.** Child-status and
   dependency producers resolve their actual recipient and Session before
   sending. They use the same pending-turn lane rules as delegation reports.
   Structural platform wakes preserve their explicit dependency exemptions;
   ordinary agent requests do not bypass unmet dependencies. Member now requests
   follow the separately audited force-start rule in ADR 0016.

6. **Do not infer lifecycle permission from a return.** Ordinary work cannot
   start in an archived Session. Existing delegation returns and end-of-turn
   re-rings may use the internal closing path only after source, parent lineage,
   owner, Workspace, Agent and scope are verified. Public sender, wake or
   delegation fields do not grant that internal permission.

## Consequences

- Cross-Issue results arrive in the working Session that dispatched them, rather
  than an unrelated child/default context.
- Chat ownership is retained across Issue projection, terminal replies and returns.
- Work is a Turn; trace, usage, archives and execution affinity remain Attempt data.
  A retry does not create a second business round or itself change Issue status.
- Commit precedes notification and realtime fanout. A rejected message transaction
  leaves no partial reply or invented evidence pointer.
- The storage migration and production cutover gates in ADR 0016 still apply.
  This document does not assert a production rehearsal or deployment has occurred.

## Implementation and verification

Current entry points are the [message state machine](../../packages/server/src/store/inbox/),
[execution repository](../../packages/server/src/store/repos/tasks-repo.ts),
[Message/Turn API](../dev/message-api.md) and [Session-owner contract](../conversation-model.md).
Verification includes [unified runtime tests](../../tests/unit/multiremi/unified-model-runtime.test.ts),
[Issue Session permissions](../../tests/unit/multiremi/multiremi-issue-sessions.test.ts)
and [delegation returns](../../tests/unit/multiremi/multiremi-store-delegation-return.test.ts).
These are verification entry points, not a claim that they ran in this documentation update.
