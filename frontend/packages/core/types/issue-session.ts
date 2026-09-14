import type { AgentTask } from "./agent";

export type SessionStatus = "active" | "archived";
/** @deprecated Use `SessionStatus`. */
export type IssueSessionStatus = SessionStatus;
export type SessionParticipantType = "agent" | "member";

export interface SessionParticipant {
  id: string;
  session_id: string;
  participant_type: SessionParticipantType;
  participant_id: string;
  role: string;
  status: string;
  joined_at: string;
  updated_at: string;
}

/** Core product Session owned by a Chat; Issue linkage is optional. */
export interface Session {
  id: string;
  /** Null only for legacy Issue-owned Sessions awaiting adoption. */
  chat_id?: string | null;
  issue_id: string | null;
  workspace_id: string;
  title: string;
  status: SessionStatus;
  is_default: boolean;
  holds_workspace?: boolean;
  summary: string | null;
  created_by_type: string;
  created_by_id: string | null;
  created_at: string;
  updated_at: string;
  participants: SessionParticipant[];
}

/** @deprecated Use `Session`. */
export type IssueSession = Session;

export interface SessionEvent {
  id: string;
  session_id: string;
  seq: number;
  author_type: string;
  author_id: string | null;
  kind: string;
  body: string;
  task_id: string | null;
  source_comment_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface SessionResult {
  id: string;
  chat_id?: string | null;
  issue_id: string | null;
  source_session_id: string;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  published_by_type: string;
  published_by_id: string | null;
  created_at: string;
}

export interface CreateSessionRequest {
  chat_id: string;
  title: string;
  holds_workspace?: boolean;
}

/** @deprecated Use `CreateSessionRequest`. */
export type CreateIssueSessionRequest = CreateSessionRequest;

export interface CreateSessionTaskRequest {
  agent_id: string;
  prompt: string;
  priority?: number;
}

export interface SessionTask extends AgentTask {
  issue_session_id: string;
}

/** @deprecated Use `SessionTask`. */
export type IssueSessionTask = SessionTask;
