import { describe, expect, it } from "vitest";
import { ApiError } from "@multiremi/core/api";
import type { SystemPromptSlots } from "@multiremi/core/types";
import {
  areSystemPromptSlotsEqual,
  computeLineDiff,
  computeSlotsDiff,
  countSystemPromptCodePoints,
  countUnicodeCodePoints,
  normalizePromptText,
  parseSystemPromptApiError,
  shortHash,
} from "./system-prompt-utils";

const BASE_SLOTS: SystemPromptSlots = {
  common: "",
  code_delivery: "Push branch.\nCreate a PR.",
  chat_delivery: "Attach charts.",
  issue_delivery: "Use Mermaid for short diagrams.",
  finishing: "Summarize changes and risks.",
};

describe("system-prompt-utils", () => {
  it("normalizes CRLF/CR newlines and counts Unicode code points accurately", () => {
    expect(normalizePromptText("a\r\nb\rc")).toBe("a\nb\nc");
    // Emoji surrogate pair counts as 1 code point, CRLF counts as 1 newline
    expect(countUnicodeCodePoints("🚀\r\n中文")).toBe(4);
    expect(
      countSystemPromptCodePoints({
        common: "🚀",
        code_delivery: "a\r\nb",
        chat_delivery: "",
        issue_delivery: "中",
        finishing: "ok",
      }),
    ).toBe(1 + 3 + 0 + 1 + 2);
  });

  it("compares slots after newline normalization", () => {
    expect(
      areSystemPromptSlotsEqual(BASE_SLOTS, {
        ...BASE_SLOTS,
        code_delivery: "Push branch.\r\nCreate a PR.",
      }),
    ).toBe(true);
    expect(
      areSystemPromptSlotsEqual(BASE_SLOTS, {
        ...BASE_SLOTS,
        common: "Always reply in Chinese.",
      }),
    ).toBe(false);
  });

  it("computes accurate line-level diffs across additions, removals, and unchanged lines", () => {
    const diff = computeLineDiff("line 1\nline 2\nline 3", "line 1\nline 2 edited\nline 3\nline 4");
    expect(diff).toEqual([
      { type: "unchanged", text: "line 1", oldLineNumber: 1, newLineNumber: 1 },
      { type: "removed", text: "line 2", oldLineNumber: 2, newLineNumber: null },
      { type: "added", text: "line 2 edited", oldLineNumber: null, newLineNumber: 2 },
      { type: "unchanged", text: "line 3", oldLineNumber: 3, newLineNumber: 3 },
      { type: "added", text: "line 4", oldLineNumber: null, newLineNumber: 4 },
    ]);
  });

  it("handles empty strings cleanly in computeLineDiff", () => {
    expect(computeLineDiff("", "")).toEqual([]);
    expect(computeLineDiff("", "hello")).toEqual([
      { type: "added", text: "hello", oldLineNumber: null, newLineNumber: 1 },
    ]);
    expect(computeLineDiff("bye", "")).toEqual([
      { type: "removed", text: "bye", oldLineNumber: 1, newLineNumber: null },
    ]);
  });

  it("computes per-slot diffs and counts changed lines", () => {
    const next: SystemPromptSlots = {
      ...BASE_SLOTS,
      common: "Use concise bullet points.",
      finishing: "",
    };
    const slotDiffs = computeSlotsDiff(BASE_SLOTS, next);
    expect(slotDiffs.map((s) => ({ slot: s.slot, changed: s.changed, add: s.addedCount, del: s.removedCount }))).toEqual([
      { slot: "common", changed: true, add: 1, del: 0 },
      { slot: "code_delivery", changed: false, add: 0, del: 0 },
      { slot: "chat_delivery", changed: false, add: 0, del: 0 },
      { slot: "issue_delivery", changed: false, add: 0, del: 0 },
      { slot: "finishing", changed: true, add: 0, del: 1 },
    ]);
  });

  it("parses revision conflicts, request conflicts, and 403 errors", () => {
    const revConflict = parseSystemPromptApiError(
      new ApiError("Conflict", 409, "Conflict", {
        code: "system_prompt_conflict",
        currentRevision: 5,
        error: "Conflict",
      }),
    );
    expect(revConflict).toMatchObject({
      status: 409,
      code: "system_prompt_conflict",
      currentRevision: 5,
      isRevisionConflict: true,
      isRequestConflict: false,
      isForbidden: false,
    });

    const reqConflict = parseSystemPromptApiError(
      new ApiError("Idempotency conflict", 409, "Conflict", {
        code: "system_prompt_request_conflict",
      }),
    );
    expect(reqConflict.isRequestConflict).toBe(true);
    expect(reqConflict.isRevisionConflict).toBe(false);

    const forbidden = parseSystemPromptApiError(new ApiError("Forbidden", 403, "Forbidden"));
    expect(forbidden.isForbidden).toBe(true);
  });

  it("truncates hashes safely", () => {
    expect(shortHash("abcdef1234567890", 8)).toBe("abcdef12");
    expect(shortHash(null)).toBe("");
  });
});
