import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { DEFAULT_SYSTEM_PROMPT_CONTENT, MAX_SYSTEM_PROMPT_CODE_POINTS, normalizeSystemPromptContent, serializeSystemPromptContent } from "../../../packages/contracts/src/system-prompt-policy.js";
import { CURRENT_SYSTEM_PROMPT_DEFAULT, LEGACY_BASELINE_DEFAULT_REVISION, hashSystemPromptContent, requiresPromptPolicyCapability } from "../../../packages/shared/src/system-prompt-policy-hash.js";
import { CODE_DELIVERY_PROTOCOL } from "../../../packages/contracts/src/remi-rules.js";
import { CHAT_ARTIFACT_DELIVERY_PROTOCOL, ISSUE_ARTIFACT_DELIVERY_PROTOCOL } from "../../../packages/contracts/src/artifact-delivery.js";

const empty = { common: "", code_delivery: "", chat_delivery: "", issue_delivery: "", finishing: "" };

describe("workspace System Prompt contract", () => {
  test("normalizes newlines, preserves intentional empty slots and treats templates as text", () => {
    expect(normalizeSystemPromptContent({ ...empty, common: "{{id}}\r\n<script>$HOME</script>\r中文" })).toEqual({ ...empty, common: "{{id}}\n<script>$HOME</script>\n中文" });
    expect(normalizeSystemPromptContent(empty)).toEqual(empty);
  });

  test("validates complete slots and Unicode code point budget", () => {
    expect(() => normalizeSystemPromptContent({ common: "x" })).toThrow();
    expect(() => normalizeSystemPromptContent({ ...empty, extra: "" })).toThrow();
    expect(() => normalizeSystemPromptContent({ ...empty, common: null })).toThrow();
    expect(() => normalizeSystemPromptContent({ ...empty, common: "\uD800" })).toThrow();
    expect(() => normalizeSystemPromptContent({ ...empty, common: "\0" })).toThrow();
    expect(normalizeSystemPromptContent({ ...empty, common: "😀".repeat(MAX_SYSTEM_PROMPT_CODE_POINTS) }).common.length).toBe(16_000);
    expect(() => normalizeSystemPromptContent({ ...empty, common: "😀".repeat(MAX_SYSTEM_PROMPT_CODE_POINTS + 1) })).toThrow();
  });

  test("hash is canonical and frozen legacy baseline detects later default upgrades", () => {
    const reordered = Object.fromEntries(Object.entries(DEFAULT_SYSTEM_PROMPT_CONTENT).reverse()) as typeof empty;
    expect(hashSystemPromptContent(reordered)).toBe(CURRENT_SYSTEM_PROMPT_DEFAULT.contentHash);
    expect(CURRENT_SYSTEM_PROMPT_DEFAULT.revision).toBe(createHash("sha256").update(serializeSystemPromptContent(DEFAULT_SYSTEM_PROMPT_CONTENT)).digest("hex"));
    expect(CURRENT_SYSTEM_PROMPT_DEFAULT.revision).not.toBe(LEGACY_BASELINE_DEFAULT_REVISION);
    expect(requiresPromptPolicyCapability("default", LEGACY_BASELINE_DEFAULT_REVISION)).toBe(false);
    expect(requiresPromptPolicyCapability("custom", LEGACY_BASELINE_DEFAULT_REVISION)).toBe(true);
    expect(requiresPromptPolicyCapability("default", hashSystemPromptContent({ ...empty, common: "new platform behavior" }))).toBe(true);
  });

  test("protected blocks do not reimpose editable behavior", () => {
    expect(CODE_DELIVERY_PROTOCOL).toContain("requires explicit user authorization");
    expect(CODE_DELIVERY_PROTOCOL).not.toContain("Push the working branch");
    expect(CODE_DELIVERY_PROTOCOL).not.toContain("Creating a PR/MR does not require approval");
    expect(CHAT_ARTIFACT_DELIVERY_PROTOCOL).toContain("configuration containing secrets");
    expect(CHAT_ARTIFACT_DELIVERY_PROTOCOL).not.toContain("Do not attach repository source code");
    expect(CHAT_ARTIFACT_DELIVERY_PROTOCOL).not.toContain("Attach files the user explicitly requested");
    expect(ISSUE_ARTIFACT_DELIVERY_PROTOCOL).not.toContain("Short diagrams may go");
  });
});
