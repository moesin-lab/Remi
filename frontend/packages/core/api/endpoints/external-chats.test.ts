import { afterEach, describe, expect, it, vi } from "vitest";
import { ExternalChatsEndpoints } from "./external-chats";
import { HttpClient } from "../http";
import { ApiContractError } from "../schema";

const chat = { id: "thread 1", source_id: "source&1", project_id: "native:p1", native_project_id: "p1", title: "Existing", cwd: "/work/project", created_at: 1, updated_at: 2, status: "idle", model: "original-model", model_provider: "original-provider", reasoning_effort: "high", readonly: true };
const requestId = "b2bf373c-40f9-43da-83bb-c9f14b7775ec";
const receipt = { request_id: requestId, thread_id: chat.id, turn_id: "native-turn", outcome: "accepted" };
function endpoint(body: unknown, status = 200) {
  const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })));
  vi.stubGlobal("fetch", fetch);
  return { api: new ExternalChatsEndpoints(new HttpClient("https://api.example.test")), fetch };
}
afterEach(() => vi.unstubAllGlobals());

describe("external native chat HTTP boundary", () => {
  it("reads direct catalog/list DTOs, preserving native projects and directory discovery without Remi IDs", async () => {
    const project = { id: "native:p1", kind: "native", name: "Native project", roots: ["/work/project"], readonly: true };
    const { api, fetch } = endpoint({ chats: [chat], projects: [project, { ...project, id: "directory:p2", kind: "directory" }], next_cursor: "next&1" });
    expect(await api.listExternalChats("runtime/1", chat.source_id, { project_id: project.id, cursor: "old&cursor", limit: 50 })).toMatchObject({ chats: [{ native_project_id: "p1", model: "original-model" }], projects: [{ kind: "native" }, { kind: "directory" }] });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.example.test/api/runtimes/runtime%2F1/external-chats/source%261/threads?project_id=native%3Ap1&cursor=old%26cursor&limit=50");
    await expect(endpoint({ ok: true, data: { sources: [], warnings: [] } }).api.listExternalChatCatalog("runtime")).rejects.toBeInstanceOf(ApiContractError);
  });

  it.each([
    { ...chat, source_id: "wrong" },
    { ...chat, readonly: false },
    { ...chat, native_project_id: 12 },
  ])("rejects cross-source or malformed read-only summaries", async (bad) => {
    await expect(endpoint({ chats: [bad], projects: [], next_cursor: null }).api.listExternalChats("rt", chat.source_id)).rejects.toBeInstanceOf(ApiContractError);
  });

  it("rejects history or attached requests belonging to another native thread", async () => {
    const history = { chat, turns: [], requests: [], next_cursor: null };
    await expect(endpoint({ ...history, chat: { ...chat, id: "other" } }).api.getExternalChatHistory("rt", chat.source_id, chat.id)).rejects.toBeInstanceOf(ApiContractError);
    await expect(endpoint({ ...history, requests: [{ id: "req", thread_id: "other", turn_id: "turn", kind: "command_approval", text: "approve" }] }).api.getExternalChatHistory("rt", chat.source_id, chat.id)).rejects.toBeInstanceOf(ApiContractError);
    expect(await endpoint({ ...history, chat: { ...chat, status: "future-status" } }).api.getExternalChatHistory("rt", chat.source_id, chat.id)).toMatchObject({ chat: { status: "future-status" } });
  });

  it("sends the original text and UUID once, with no model, project, cwd or Agent override", async () => {
    const { api, fetch } = endpoint(receipt, 202);
    expect(await api.sendExternalChatMessage("rt", chat.source_id, chat.id, { text: "\nOriginal question\n", request_id: requestId })).toEqual(receipt);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.example.test/api/runtimes/rt/external-chats/source%261/threads/thread%201/messages");
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual({ text: "\nOriginal question\n", request_id: requestId });
    await expect(endpoint({ ...receipt, thread_id: "wrong" }).api.sendExternalChatMessage("rt", chat.source_id, chat.id, { text: "x", request_id: requestId })).rejects.toBeInstanceOf(ApiContractError);
    await expect(endpoint({ ...receipt, request_id: "05a1f17c-c79f-4c3b-bb87-e875a0865e79" }).api.getExternalChatReceipt("rt", chat.source_id, chat.id, requestId)).rejects.toBeInstanceOf(ApiContractError);
  });

  it("reads the source's real model page and cursor without inventing availability from historical metadata", async () => {
    const page = { source_id: chat.source_id, models: [{ id: "gemini-native-id", name: "Native catalog name", description: "Source catalog description" }], next_cursor: "next&page" };
    const { api, fetch } = endpoint(page);
    expect(await api.listExternalChatModels("runtime/1", chat.source_id, { cursor: "older&cursor", limit: 50 })).toEqual(page);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.example.test/api/runtimes/runtime%2F1/external-chats/source%261/models?cursor=older%26cursor&limit=50");
    expect(fetch.mock.calls[0]?.[1].method).toBeUndefined();
  });

  it.each([
    { source_id: "other-source", models: [], next_cursor: null },
    { source_id: chat.source_id, models: [{ id: "", name: "Invalid", description: "Empty native ID" }], next_cursor: null },
    { source_id: chat.source_id, models: [{ id: "id", name: "Missing description" }], next_cursor: null },
    { source_id: chat.source_id, models: [], next_cursor: 123 },
  ])("rejects a cross-source or malformed model directory", async bad => {
    await expect(endpoint(bad).api.listExternalChatModels("rt", chat.source_id)).rejects.toBeInstanceOf(ApiContractError);
  });

  it("forwards only an explicitly selected native model alongside the unchanged text and request UUID", async () => {
    const { api, fetch } = endpoint(receipt, 202);
    await api.sendExternalChatMessage("rt", chat.source_id, chat.id, { text: "Original text", request_id: requestId, model: "aiden-native-model" });
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual({ text: "Original text", request_id: requestId, model: "aiden-native-model" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("queries an uncertain receipt and sends explicit native interrupts and request responses", async () => {
    const read = endpoint({ ...receipt, outcome: "unknown", turn_id: null });
    expect(await read.api.getExternalChatReceipt("rt", chat.source_id, chat.id, requestId)).toMatchObject({ outcome: "unknown" });
    expect(read.fetch.mock.calls[0]?.[1].method).toBeUndefined();
    const write = endpoint({ accepted: true });
    await write.api.interruptExternalChatTurn("rt", chat.source_id, chat.id, "native-turn");
    expect(JSON.parse(write.fetch.mock.calls[0]?.[1].body)).toEqual({ turn_id: "native-turn" });
    await write.api.respondExternalChatRequest("rt", chat.source_id, chat.id, "request/2", { answers: { question: ["A"] } });
    expect(JSON.parse(write.fetch.mock.calls[1]?.[1].body)).toEqual({ answers: { question: ["A"] } });
    await expect(endpoint({ accepted: false }).api.interruptExternalChatTurn("rt", chat.source_id, chat.id, "native-turn")).rejects.toBeInstanceOf(ApiContractError);
  });

  it("retains native failure outcome for receipt recovery without transport replay", async () => {
    const { api, fetch } = endpoint({ error: "Native reply lost", code: "TIMEOUT", outcome: "unknown" }, 504);
    await expect(api.sendExternalChatMessage("rt", chat.source_id, chat.id, { text: "Question", request_id: requestId })).rejects.toMatchObject({ body: { outcome: "unknown" } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
