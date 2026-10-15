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
  const details = screen.getByText(enChat.external.activity_command).closest("details")!;
  const group = details.parentElement!.closest("details")!;
  fireEvent.click(group.querySelector("summary")!);
  fireEvent.click(screen.getByText(enChat.external.activity_command));
  expect(details.open).toBe(true);
  expect(group.open).toBe(true);
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

it("groups consecutive activity into two disclosure levels without moving dialogue or rendering empty items", async () => {
  const value = history();
  value.turns = [{ id: "turn", status: "completed", items: [
    { id: "user", type: "userMessage", role: "user", text: "Question" },
    { id: "empty-reasoning", type: "reasoning", role: "assistant", text: " \n\t" },
    { id: "command", type: "commandExecution", role: "tool", text: "git status" },
    { id: "empty-tool", type: "mcpToolCall", role: "tool", text: "" },
    { id: "tool", type: "mcpToolCall", role: "tool", text: "gateway/search\nFound results" },
    { id: "progress", type: "agentMessage", role: "assistant", text: "Progress update" },
    { id: "thinking", type: "reasoning", role: "assistant", text: "Visible reasoning summary" },
    { id: "unknown", type: "futureTool", role: "tool", text: "Future output" },
    { id: "answer", type: "agentMessage", role: "assistant", text: "Final answer" },
  ] }];
  backend.getExternalChatHistory.mockResolvedValue(value);
  show();
  await screen.findByText("Final answer");

  const section = screen.getByText("Question").closest("section")!;
  const children = [...section.children];
  expect(children.map(element => element.tagName)).toEqual(["DIV", "DETAILS", "DIV", "DETAILS", "DIV"]);
  expect(children[2]).toHaveTextContent("Progress update");
  const groups = children.filter(element => element.tagName === "DETAILS") as HTMLDetailsElement[];
  expect(groups).toHaveLength(2);
  expect(groups.every(group => !group.open)).toBe(true);
  expect(section.querySelectorAll("details details")).toHaveLength(4);
  expect(screen.getAllByText(enChat.external.activity_reasoning)).toHaveLength(1);

  const group = groups[0]!;
  const command = screen.getByText("git status");
  expect(command).not.toBeVisible();
  fireEvent.click(group.querySelector("summary")!);
  expect(command).not.toBeVisible();
  fireEvent.click(screen.getByText(enChat.external.activity_command));
  expect(command).toBeVisible();
  expect(screen.getByText(/gateway\/search/)).not.toBeVisible();
});

it("omits empty turns but retains truncation notices and turn errors even without text", async () => {
  const value = history();
  value.turns = [
    { id: "empty", status: "completed", items: [
      { id: "reasoning", type: "reasoning", role: "assistant", text: " \n" },
      { id: "message", type: "agentMessage", role: "assistant", text: "" },
    ] },
    { id: "failed", status: "failed", items: [], error: "Native failure" },
    { id: "cut", status: "completed", items: [{ id: "cut-item", type: "commandExecution", role: "tool", text: "", truncated: true }] },
  ];
  backend.getExternalChatHistory.mockResolvedValue(value);
  show();
  await screen.findByRole("alert");
  const region = screen.getByRole("region", { name: "Chat messages" });
  expect(region.querySelectorAll("section")).toHaveLength(2);
  expect(region.querySelectorAll("details")).toHaveLength(2);
  expect(region.querySelector("pre")).toBeNull();
  expect(screen.queryByText(enChat.external.activity_reasoning)).not.toBeInTheDocument();
  expect(screen.getByText(enChat.external.truncated)).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("Native failure");
});

it("keeps both disclosure levels open while polling updates and appends activity", async () => {
  const initial = history();
  initial.turns[0]!.items.splice(2, 0, { id: "initially-empty", type: "reasoning", role: "assistant", text: "" });
  backend.getExternalChatHistory.mockResolvedValue(initial);
  const client = show();
  await screen.findByText("Native answer 19");
  const details = screen.getByText(enChat.external.activity_command).closest("details")!;
  const group = details.parentElement!.closest("details")!;
  fireEvent.click(group.querySelector("summary")!);
  fireEvent.click(details.querySelector("summary")!);

  const updated = structuredClone(initial);
  updated.turns[0]!.items[2]!.text = "New reasoning summary";
  updated.turns[0]!.items[3]!.text = "Updated command output";
  updated.turns[0]!.items.push({ id: "next-tool", type: "mcpToolCall", role: "tool", text: "Next tool output" });
  backend.getExternalChatHistory.mockResolvedValue(updated);
  await act(async () => { await client.invalidateQueries({ queryKey: externalChatKeys.history("ws", "rt", "source", "thread") }); });

  await screen.findByText("Updated command output");
  expect(group.open).toBe(true);
  expect(details.open).toBe(true);
  expect(screen.getByText("Updated command output")).toBeVisible();
  expect(screen.getByText("Updated command output").closest("details")).toBe(details);
  expect(group.querySelectorAll("details")).toHaveLength(3);
});

it("does not request native image paths from the web origin and still renders absolute web images", async () => {
  const value = history();
  value.turns[0]!.items[1]!.text = [
    "![Local screenshot](/tmp/native-image.png)",
    "![Relative screenshot](./screenshots/image.png)",
    '<img src="/Users/example/image.png" alt="HTML screenshot">',
    "![Remote screenshot](https://example.com/image.png)",
  ].join("\n\n");
  value.requests = [{ id: "approval", thread_id: "thread", turn_id: "turn-0", kind: "command_approval", text: "![Approval screenshot](/tmp/approval.png)" }];
  backend.getExternalChatHistory.mockResolvedValue(value);
  show();
  await screen.findByText("Local screenshot");

  expect(screen.getAllByRole("img")).toHaveLength(1);
  expect(screen.getByRole("img", { name: "Remote screenshot" })).toHaveAttribute("src", "https://example.com/image.png");
  expect(screen.getAllByText(enChat.external.local_image_hint)).toHaveLength(4);
  expect(screen.queryByText("/tmp/native-image.png")).not.toBeInTheDocument();
  expect(screen.queryByText("./screenshots/image.png")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Local screenshot" }));
  expect(await screen.findByText("/tmp/native-image.png")).toBeVisible();
});
