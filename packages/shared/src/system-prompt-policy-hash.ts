import { createHash } from "node:crypto";
import { LEGACY_SYSTEM_PROMPT_CONTENT } from "@multiremi/contracts/system-prompt-policy.js";
import { DEFAULT_SYSTEM_PROMPT_CONTENT, serializeSystemPromptContent, type SystemPromptContent, type SystemPromptDefault, type SystemPromptMode } from "@multiremi/contracts/system-prompt-policy.js";

/** Runtime hashing stays outside the browser-safe contracts package. */
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

const reviewedChatRevision = "ea7a6720b718feb7d1b52a28dc7a000fa4f8457a968d207310ad5debf08bf0a3";
const historicalHash = hashSystemPromptContent(LEGACY_SYSTEM_PROMPT_CONTENT);
export function canUseHistoricalChatDefault(mode: SystemPromptMode, catalog: SystemPromptDefault): boolean {
  return mode === "default" && catalog.revision === reviewedChatRevision && catalog.contentHash === reviewedChatRevision
    && hashSystemPromptContent(catalog.content) === reviewedChatRevision && historicalHash === LEGACY_BASELINE_DEFAULT_REVISION;
}

export function requiresPromptPolicyCapability(mode: SystemPromptMode, defaultRevision: string): boolean {
  return mode === "custom" || defaultRevision !== LEGACY_BASELINE_DEFAULT_REVISION;
}
