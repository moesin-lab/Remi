import { describe, expect, it } from "bun:test";
import { turns } from "@daemon/external-chats/format.js";

describe("external Chat history display budget", () => {
  it("retains later dialogue after large tool output while keeping original order", () => {
    const result = turns([
      { id: "old", status: "completed", items: Array.from({ length: 8 }, (_, index) => ({
        id: `tool_${index}`, type: "commandExecution", command: "fixture", aggregatedOutput: "x".repeat(50_000),
      })) },
      { id: "recent", status: "completed", items: [
        { id: "question", type: "userMessage", content: [{ text: "Follow-up question" }] },
        { id: "answer", type: "agentMessage", text: "The original final reply" },
      ] },
    ]);

    expect(result[1]!.items.map(item => item.text)).toEqual(["Follow-up question", "The original final reply"]);
    expect(result[0]!.items.some(item => item.truncated)).toBe(true);
    expect(result.flatMap(turn => turn.items).reduce((total, item) => total + item.text.length, 0)).toBeLessThan(100_100);
  });

  it("retains dialogue beyond the tool item limit and explicitly marks omissions", () => {
    const result = turns([{ id: "long", status: "completed", items: [
      ...Array.from({ length: 500 }, (_, index) => ({ id: `tool_${index}`, type: "commandExecution", command: "fixture" })),
      { id: "question", type: "userMessage", content: [{ text: "Latest question" }] },
      { id: "answer", type: "agentMessage", text: "Latest answer" },
    ] }]);

    expect(result[0]!.items.filter(item => item.role !== "tool").map(item => item.id)).toEqual(["question", "answer"]);
    expect(result[0]!.items).toHaveLength(400);
    expect(result[0]!.items.at(-1)).toMatchObject({ type: "truncated", truncated: true });
  });

  it("prioritizes the newest dialogue when dialogue alone exceeds the page budget", () => {
    const result = turns(Array.from({ length: 10 }, (_, index) => ({
      id: `turn_${index}`, status: "completed", items: [{ id: `answer_${index}`, type: "agentMessage", text: String(index).repeat(40_000) }],
    })));

    expect(result.at(-1)!.items[0]).toMatchObject({ id: "answer_9", truncated: true });
    expect(result.at(-1)!.items[0]!.text).toHaveLength(32_000);
    expect(result[0]!.items[0]).toMatchObject({ type: "truncated", truncated: true });
    expect(result.flatMap(turn => turn.items).filter(item => item.type === "agentMessage").reduce((total, item) => total + item.text.length, 0)).toBe(100_000);
  });
});
