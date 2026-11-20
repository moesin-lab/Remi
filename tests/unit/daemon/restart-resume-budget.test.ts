import { expect, test } from "bun:test";
import { fitRestartResumeToBudget } from "@multiremi/api/daemon-protocol/offer-budget.js";
import { DAEMON_FRAME_MAX_BYTES } from "@multiremi/contracts/daemon-protocol.js";

test("resume budgets large context while preserving the original canonical question", () => {
  const questions = [{ id: "original-q", body_md: "Choose an option", metadata: { answer_revision: 1 } }];
  const reply = fitRestartResumeToBudget({ turn_id: "turn", attempt_id: "attempt",
    agent: { instructions: "context ".repeat(200_000) } }, questions, 1, "runtime")!;
  expect(reply).not.toBeNull();
  expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThan(DAEMON_FRAME_MAX_BYTES);
  expect(reply.recovered_questions).toEqual(questions);
  expect(reply.generation).toBe(1);
});

test("resume rejects canonical questions that cannot fit without truncating their content", () => {
  const questions = [{ id: "original-q", body_md: "x".repeat(DAEMON_FRAME_MAX_BYTES) }];
  expect(fitRestartResumeToBudget({ turn_id: "turn" }, questions, 1, "runtime")).toBeNull();
  expect(questions[0]!.body_md).toHaveLength(DAEMON_FRAME_MAX_BYTES);
});
