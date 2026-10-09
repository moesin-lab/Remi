import { afterEach, expect, it, spyOn } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

it("bounds message reads and attachment hydration to the requested Chat page", async () => {
  const store = createStore();
  store.ensureLocalWorkspace();
  const agent = store.createAgent({ name: "Pagination", provider: "codex" });
  const chat = store.createChatSession({ agentId: agent.id });
  const member = store.getWorkspaceMemberByRef(chat.creatorId!, chat.workspaceId)!;
  const createdAt = "2026-09-01T00:00:00.000Z";
  // Normalize a real member message before cloning its canonical read fixture.
  // No retired Chat-message table or synthetic headers participate in the page.
  store.sendMessage({ id: "msg_page_1", session_id: chat.id,
    sender: { type: "member", id: member.id }, to: { type: "none" },
    message_kind: "request", wake_requested: "inbox_only", body_md: "x".repeat(4096) });
  db!.transaction(() => {
    db!.run("UPDATE multiremi_conversation_log SET created_at=?,updated_at=? WHERE id=?",
      [createdAt, createdAt, "msg_page_1"]);
    const insert = db!.query(`INSERT INTO multiremi_conversation_log
      (session_id,seq,id,kind,visibility,sender_type,sender_id,body_md,body_html,render_version,
       metadata,revision,created_at,updated_at,to_type,to_ref,to_agent_id,to_member_id,
       message_kind,wake_requested,wake_applied,wake_reason)
      SELECT session_id,?,?,kind,visibility,sender_type,sender_id,body_md,body_html,render_version,
       metadata,revision,created_at,updated_at,to_type,to_ref,to_agent_id,to_member_id,
       message_kind,wake_requested,wake_applied,wake_reason
      FROM multiremi_conversation_log WHERE id='msg_page_1'`);
    for (let seq = 2; seq <= 5000; seq++) insert.run(seq, `msg_page_${seq}`);
    db!.run("UPDATE multiremi_conversation_heads SET head_seq=?,log_version=log_version+? WHERE session_id=?",
      [5000, 4999, chat.id]);
  })();
  const attachment = store.createAttachment({
    filename: "page.txt", url: "/api/attachments/page/content",
    chatSessionId: chat.id, chatMessageId: "msg_page_4950",
  });
  const lastAttachment = store.createAttachment({
    filename: "last.txt", url: "/api/attachments/last/content",
    chatSessionId: chat.id, chatMessageId: "msg_page_5000",
  });
  const app = createMultiremiApp({ store });
  const attachments = spyOn(store, "listAttachmentsForMessages");
  const query = db!.query.bind(db!);
  let messageRows = 0;
  const pageSql: string[] = [];
  const reads = spyOn(db!, "query").mockImplementation(new Proxy(query, {
    apply(target, thisArg, args: [string]) {
      const statement = Reflect.apply(target, thisArg, args);
      if (!/SELECT m\.\* FROM multiremi_conversation_log m WHERE session_id=\?/i.test(args[0])) return statement;
      pageSql.push(args[0]);
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
    const path = `/api/sessions/${chat.id}/messages?limit=50&cursor=4900`;
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
      pageSql.length = 0;
      attachments.mockClear();
    }
    const response = await app.request(path);
    expect(response.status).toBe(200);
    const page = await response.json();
    expect(page.messages).toHaveLength(50);
    expect(page.messages[0].id).toBe("msg_page_4901");
    expect(page.messages[49].id).toBe("msg_page_4950");
    expect(page.messages[49].attachments).toMatchObject([{ id: attachment.id }]);
    expect(page.next_cursor).toBe("4950");
    expect(messageRows).toBe(51);
    expect(pageSql).toHaveLength(1);
    expect(attachments).toHaveBeenCalledTimes(1);
    expect(attachments.mock.calls[0]![0]).toEqual(page.messages.map((message: { id: string }) => message.id));
    const plan = query(`EXPLAIN QUERY PLAN ${pageSql[0]}`).all(chat.id, 4900, Number.MAX_SAFE_INTEGER, 51) as Array<{ detail: string }>;
    expect(plan.map(row => row.detail).join("\n")).toMatch(/SEARCH m USING INDEX .*session_id=\? AND seq>\? AND seq<\?/);
    expect(plan.some(row => /SCAN m|USE TEMP B-TREE/.test(row.detail))).toBe(false);

    messageRows = 0;
    pageSql.length = 0;
    attachments.mockClear();
    const last = await (await app.request(`/api/sessions/${chat.id}/messages?limit=50&cursor=${page.next_cursor}`)).json();
    expect(last.messages[0].id).toBe("msg_page_4951");
    expect(last.messages[49].id).toBe("msg_page_5000");
    expect(last.messages[49].attachments).toMatchObject([{ id: lastAttachment.id }]);
    expect(last.next_cursor).toBeNull();
    expect(messageRows).toBe(50);
    expect(pageSql).toHaveLength(1);
    expect(attachments).toHaveBeenCalledTimes(1);
    expect(attachments.mock.calls[0]![0]).toEqual(last.messages.map((message: { id: string }) => message.id));
  } finally {
    reads.mockRestore();
    attachments.mockRestore();
  }
});

it("preserves sequence/id order, cursor validation and empty-page semantics", async () => {
  const store = createStore();
  store.ensureLocalWorkspace();
  const agent = store.createAgent({ name: "Ordering", provider: "codex" });
  const chat = store.createChatSession({ agentId: agent.id });
  const otherChat = store.createChatSession({ agentId: agent.id });
  const member = store.getWorkspaceMemberByRef(chat.creatorId!, chat.workspaceId)!;
  const app = createMultiremiApp({ store });
  const path = `/api/sessions/${chat.id}/messages`;
  expect(await (await app.request(path)).json()).toEqual({ messages: [], next_cursor: null });
  const createdAt = "2026-09-01T00:00:00.000Z";
  const append = (id: string) => store.sendMessage({ id, session_id: chat.id,
    sender: { type: "member", id: member.id }, to: { type: "none" },
    message_kind: "request", wake_requested: "inbox_only", body_md: id });
  for (let seq = 1; seq <= 7; seq++) {
    append(`msg_order_${seq}`);
    // Timestamps disagree with append order. Canonical cursors follow seq.
    db!.run("UPDATE multiremi_conversation_log SET created_at=? WHERE id=?",
      [seq % 2 ? createdAt : "2026-08-01T00:00:00.000Z", `msg_order_${seq}`]);
  }
  const expected = store.listChatMessages(chat.id).map(message => message.id);
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let pageNumber = 0; pageNumber < 4; pageNumber++) {
    const query = new URLSearchParams({ limit: "3", ...(cursor ? { cursor } : {}) });
    const response = await app.request(`${path}?${query}`);
    expect(response.status).toBe(200);
    const page = await response.json();
    ids.push(...page.messages.map((message: { id: string }) => message.id));
    if (!page.next_cursor) break;
    expect(page.next_cursor).toBe(String(ids.length));
    cursor = page.next_cursor;
    if (pageNumber === 0) append("msg_new");
  }
  expect(ids).toEqual([...expected, "msg_new"]);
  expect(new Set(ids).size).toBe(ids.length);
  expect(await (await app.request(`${path}?cursor=8`)).json()).toEqual({ messages: [], next_cursor: null });
  for (const query of [
    "limit=0", "limit=501", "limit=1.5", "limit=oops", "cursor=-1", "cursor=1.5",
    "cursor=oops", "cursor=9007199254740992", "cursor=1&after_seq=1", "thread=missing",
  ]) {
    expect((await app.request(`${path}?${query}`)).status, query).toBe(400);
  }
  const foreign = await app.request(`/api/sessions/${otherChat.id}/messages?thread=msg_order_1`);
  expect(foreign.status).toBe(400);
  expect(await foreign.json()).toEqual({ error: "invalid thread" });
  // A seq cursor is local to its requested Session and cannot reveal another Chat.
  expect(await (await app.request(`/api/sessions/${otherChat.id}/messages?cursor=1`)).json())
    .toEqual({ messages: [], next_cursor: null });
  expect((await app.request("/api/sessions/missing/messages")).status).toBe(404);
});
