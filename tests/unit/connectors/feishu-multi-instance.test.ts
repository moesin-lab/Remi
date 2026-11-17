import { describe, expect, it } from "bun:test";
import { createFeishuClient } from "@connectors/feishu/client.js";
import { registerPendingAction, rejectPendingAction, rejectPendingActionsForChat } from "@connectors/feishu/card-actions.js";

describe("Feishu app isolation", () => {
  it("retains each app client and replaces only the rotated credential", () => {
    const a = { appId: "cli_cache_a", appSecret: "fixture-a" };
    const b = { appId: "cli_cache_b", appSecret: "fixture-b" };
    const first = createFeishuClient(a), second = createFeishuClient(b);
    expect(first).not.toBe(second);
    expect(createFeishuClient(a)).toBe(first);
    expect(createFeishuClient(b)).toBe(second);
    expect(createFeishuClient({ ...a, appSecret: "rotated" })).not.toBe(first);
    expect(createFeishuClient(b)).toBe(second);
  });

  it("cancels interaction cards in the same chat only for the calling app", () => {
    const rejected: string[] = [];
    const a = registerPendingAction(() => {}, () => rejected.push("a"), undefined, "oc_same", "a");
    const b = registerPendingAction(() => {}, () => rejected.push("b"), undefined, "oc_same", "b");
    try {
      expect(rejectPendingActionsForChat("oc_same", "cancel", "a")).toBe(1);
      expect(rejected).toEqual(["a"]);
      expect(rejectPendingActionsForChat("oc_same", "cancel", "b")).toBe(1);
      expect(rejected).toEqual(["a", "b"]);
    } finally { rejectPendingAction(a, "cleanup"); rejectPendingAction(b, "cleanup"); }
  });
});
