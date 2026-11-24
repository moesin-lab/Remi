/** Workspace behavior text; runtime protocols and workspace appendix remain separate. */
export const SYSTEM_PROMPT_SLOTS = ["common", "code_delivery", "chat_delivery", "issue_delivery", "finishing"] as const;
export type SystemPromptSlot = typeof SYSTEM_PROMPT_SLOTS[number];
export type SystemPromptContent = Record<SystemPromptSlot, string>;
export type SystemPromptMode = "default" | "custom";
export type SystemPromptOperation = "initialize" | "edit" | "reset" | "rollback";
export const MAX_SYSTEM_PROMPT_CODE_POINTS = 8_000;

export const DEFAULT_SYSTEM_PROMPT_CONTENT: Readonly<SystemPromptContent> = Object.freeze({
  common: "",
  code_delivery: `When a task changes code:
- Push the working branch and create a GitHub pull request or Codebase merge request before reporting completion.
- Include the issue key in the PR/MR title or description so Multiremi can associate it automatically.
- Reuse an existing open PR/MR for the same source branch. Create at most one PR/MR per changed repository.
- Creating a PR/MR does not require approval.
- Return every PR/MR URL in the final result.`,
  chat_delivery: `- Attach files the user explicitly requested, reports longer than one screen, and charts. Send plain-text conclusions without attachments when no file is needed.
- Do not attach repository source code or raw logs.`,
  issue_delivery: "Short diagrams may go in the comment body as fenced Mermaid or HTML; use attachments for full pages and shareable reports.",
  finishing: "When finished, summarize what changed, how it was verified, and any remaining risks.",
});

/** Strict, complete text document. Empty strings are intentional custom content. */
export function normalizeSystemPromptContent(value: unknown): SystemPromptContent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("System Prompt content must be an object");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== SYSTEM_PROMPT_SLOTS.length || Object.keys(input).some(key => !SYSTEM_PROMPT_SLOTS.includes(key as SystemPromptSlot))) {
    throw new Error("System Prompt content must contain exactly the five supported slots");
  }
  let length = 0;
  const content = {} as SystemPromptContent;
  for (const key of SYSTEM_PROMPT_SLOTS) {
    if (typeof input[key] !== "string") throw new Error(`System Prompt slot ${key} must be text`);
    const text = (input[key] as string).replace(/\r\n?/g, "\n");
    if (text.includes("\0") || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)) {
      throw new Error(`System Prompt slot ${key} contains invalid Unicode text`);
    }
    length += Array.from(text).length;
    content[key] = text;
  }
  if (length > MAX_SYSTEM_PROMPT_CODE_POINTS) throw new Error(`System Prompt must be ${MAX_SYSTEM_PROMPT_CODE_POINTS} Unicode code points or fewer`);
  return content;
}

/** Stable serialization shared by default revision, version and execution binding hashes. */
export function serializeSystemPromptContent(content: SystemPromptContent): string {
  const normalized = normalizeSystemPromptContent(content);
  return JSON.stringify({ format: 1, content: normalized });
}

export interface SystemPromptDefault {
  revision: string;
  contentHash: string;
  content: SystemPromptContent;
}

export interface SystemPromptActor {
  type: "system" | "human";
  operatorId: string | null;
  userId: string | null;
  displayName: string | null;
}

export interface SystemPromptVersionSummary {
  id: string;
  documentId: string;
  workspaceId: string;
  versionNumber: number;
  mode: SystemPromptMode;
  operation: SystemPromptOperation;
  contentHash: string;
  baseDefaultRevision: string;
  restoredFromVersionId: string | null;
  parentVersionId: string | null;
  actor: SystemPromptActor;
  createdAt: string;
  changeNote: string | null;
  requestId: string | null;
  isCurrent: boolean;
}

export interface SystemPromptVersion extends SystemPromptVersionSummary {
  content: SystemPromptContent;
  baseDefaultSnapshot: SystemPromptContent;
}

export interface SystemPromptState {
  document: {
    id: string | null;
    key: "system-policy";
    workspaceId: string;
    revision: number;
    currentVersionId: string | null;
    mode: SystemPromptMode;
  };
  content: SystemPromptContent;
  currentDefault: SystemPromptDefault;
  baseDefault: SystemPromptDefault;
  defaultUpdated: boolean;
  limits: { maxCodePoints: number };
}

export interface SystemPromptWriteInput {
  expectedRevision: number;
  requestId: string;
  changeNote?: string;
}
export interface SystemPromptEditInput extends SystemPromptWriteInput {
  content: SystemPromptContent;
  baseDefaultRevision?: string;
}
export interface SystemPromptRestoreInput extends SystemPromptWriteInput { versionId: string }
export interface SystemPromptWriteResult extends SystemPromptState { version: SystemPromptVersion; replayed: boolean }
export interface SystemPromptVersionList { versions: SystemPromptVersionSummary[]; nextCursor: string | null }

/** Frozen in the claim transaction; new claims resolve default mode from the server catalog. */
export interface SystemPromptPolicyBinding {
  format: 1;
  workspaceId: string;
  documentId: string | null;
  versionId: string | null;
  versionNumber: number;
  mode: SystemPromptMode;
  defaultRevision: string;
  content: SystemPromptContent;
  contentHash: string;
  legacyCompatible: boolean;
}
