import type { ReactNode } from "react";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { ExternalChatHistory } from "@multiremi/core/chat";
import { externalChatKeys } from "@multiremi/core/chat";
import enChat from "../../locales/en/chat.json";
import jaChat from "../../locales/ja/chat.json";
import { ExternalChatWindow } from "./external-chat-window";

const backend = vi.hoisted(() => ({ getExternalChatHistory: vi.fn() }));
const rendering = vi.hoisted(() => ({ markdownCalls: 0 }));
vi.mock("@multiremi/core/api", async original => ({ ...await original<typeof import("@multiremi/core/api")>(), api: backend }));
vi.mock("react-markdown", async original => {
  const actual = await original<typeof import("react-markdown")>();
  const { createElement } = await import("react");

  return { ...actual, default: (props: import("react-markdown").Options) => {
    rendering.markdownCalls++;
    return createElement(actual.default, props);
  } };
});

function history(): ExternalChatHistory {
  return {
    chat: { id: "thread", source_id: "source", project_id: null, native_project_id: null, title: "Native thread", cwd: "/work/project", created_at: 1, updated_at: 2, status: "idle", model: "original", model_provider: "original", reasoning_effort: "high", readonly: true },
    turns: Array.from({ length: 20 }, (_, index) => ({
      id: `turn-${index}`, status: "completed", items: [
        { id: `user-${index}`, type: "userMessage", role: "user", text: `Native question ${index}` },
        { id: `assistant-${index}`, type: "agentMessage", role: "assistant", text: `Native answer ${index}` },
        ...(index === 0 ? [{ id: "tool-0", type: "commandExecution", role: "tool" as const, text: "Native tool output" }] : []),
      ],
    })),
    requests: [], next_cursor: null,
  };
}

function WindowHarness() {
  const [draft, setDraft] = useState("");
  return <ExternalChatWindow ws="ws" runtime="rt" source="source" thread="thread" online draft={draft} onDraftChange={setDraft} />;
}
function LanguageSwitch() {
  const { i18n } = useTranslation();
  return <button type="button" onClick={() => void i18n.changeLanguage("ja")}>Switch language</button>;
}
const clients: QueryClient[] = [];
function show(extra?: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(<I18nProvider locale="en" resources={{ en: { chat: enChat }, ja: { chat: jaChat } }}><QueryClientProvider client={client}>{extra}<WindowHarness /></QueryClientProvider></I18nProvider>);
  return client;
}

beforeEach(() => {
  vi.resetAllMocks();
  rendering.markdownCalls = 0;
  window.sessionStorage.clear();
  backend.getExternalChatHistory.mockResolvedValue(history());
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
  window.sessionStorage.clear();
});

it("does not reparse loaded Markdown when a draft changes, scrolling reveals the latest button, or a tool expands", async () => {
  show();
  await screen.findByText("Native answer 19");
  const before = rendering.markdownCalls;
  expect(before).toBe(40);
  const details = screen.getByText("commandExecution").closest("details")!;
  fireEvent.click(screen.getByText("commandExecution"));
  expect(details.open).toBe(true);
  fireEvent.change(screen.getByRole("textbox", { name: "Message this native chat" }), { target: { value: "Next question" } });
  const log = screen.getByRole("region", { name: "Chat messages" });
  Object.defineProperty(log, "scrollHeight", { configurable: true, value: 2000 });
  Object.defineProperty(log, "clientHeight", { configurable: true, value: 500 });
  log.scrollTop = 100;
  fireEvent.scroll(log);
  expect(screen.getByRole("button", { name: "Jump to latest" })).toBeInTheDocument();
  expect(rendering.markdownCalls).toBe(before);
  expect(details.open).toBe(true);
  expect(backend.getExternalChatHistory).toHaveBeenCalledTimes(1);
});

it("reparses only an updated native message and preserves tool updates, truncation and turn errors", async () => {
  const initial = history();
  backend.getExternalChatHistory.mockResolvedValue(initial);
  const client = show();
  await screen.findByText("Native answer 19");
  const before = rendering.markdownCalls;
  const updated = structuredClone(initial);
  updated.turns[19]!.items[1]!.text = "Updated native answer";
  updated.turns[19]!.items[1]!.truncated = true;
  updated.turns[19]!.error = "Native turn error";
  updated.turns[0]!.items[2]!.text = "Updated native tool output";
  updated.turns[0]!.items[2]!.truncated = true;
  backend.getExternalChatHistory.mockResolvedValue(updated);
  await act(async () => { await client.invalidateQueries({ queryKey: externalChatKeys.history("ws", "rt", "source", "thread") }); });
  expect(await screen.findByText("Updated native answer")).toBeInTheDocument();
  expect(screen.getByText("Updated native tool output")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("Native turn error");
  expect(screen.getAllByText(enChat.external.truncated)).toHaveLength(2);
  expect(rendering.markdownCalls - before).toBe(1);
});

it("keeps request Markdown stable while the user types an answer", async () => {
  const value = history();
  value.requests = [{ id: "request", thread_id: "thread", turn_id: "turn-19", kind: "user_input", text: "**Native question**", questions: [{ id: "path", header: "Path", question: "Which path should be used?" }] }];
  backend.getExternalChatHistory.mockResolvedValue(value);
  show();
  await screen.findByText("Native question");
  const before = rendering.markdownCalls;
  fireEvent.change(screen.getByRole("textbox", { name: "Which path should be used?" }), { target: { value: "/work/choice" } });
  expect(screen.getByRole("textbox", { name: "Which path should be used?" })).toHaveValue("/work/choice");
  expect(rendering.markdownCalls).toBe(before);
});

it("keeps the newest copy of a repeated item ID within a single native turn", async () => {
  const value = history();
  value.turns[0]!.items.push({ ...value.turns[0]!.items[1]!, text: "Corrected native answer" });
  backend.getExternalChatHistory.mockResolvedValue(value);
  show();
  await screen.findByText("Corrected native answer");
  expect(screen.queryByText("Native answer 0")).not.toBeInTheDocument();
  expect(screen.getAllByText("Corrected native answer")).toHaveLength(1);
  expect(rendering.markdownCalls).toBe(40);
});

it("updates translated truncation labels inside memoized turns when the locale changes", async () => {
  const value = history();
  value.turns[0]!.items[1]!.truncated = true;
  backend.getExternalChatHistory.mockResolvedValue(value);
  show(<LanguageSwitch />);
  await screen.findByText(enChat.external.truncated);
  const before = rendering.markdownCalls;
  fireEvent.click(screen.getByRole("button", { name: "Switch language" }));
  await waitFor(() => expect(screen.getByText(jaChat.external.truncated)).toBeInTheDocument());
  expect(rendering.markdownCalls).toBe(before);
});
