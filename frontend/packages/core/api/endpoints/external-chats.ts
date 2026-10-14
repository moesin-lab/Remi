import type { ExternalChatCatalog, ExternalChatList, ExternalChatHistory, ExternalChatReceipt } from "@multiremi/contracts";
import type { HttpClient } from "../http";
import { ApiContractError, parseStrictResponse } from "../schema";
import { ExternalChatCatalogSchema, ExternalChatListSchema, ExternalChatHistorySchema, ExternalChatReceiptSchema, ExternalChatAcceptedSchema } from "../schemas/external-chats";

const root = (runtime: string, source?: string) => `/api/runtimes/${encodeURIComponent(runtime)}/external-chats${source ? `/${encodeURIComponent(source)}` : ""}`;
const threadRoot = (runtime: string, source: string, thread: string) => `${root(runtime, source)}/threads/${encodeURIComponent(thread)}`;
const pageQuery = (params: { project_id?: string; cursor?: string; limit?: number }) => {
  const query = new URLSearchParams();
  if (params.project_id) query.set("project_id", params.project_id);
  if (params.cursor) query.set("cursor", params.cursor);
  if (params.limit) query.set("limit", String(params.limit));
  return query.size ? `?${query}` : "";
};

export class ExternalChatsEndpoints {
  constructor(readonly http: HttpClient) {}

  async listExternalChatCatalog(runtime: string): Promise<ExternalChatCatalog> {
    const endpoint = root(runtime);
    return parseStrictResponse(await this.http.fetch<unknown>(endpoint), ExternalChatCatalogSchema, { endpoint });
  }

  async listExternalChats(runtime: string, source: string, params: { project_id?: string; cursor?: string; limit?: number } = {}): Promise<ExternalChatList> {
    const endpoint = `${root(runtime, source)}/threads${pageQuery(params)}`;
    const result = parseStrictResponse<ExternalChatList>(await this.http.fetch<unknown>(endpoint), ExternalChatListSchema, { endpoint });
    if (result.chats.some(chat => chat.source_id !== source)) throw new ApiContractError(endpoint, "Chat source did not match the requested source");
    return result;
  }

  async getExternalChatHistory(runtime: string, source: string, thread: string, params: { cursor?: string; limit?: number } = {}): Promise<ExternalChatHistory> {
    const endpoint = `${threadRoot(runtime, source, thread)}${pageQuery(params)}`;
    const result = parseStrictResponse<ExternalChatHistory>(await this.http.fetch<unknown>(endpoint), ExternalChatHistorySchema, { endpoint });
    if (result.chat.id !== thread || result.chat.source_id !== source || result.requests.some(request => request.thread_id !== thread)) {
      throw new ApiContractError(endpoint, "Chat identity did not match the requested thread");
    }
    return result;
  }

  async sendExternalChatMessage(runtime: string, source: string, thread: string, input: { text: string; request_id: string }): Promise<ExternalChatReceipt> {
    const endpoint = `${threadRoot(runtime, source, thread)}/messages`;
    const result = parseStrictResponse<ExternalChatReceipt>(await this.http.fetch<unknown>(endpoint, { method: "POST", body: JSON.stringify(input) }), ExternalChatReceiptSchema, { endpoint });
    if (result.thread_id !== thread || result.request_id !== input.request_id) throw new ApiContractError(endpoint, "Native send receipt did not match the request");
    return result;
  }

  async getExternalChatReceipt(runtime: string, source: string, thread: string, request: string): Promise<ExternalChatReceipt> {
    const endpoint = `${threadRoot(runtime, source, thread)}/receipts/${encodeURIComponent(request)}`;
    const result = parseStrictResponse<ExternalChatReceipt>(await this.http.fetch<unknown>(endpoint), ExternalChatReceiptSchema, { endpoint });
    if (result.thread_id !== thread || result.request_id !== request) throw new ApiContractError(endpoint, "Native receipt did not match the request");
    return result;
  }

  async interruptExternalChatTurn(runtime: string, source: string, thread: string, turn: string): Promise<{ accepted: true }> {
    const endpoint = `${threadRoot(runtime, source, thread)}/interrupt`;
    return parseStrictResponse(await this.http.fetch<unknown>(endpoint, { method: "POST", body: JSON.stringify({ turn_id: turn }) }), ExternalChatAcceptedSchema, { endpoint });
  }

  async respondExternalChatRequest(runtime: string, source: string, thread: string, request: string, input: { decision?: "accept" | "decline" | "cancel"; answers?: Record<string, string[]> }): Promise<{ accepted: true }> {
    const endpoint = `${threadRoot(runtime, source, thread)}/requests/${encodeURIComponent(request)}`;
    return parseStrictResponse(await this.http.fetch<unknown>(endpoint, { method: "POST", body: JSON.stringify(input) }), ExternalChatAcceptedSchema, { endpoint });
  }
}
