import { runMigrations } from "@multiremi/store/migrations.js";
import { expect, it } from "bun:test";
import { MultiremiStore } from "@multiremi/store.js";
import { CHAT_SESSION_IDS_MIGRATION } from "@multiremi/store/migrations.js";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";

pendingTurnBackendTests("Chat id reservations", (fixture, backend) => {
  const reopen = () => {
    const f = fixture();
    if (backend === "PostgreSQL") f.reopen();
    else f.store = new MultiremiStore(f.db);
  };
  it("keeps a deleted empty Chat id unavailable after reopening the store", () => {
    const f = fixture();
    const agent = f.store.createAgent({ name: "Worker", provider: "claude" });
    const chat = f.store.createChatSession({ id: "chat_0000000000aa", agentId: agent.id });

    expect(f.store.deleteChatSession(chat.id)).toBe(true);
    reopen();

    expect(f.store.getChatSession(chat.id)).toBeNull();
    expect(f.store.isChatSessionIdUsed(chat.id)).toBe(true);
    expect(() => f.store.createChatSession({ id: chat.id, agentId: agent.id }))
      .toThrow("Chat session id has already been used");
  });

  it("reserves existing Chats and deleted private task identities on upgrade", () => {
    const f = fixture();
    const agent = f.store.createAgent({ name: "Worker", provider: "claude" });
    const live = f.store.createChatSession({ id: "chat_0000000000bb", agentId: agent.id });
    const deleted = f.store.createChatSession({ id: "chat_0000000000cc", agentId: agent.id });
    f.store.createTask({ agentId: agent.id, chatSessionId: deleted.id, prompt: "Private audit" });
    expect(f.store.deleteChatSession(deleted.id)).toBe(true);

    f.db.exec("DROP TABLE multiremi_chat_session_ids");
    f.db.run("DELETE FROM multiremi_schema_migrations WHERE id = ?", [CHAT_SESSION_IDS_MIGRATION]);
    runMigrations(f.db, { historicalMaintenance: true });
    reopen();
    expect(f.store.deleteChatSession(live.id)).toBe(true);
    reopen();

    for (const id of [live.id, deleted.id]) {
      expect(f.store.getChatSession(id)).toBeNull();
      expect(f.store.isChatSessionIdUsed(id)).toBe(true);
      expect(() => f.store.createChatSession({ id, agentId: agent.id }))
        .toThrow("Chat session id has already been used");
    }
  });
});
