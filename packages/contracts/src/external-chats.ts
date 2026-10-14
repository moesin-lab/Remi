/** Read-only native catalogs. IDs are scoped to the registered Runtime and source. */
export interface ExternalChatProject {
  id: string;
  kind: "native" | "directory";
  name: string;
  roots: string[];
  readonly: true;
}

export interface ExternalChatSource {
  id: string;
  name: string;
  home: string;
  provider: "codex";
  connection: "live" | "isolated";
  projects: ExternalChatProject[];
}

export interface ExternalChatSummary {
  id: string;
  source_id: string;
  project_id: string | null;
  native_project_id: string | null;
  title: string;
  cwd: string;
  created_at: number;
  updated_at: number;
  status: "notLoaded" | "idle" | "active" | "systemError";
  model: string | null;
  model_provider: string;
  reasoning_effort: string | null;
  readonly: true;
}

export interface ExternalChatItem {
  id: string;
  type: string;
  role: "user" | "assistant" | "tool";
  text: string;
  truncated?: boolean;
}

export interface ExternalChatTurn {
  id: string;
  status: string;
  items: ExternalChatItem[];
  error?: string;
}

export interface ExternalChatQuestion {
  id: string;
  header: string;
  question: string;
  options?: { label: string; description: string }[];
  is_secret?: boolean;
}

/** Only requests delivered to this Remi native connection can be answered here. */
export interface ExternalChatRequest {
  id: string;
  thread_id: string;
  turn_id: string;
  kind: "command_approval" | "file_approval" | "permissions_approval" | "user_input";
  text: string;
  questions?: ExternalChatQuestion[];
}

export interface ExternalChatCatalog {
  sources: ExternalChatSource[];
  warnings: { source_id: string; code: string; message: string }[];
}

export interface ExternalChatList {
  chats: ExternalChatSummary[];
  projects: ExternalChatProject[];
  next_cursor: string | null;
}

export interface ExternalChatHistory {
  chat: ExternalChatSummary;
  turns: ExternalChatTurn[];
  next_cursor: string | null;
  requests: ExternalChatRequest[];
}

/** A lost acknowledgement never authorizes retrying the native write. */
export interface ExternalChatReceipt {
  request_id: string;
  thread_id: string;
  turn_id: string | null;
  outcome: "accepted" | "unknown";
}

export type ExternalChatOperation =
  | { operation: "catalog" }
  | { operation: "list"; source_id: string; project_id?: string; cursor?: string; limit?: number }
  | { operation: "read"; source_id: string; thread_id: string; cursor?: string; limit?: number }
  | { operation: "send"; source_id: string; thread_id: string; text: string; request_id: string }
  | { operation: "receipt"; source_id: string; thread_id: string; request_id: string }
  | { operation: "interrupt"; source_id: string; thread_id: string; turn_id: string }
  | { operation: "respond"; source_id: string; thread_id: string; request_id: string;
      decision?: "accept" | "decline" | "cancel"; answers?: Record<string, string[]> };

export type ExternalChatResult = ExternalChatCatalog | ExternalChatList | ExternalChatHistory | ExternalChatReceipt | { accepted: true };
export type ExternalChatRpcResult =
  | { ok: true; data: ExternalChatResult }
  | { ok: false; code: string; message: string; outcome?: "unknown" };

/** No provider method, filesystem path, credentials or config override crosses this boundary. */
export interface ExternalChatClient {
  request(runtimeId: string, operation: ExternalChatOperation): Promise<ExternalChatRpcResult>;
}

export const EXTERNAL_CHAT_MAX_TEXT_CHARS = 32_000;
export const EXTERNAL_CHAT_MAX_PAGE_SIZE = 50;
export const EXTERNAL_CHAT_RPC_MAX_BYTES = 900_000;
