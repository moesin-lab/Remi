import { createHash } from "node:crypto";
import { DEFAULT_SYSTEM_PROMPT_CONTENT, serializeSystemPromptContent, type SystemPromptContent, type SystemPromptDefault, type SystemPromptMode } from "./system-prompt-policy.js";

/** Server/daemon helper kept separate so browser DTO imports stay free of Node builtins. */
export function hashSystemPromptContent(content: SystemPromptContent): string {
  return createHash("sha256").update(serializeSystemPromptContent(content)).digest("hex");
}

const defaultHash = hashSystemPromptContent(DEFAULT_SYSTEM_PROMPT_CONTENT);
export const CURRENT_SYSTEM_PROMPT_DEFAULT: Readonly<SystemPromptDefault> = Object.freeze({
  revision: defaultHash,
  contentHash: defaultHash,
  content: DEFAULT_SYSTEM_PROMPT_CONTENT,
});

/** Frozen first-release equivalent behavior. Never recompute this from future defaults. */
export const LEGACY_BASELINE_DEFAULT_REVISION = "c4697354857a11995ee9c1aa05e511c991bd7cb49cec75183354c27c361f3932";

export function requiresPromptPolicyCapability(mode: SystemPromptMode, defaultRevision: string): boolean {
  return mode === "custom" || defaultRevision !== LEGACY_BASELINE_DEFAULT_REVISION;
}
