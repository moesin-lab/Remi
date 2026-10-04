import { afterEach, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createSqliteStreamAuthReader, decideLogSubscription, LOG_STREAM_FACTS_SQL, logFactsFromRow } from "@multiremi/api/hub/stream-auth.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

for (const linked of [false, true]) {
  it(`keeps ${linked ? "Issue-linked" : "independent"} Chat work Session logs private across HTTP and stream readers`, async () => {
    const store = createLocalStore();
    for (const [userId, role] of [["alice", "member"], ["bob", "admin"]] as const) {
      store.createWorkspaceMember({ workspaceId: "local", userId, name: userId, role });
    }
    const agent = store.createAgent({ name: "Log owner", provider: "codex", visibility: "workspace", ownerId: "alice" });
    const chat = store.createChatSession({ agentId: agent.id, creatorId: "alice" });
    const issue = linked ? store.createIssue({ title: "Shared management anchor" }) : null;
    const session = issue
      ? store.createIssueSession(issue.id, { chatId: chat.id, title: "Private work" })
      : store.getOrCreateDefaultChatSession(chat.id);
    store.appendSessionEvent(session.id, { authorType: "member", authorId: "alice", kind: "message", body: "private log" });
    const app = createMultiremiApp({ store, authToken: "root-test" });
    const reader = createSqliteStreamAuthReader(store);
    for (const userId of ["alice", "bob"] as const) {
      const token = await store.createAccessToken({ name: userId, type: "pat", workspaceId: "local", userId });
      for (const path of [`/api/sessions/${session.id}`, `/api/sessions/${session.id}/log?before=10`,
        `/api/sessions/${session.id}/log/entry?seq=1`, `/api/sessions/${session.id}/log/locate?id=missing`]) {
        const response = await app.request(path, { headers: { Authorization: `Bearer ${token.token}` } });
        if (userId === "bob") expect(response.status).toBe(403);
        else expect([200, 404]).toContain(response.status);
      }
      const subject = { userId, workspaceId: "local" };
      const facts = await reader.logFacts(session.id, subject);
      expect(facts.ok).toBe(true);
      if (!facts.ok) throw new Error("facts unavailable");
      const sqlFacts = logFactsFromRow(db!.query(LOG_STREAM_FACTS_SQL).get(userId, session.id, userId, session.id) as any);
      expect(sqlFacts).toEqual(facts.facts);
      expect(decideLogSubscription(subject, sqlFacts).ok).toBe(userId === "alice");
    }
    store.updateAgent(agent.id, { visibility: "private", ownerId: "bob" });
    const subject = { userId: "alice", workspaceId: "local" };
    const sqlFacts = logFactsFromRow(db!.query(LOG_STREAM_FACTS_SQL).get("alice", session.id, "alice", session.id) as any);
    expect(decideLogSubscription(subject, sqlFacts).ok).toBe(false);
    const facts = await reader.logFacts(session.id, subject);
    expect(facts.ok && decideLogSubscription(subject, facts.facts).ok).toBe(false);
    const alice = await store.createAccessToken({ name: "restricted owner", type: "pat", workspaceId: "local", userId: "alice" });
    for (const logId of [chat.id, session.id]) {
      for (const suffix of ["log?before=10", "log/entry?seq=1", "log/locate?id=missing"]) {
        const response = await app.request(`/api/sessions/${logId}/${suffix}`, {
          headers: { Authorization: `Bearer ${alice.token}` },
        });
        expect(response.status).toBe(403);
      }
    }
  });
}
