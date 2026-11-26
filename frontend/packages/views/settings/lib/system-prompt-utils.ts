import { ApiError } from "@multiremi/core/api";
import type { SystemPromptSlotKey, SystemPromptSlots } from "@multiremi/core/types";

export const SYSTEM_PROMPT_SLOT_KEYS: readonly SystemPromptSlotKey[] = [
  "common",
  "code_delivery",
  "chat_delivery",
  "issue_delivery",
  "finishing",
] as const;

export const DEFAULT_MAX_SYSTEM_PROMPT_CODE_POINTS = 8_000;

export function normalizePromptText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function normalizeSystemPromptSlots(slots: SystemPromptSlots): SystemPromptSlots {
  return {
    common: normalizePromptText(slots.common),
    code_delivery: normalizePromptText(slots.code_delivery),
    chat_delivery: normalizePromptText(slots.chat_delivery),
    issue_delivery: normalizePromptText(slots.issue_delivery),
    finishing: normalizePromptText(slots.finishing),
  };
}

export function countUnicodeCodePoints(text: string): number {
  return [...normalizePromptText(text)].length;
}

export function countSystemPromptCodePoints(slots: SystemPromptSlots): number {
  let total = 0;
  for (const key of SYSTEM_PROMPT_SLOT_KEYS) {
    total += countUnicodeCodePoints(slots[key]);
  }
  return total;
}

export function areSystemPromptSlotsEqual(a: SystemPromptSlots, b: SystemPromptSlots): boolean {
  for (const key of SYSTEM_PROMPT_SLOT_KEYS) {
    if (normalizePromptText(a[key]) !== normalizePromptText(b[key])) {
      return false;
    }
  }
  return true;
}

export interface DiffLine {
  type: "unchanged" | "removed" | "added";
  text: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

export interface SlotDiff {
  slot: SystemPromptSlotKey;
  changed: boolean;
  addedCount: number;
  removedCount: number;
  lines: DiffLine[];
}

function splitLines(text: string): string[] {
  const normalized = normalizePromptText(text);
  if (normalized === "") return [];
  return normalized.split("\n");
}

const MAX_LCS_CELLS = 250_000;

/**
 * Pure line-level diff for comparing two plain-text prompt snapshots.
 * Uses classic DP LCS when within bounded matrix size, falling back to
 * whole-block remove+add for abnormally huge inputs so the UI never freezes.
 */
export function computeLineDiff(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);

  if (a.length === 0 && b.length === 0) return [];

  // Trim common prefix & suffix first to minimize DP table size.
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }

  const out: DiffLine[] = [];
  for (let i = 0; i < prefix; i++) {
    out.push({
      type: "unchanged",
      text: a[i]!,
      oldLineNumber: i + 1,
      newLineNumber: i + 1,
    });
  }

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  const m = midA.length;
  const n = midB.length;

  if (m === 0 && n > 0) {
    for (let j = 0; j < n; j++) {
      out.push({
        type: "added",
        text: midB[j]!,
        oldLineNumber: null,
        newLineNumber: prefix + j + 1,
      });
    }
  } else if (n === 0 && m > 0) {
    for (let i = 0; i < m; i++) {
      out.push({
        type: "removed",
        text: midA[i]!,
        oldLineNumber: prefix + i + 1,
        newLineNumber: null,
      });
    }
  } else if (m > 0 && n > 0) {
    if (m * n > MAX_LCS_CELLS) {
      for (let i = 0; i < m; i++) {
        out.push({
          type: "removed",
          text: midA[i]!,
          oldLineNumber: prefix + i + 1,
          newLineNumber: null,
        });
      }
      for (let j = 0; j < n; j++) {
        out.push({
          type: "added",
          text: midB[j]!,
          oldLineNumber: null,
          newLineNumber: prefix + j + 1,
        });
      }
    } else {
      const width = n + 1;
      const dp = new Int32Array((m + 1) * width);
      for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
          if (midA[i] === midB[j]) {
            dp[i * width + j] = dp[(i + 1) * width + (j + 1)]! + 1;
          } else {
            const down = dp[(i + 1) * width + j]!;
            const right = dp[i * width + (j + 1)]!;
            dp[i * width + j] = down >= right ? down : right;
          }
        }
      }

      let i = 0;
      let j = 0;
      while (i < m || j < n) {
        if (i < m && j < n && midA[i] === midB[j]) {
          out.push({
            type: "unchanged",
            text: midA[i]!,
            oldLineNumber: prefix + i + 1,
            newLineNumber: prefix + j + 1,
          });
          i++;
          j++;
        } else if (
          i < m &&
          (j === n || dp[(i + 1) * width + j]! >= dp[i * width + (j + 1)]!)
        ) {
          out.push({
            type: "removed",
            text: midA[i]!,
            oldLineNumber: prefix + i + 1,
            newLineNumber: null,
          });
          i++;
        } else {
          out.push({
            type: "added",
            text: midB[j]!,
            oldLineNumber: null,
            newLineNumber: prefix + j + 1,
          });
          j++;
        }
      }
    }
  }

  for (let k = 0; k < suffix; k++) {
    const oldIdx = a.length - suffix + k;
    const newIdx = b.length - suffix + k;
    out.push({
      type: "unchanged",
      text: a[oldIdx]!,
      oldLineNumber: oldIdx + 1,
      newLineNumber: newIdx + 1,
    });
  }

  return out;
}

export function computeSlotsDiff(before: SystemPromptSlots, after: SystemPromptSlots): SlotDiff[] {
  return SYSTEM_PROMPT_SLOT_KEYS.map((slot) => {
    const lines = computeLineDiff(before[slot], after[slot]);
    let addedCount = 0;
    let removedCount = 0;
    for (const line of lines) {
      if (line.type === "added") addedCount++;
      else if (line.type === "removed") removedCount++;
    }
    return {
      slot,
      changed: addedCount > 0 || removedCount > 0,
      addedCount,
      removedCount,
      lines,
    };
  });
}

export interface ParsedSystemPromptError {
  status: number | null;
  code: string | null;
  currentRevision: number | null;
  message: string | null;
  isRevisionConflict: boolean;
  isRequestConflict: boolean;
  isForbidden: boolean;
}

export function parseSystemPromptApiError(error: unknown): ParsedSystemPromptError {
  if (error instanceof ApiError) {
    const body =
      error.body && typeof error.body === "object"
        ? (error.body as { code?: unknown; currentRevision?: unknown; error?: unknown })
        : null;
    const code = typeof body?.code === "string" ? body.code : null;
    const currentRevision =
      typeof body?.currentRevision === "number" && Number.isInteger(body.currentRevision)
        ? body.currentRevision
        : null;
    const isRequestConflict = error.status === 409 && code === "system_prompt_request_conflict";
    const isRevisionConflict = error.status === 409 && !isRequestConflict;
    return {
      status: error.status,
      code,
      currentRevision,
      message: error.message || (typeof body?.error === "string" ? body.error : null),
      isRevisionConflict,
      isRequestConflict,
      isForbidden: error.status === 403,
    };
  }
  return {
    status: null,
    code: null,
    currentRevision: null,
    message: error instanceof Error ? error.message : null,
    isRevisionConflict: false,
    isRequestConflict: false,
    isForbidden: false,
  };
}

export function shortHash(hash: string | null | undefined, length = 8): string {
  if (!hash) return "";
  return hash.length > length ? hash.slice(0, length) : hash;
}
