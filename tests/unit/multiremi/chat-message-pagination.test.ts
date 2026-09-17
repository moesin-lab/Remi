import { afterEach, expect, it, spyOn } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

it("bounds message reads and attachment hydration to the requested Chat page", async () => {
  const store = createStore();
  const agent = store.createAgent({ name: "Pagination", provider: "codex" });
  const chat = store.createChatSession({ agentId: agent.id });
  const createdAt = "2026-09-01T00:00:00.000Z";
  db!.transaction(() => {
    const insert = db!.query(`INSERT INTO multiremi_chat_messages
      (id, chat_session_id, sequence, role, body, created_at) VALUES (?, ?, ?, 'assistant', ?, ?)`);
    for (let seq = 1; seq <= 5000; seq++) {
      insert.run(`msg_page_${seq}`, chat.id, seq, "x".repeat(4096), createdAt);
    }
  })();
  const attachment = store.createAttachment({
    filename: "page.txt", url: "/api/attachments/page/content",
    chatSessionId: chat.id, chatMessageId: "msg_page_5000",
  });
  const app = createMultiremiApp({ store });
  const attachments = spyOn(store, "listAttachmentsForChatMessages");
  const query = db!.query.bind(db!);
  let messageRows = 0;
  const reads = spyOn(db!, "query").mockImplementation(new Proxy(query, {
    apply(target, thisArg, args: [string]) {
      const statement = Reflect.apply(target, thisArg, args);
      if (!/SELECT \* FROM multiremi_chat_messages/i.test(args[0])) return statement;
      return new Proxy(statement, {
        get(target, property) {
          if (property === "all") return (...params: unknown[]) => {
            const rows = Reflect.apply(target.all, target, params);
            messageRows += rows.length;
            return rows;
          };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  }));
  try {
    const path = `/api/chat/sessions/${chat.id}/messages/page?limit=50`;
    if (process.env.CHAT_PAGE_BENCH === "1") {
      const samples: number[] = [];
      for (let i = 0; i < 35; i++) {
        const start = performance.now();
        const response = await app.request(path);
        expect(response.status).toBe(200);
        await response.json();
        if (i >= 5) samples.push(performance.now() - start);
      }
      samples.sort((a, b) => a - b);
      console.log(JSON.stringify({ messages: 5000, bodyBytes: 4096, limit: 50,
        samples: 30, p50Ms: samples[14], p95Ms: samples[28] }));
      messageRows = 0;
      attachments.mockClear();
    }
    const response = await app.request(path);
    expect(response.status).toBe(200);
    const newest = await response.json();
    expect(newest.messages).toHaveLength(50);
    expect(newest.messages[0].id).toBe("msg_page_4951");
    expect(newest.messages[49].attachments).toMatchObject([{ id: attachment.id }]);
    expect(newest.next_cursor).toEqual({ id: "msg_page_4951", created_at: createdAt });
    expect(messageRows).toBeLessThanOrEqual(51);
    expect(attachments.mock.calls[0]![0]).toEqual(newest.messages.map((message: { id: string }) => message.id));

    messageRows = 0;
    const cursor = new URLSearchParams({ before_id: newest.next_cursor.id, before_created_at: createdAt });
    const older = await (await app.request(`${path}&${cursor}`)).json();
    expect(older.messages[0].id).toBe("msg_page_4901");
    expect(older.messages[49].id).toBe("msg_page_4950");
    expect(older.has_more).toBe(true);
    expect(messageRows).toBeLessThanOrEqual(51);
  } finally {
    reads.mockRestore();
    attachments.mockRestore();
  }
});

it("preserves sequence/id order, cursor validation and empty-page semantics", async () => {
  const store = createStore();
  const agent = store.createAgent({ name: "Ordering", provider: "codex" });
  const chat = store.createChatSession({ agentId: agent.id });
  const otherChat = store.createChatSession({ agentId: agent.id });
  const app = createMultiremiApp({ store });
  const path = `/api/chat/sessions/${chat.id}/messages/page`;
  expect(await (await app.request(path)).json()).toEqual({
    messages: [], limit: 50, has_more: false, next_cursor: null,
  });
  const createdAt = "2026-09-01T00:00:00.000Z";
  for (let seq = 1; seq <= 7; seq++) {
    db!.run(`INSERT INTO multiremi_chat_messages
      (id, chat_session_id, sequence, role, body, created_at) VALUES (?, ?, ?, 'user', ?, ?)`,
    [`msg_order_${seq}`, chat.id, Math.ceil(seq / 2), `message ${seq}`,
      seq % 2 ? createdAt : "2026-08-01T00:00:00.000Z"]);
  }
  const expected = store.listChatMessages(chat.id).map((message) => message.id);
  const ids: string[] = [];
  let before: { id: string; created_at: string } | null = null;
  for (let pageNumber = 0; pageNumber < 4; pageNumber++) {
    const query = new URLSearchParams({ limit: "3", ...(before
      ? { before_id: before.id, before_created_at: before.created_at } : {}) });
    const response = await app.request(`${path}?${query}`);
    expect(response.status).toBe(200);
    const page = await response.json();
    ids.unshift(...page.messages.map((message: { id: string }) => message.id));
    if (!page.has_more) {
      expect(page.next_cursor).toBeNull();
      break;
    }
    before = page.next_cursor;
    if (pageNumber === 0) {
      db!.run(`INSERT INTO multiremi_chat_messages
        (id, chat_session_id, sequence, role, body, created_at) VALUES ('msg_new', ?, 5, 'user', 'new', ?)`,
      [chat.id, createdAt]);
    }
  }
  expect(ids).toEqual(expected);
  const oldest = new URLSearchParams({ before_id: expected[0]!, before_created_at: createdAt });
  expect(await (await app.request(`${path}?${oldest}`)).json()).toEqual({
    messages: [], limit: 50, has_more: false, next_cursor: null,
  });
  for (const query of [
    "limit=0", "limit=101", "limit=1.5", "limit=oops", "before_id=msg_order_1",
    `before_created_at=${createdAt}`, "before_id=msg_order_1&before_created_at=invalid",
    `before_id=missing&before_created_at=${createdAt}`,
    "before_id=msg_order_1&before_created_at=2026-08-01T00:00:00.000Z",
  ]) {
    expect((await app.request(`${path}?${query}`)).status).toBe(400);
  }
  const foreign = await app.request(`/api/chat/sessions/${otherChat.id}/messages/page?${oldest}`);
  expect(foreign.status).toBe(400);
  expect(await foreign.json()).toEqual({ error: "invalid cursor" });
  expect((await app.request("/api/chat/sessions/missing/messages/page")).status).toBe(404);
});
