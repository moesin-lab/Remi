/** @vitest-environment jsdom */
import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Session, SessionTask } from "../types";
import { issueKeys } from "../issues/queries";
import { chatKeys } from "./queries";
import { chatWorkSessionKeys, useCreateChatWorkSession, useCreateChatWorkSessionTask } from "./work-sessions";

const mock = vi.hoisted(() => ({ createChatWorkSession: vi.fn(), createChatWorkSessionTask: vi.fn() }));
vi.mock("../api", () => ({ api: mock }));
const session: Session = {
  id: "side-1", owner_type: "chat", owner_id: "chat-1", chat_id: "chat-1", issue_id: "issue-1",
  workspace_id: "ws-1", title: "Review", status: "active", is_default: false,
  holds_workspace: false, parent_session_id: "main-1", inherit_mode: "snapshot", inherit_cutoff_seq: 5,
  inherited_event_count: 5, summary: null, created_by_type: "member", created_by_id: "user-1",
  created_at: "2026-10-08T00:00:00Z", updated_at: "2026-10-08T00:00:00Z", participants: [],
};
const task: SessionTask = {
  id: "task-1", agent_id: "agent-1", runtime_id: null, issue_id: null,
  chat_session_id: "chat-1", issue_session_id: "side-1", status: "queued", priority: 0,
  dispatched_at: null, started_at: null, completed_at: null, result: null, error: null,
  created_at: session.created_at,
};
let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
beforeEach(() => {
  vi.resetAllMocks();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(() => qc.clear());

it("makes a Chat-owned side Session immediately selectable in its linked Issue", async () => {
  mock.createChatWorkSession.mockResolvedValue(session);
  qc.setQueryData(chatWorkSessionKeys.list("ws-2", "chat-2"), []);
  const { result } = renderHook(() => useCreateChatWorkSession("chat-1", "ws-1"), { wrapper });
  await act(async () => { await result.current.mutateAsync({ title: "Review", holds_workspace: false, parent_session_id: "main-1" }); });
  expect(qc.getQueryData(issueKeys.sessions("issue-1"))).toEqual([session]);
  expect(qc.getQueryData(chatWorkSessionKeys.list("ws-1", "chat-1"))).toEqual([session]);
  expect(qc.getQueryData(chatWorkSessionKeys.list("ws-2", "chat-2"))).toEqual([]);
});

it("keeps late Session creation in its originating workspace and Chat", async () => {
  let resolve!: (session: Session) => void;
  mock.createChatWorkSession.mockReturnValue(new Promise<Session>(complete => { resolve = complete; }));
  const { result, rerender } = renderHook(({ wsId, chatId }) => useCreateChatWorkSession(chatId, wsId), {
    wrapper, initialProps: { wsId: "ws-1", chatId: "chat-1" },
  });
  let pending!: Promise<Session>;
  await act(async () => { pending = result.current.mutateAsync({ title: "Review" }); });
  rerender({ wsId: "ws-2", chatId: "chat-2" });
  await act(async () => { resolve(session); await pending; });
  expect(qc.getQueryData(chatWorkSessionKeys.list("ws-1", "chat-1"))).toEqual([session]);
  expect(qc.getQueryData(chatWorkSessionKeys.list("ws-2", "chat-2"))).toBeUndefined();
});

it("keeps a late SessionTask in its destination and leaves the ordinary Chat queue unchanged", async () => {
  let resolve!: (task: SessionTask) => void;
  mock.createChatWorkSessionTask.mockReturnValue(new Promise<SessionTask>(complete => { resolve = complete; }));
  const pendingChat = { task_id: "ordinary-1", status: "running", queued_tasks: [] };
  qc.setQueryData(chatKeys.pendingTask("chat-1"), pendingChat);
  const { result, rerender } = renderHook(({ wsId, chatId, sessionId }) => useCreateChatWorkSessionTask(wsId, chatId, sessionId), {
    wrapper, initialProps: { wsId: "ws-1", chatId: "chat-1", sessionId: "side-1" },
  });
  let pending!: Promise<SessionTask>;
  await act(async () => { pending = result.current.mutateAsync({ agent_id: "agent-1", prompt: "Review" }); });
  rerender({ wsId: "ws-2", chatId: "chat-2", sessionId: "side-2" });
  await act(async () => { resolve(task); await pending; });
  expect(qc.getQueryData(chatWorkSessionKeys.tasks("ws-1", "chat-1", "side-1"))).toEqual([task]);
  expect(qc.getQueryData(chatWorkSessionKeys.tasks("ws-2", "chat-2", "side-2"))).toBeUndefined();
  expect(qc.getQueryData(chatKeys.pendingTask("chat-1"))).toBe(pendingChat);
});
