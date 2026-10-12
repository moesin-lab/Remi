// Sibling test for packages/server/src/store/repos/issue-sessions-repo.ts.
// Drives the carved-out repo directly over its StoreContext (not through the
// MultiremiStore facade) so a broken delegation cannot mask a broken move.
import { afterEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { MultiremiStore } from "@multiremi/store.js";
import { StoreContext } from "@multiremi/store/context.js";
import { IssueSessionsRepo } from "@multiremi/store/repos/issue-sessions-repo.js";
import { createResponsibleTestIssue } from './helpers.js';

let db: Database | null = null;
let store: MultiremiStore | null = null;

function createRepo(): IssueSessionsRepo {
  db = openSqliteDatabase(":memory:");
  // The store owns migrations and is the lazy cross-domain host the context resolves.
  store = new MultiremiStore(db);
  return new IssueSessionsRepo(new StoreContext(db, () => store!));
}

afterEach(() => {
  db?.close();
  db = null;
  store = null;
});

describe("IssueSessionsRepo", () => {
  it("returns the same default session for an issue on every call", () => {
    const repo = createRepo();
    const issue = createResponsibleTestIssue(store!,{ title: "Session host", workspaceId: "local" });

    const first = repo.getOrCreateDefaultIssueSession(issue.id);
    const second = repo.getOrCreateDefaultIssueSession(issue.id);
    expect(second.id).toBe(first.id);
    expect(first.isDefault).toBe(true);
    expect(repo.listIssueSessions(issue.id).map((entry) => entry.id)).toEqual([first.id]);
    expect(() => repo.listIssueSessions("iss_nope")).toThrow("Issue not found: iss_nope");
  });

  it("appends session events with a monotonic per-session sequence", () => {
    const repo = createRepo();
    const issue = createResponsibleTestIssue(store!,{ title: "Event log", workspaceId: "local" });
    const session = repo.getOrCreateDefaultIssueSession(issue.id);

    const first = repo.appendSessionEvent(session.id, { authorType: "system", body: "one" });
    const second = repo.appendSessionEvent(session.id, { authorType: "system", body: "two" });
    expect([first.seq, second.seq]).toEqual([1, 2]);
    expect(repo.listSessionEvents(session.id).map((entry) => entry.body)).toEqual(["one", "two"]);
    expect(repo.listSessionEvents(session.id, { sinceSeq: 1 }).map((entry) => entry.body)).toEqual(["two"]);
  });

  it("adds an agent participant and opens its lane (cross-domain agent lookup)", () => {
    const repo = createRepo();
    const issue = createResponsibleTestIssue(store!,{ title: "Lane", workspaceId: "local" });
    const session = repo.getOrCreateDefaultIssueSession(issue.id);
    // Agents live in another repo, reached through ctx.agents().
    const agent = store!.createAgent({ name: "Laner", provider: "claude", workspaceId: "local" });

    const participant = repo.addSessionParticipant(session.id, { participantType: "agent", participantId: agent.id });
    expect(participant.participantId).toBe(agent.id);
    expect(repo.getSessionAgentLane(session.id, agent.id)?.cursorSeq).toBe(0);
    expect(() => repo.addSessionParticipant(session.id, { participantType: "agent", participantId: "agt_nope" }))
      .toThrow("Agent not found: agt_nope");

    repo.removeSessionParticipant(session.id, "agent", agent.id);
    expect(repo.listSessionParticipants(session.id)).toEqual([]);
  });

  it("shares human participation while preserving historical rows and independent Agent state", () => {
    const repo = createRepo();
    const issue = createResponsibleTestIssue(store!, { title: "Shared participants", workspaceId: "local" });
    const session = repo.getOrCreateDefaultIssueSession(issue.id);
    const first = store!.createWorkspaceMember({ name: "Historical A", userId: "old-a" });
    const second = store!.createWorkspaceMember({ name: "Historical B" });
    const agent = store!.createAgent({ name: "Independent participant", provider: "codex" });
    repo.addSessionParticipant(session.id, { participantType: "agent", participantId: agent.id });
    for (const member of [first, second]) db!.run(`INSERT INTO multiremi_session_participants
      (id,session_id,participant_type,participant_id,role,status,joined_at,updated_at)
      VALUES(?,?,'member',?,'participant','active',?,?)`, [`spart_${member.id}`, session.id, member.userId ?? member.id,
        "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"]);
    const history = repo.listSessionParticipants(session.id, true);
    const shared = repo.listSessionParticipants(session.id);
    expect(shared.filter(row => row.participantType === "member").map(row => row.participantId)).toEqual(["local"]);
    expect(repo.listSessionParticipantsForSessions([session.id]).get(session.id)).toEqual(shared);
    expect(repo.listSessionParticipantsForSessions([session.id], true).get(session.id)).toEqual(history);
    const elsewhere = store!.createWorkspace({ name: "Other workspace" });
    const outside = store!.getWorkspaceOperator(elsewhere.id)!;
    expect(() => repo.removeSessionParticipant(session.id, "member", outside.id)).toThrow("another workspace");
    expect(repo.listSessionParticipants(session.id, true)).toEqual(history);
    repo.removeSessionParticipant(session.id, "member", first.id);
    expect(repo.listSessionParticipants(session.id).map(row => row.participantId)).toEqual([agent.id]);
    expect(repo.listSessionParticipants(session.id, true).filter(row => row.participantType === "member")
      .map(row => ({ id: row.participantId, status: row.status })).sort((a,b) => a.id.localeCompare(b.id))).toEqual([
        { id: "old-a", status: "left" }, { id: second.id, status: "left" },
      ].sort((a,b) => a.id.localeCompare(b.id)));
    repo.addSessionParticipant(session.id, { participantType: "member", participantId: second.id });
    expect(repo.listSessionParticipants(session.id).filter(row => row.participantType === "member").map(row => row.participantId)).toEqual(["local"]);
    expect(repo.listSessionParticipants(session.id, true).filter(row => row.participantType === "member")).toHaveLength(3);
  });
});
