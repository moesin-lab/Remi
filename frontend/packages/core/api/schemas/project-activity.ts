import { z } from "zod";
import type { ProjectActivityItem, ProjectActivityResponse, ProjectActivitySummary } from "@multiremi/contracts";

const id = z.string().min(1);
const timestamp = z.iso.datetime({ offset: true }).nullish().catch(null).transform((value) => value ?? null);
const step = z.number().int().min(0).max(1_000_000);
const summary = z.union([
  z.object({ code: z.literal("step_progress"), step, total: step.min(1) }).refine((value) => value.step <= value.total),
  z.object({ code: z.enum(["queued", "dispatched", "needs_directory", "needs_human", "completed", "cancelled", "context_overflow", "offer_too_large"]) }),
]).nullable().catch(null) satisfies z.ZodType<ProjectActivitySummary | null>;

const summaryStatus = {
  queued: "queued", dispatched: "dispatched", needs_directory: "waiting_local_directory", needs_human: "awaiting_human",
  step_progress: "running", completed: "completed", cancelled: "cancelled", context_overflow: "failed", offer_too_large: "failed",
} satisfies Record<ProjectActivitySummary["code"], ProjectActivityItem["status"]>;

const item = z.object({
  turn_id: id, attempt_id: id, attempt_no: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), status: id,
  agent: z.object({ id, name: z.string() }), issue: z.object({ id, key: z.string(), title: z.string() }),
  issue_session: z.object({ id, title: z.string() }).nullable(), created_at: timestamp, updated_at: timestamp,
  started_at: timestamp, ended_at: timestamp, public_summary: summary,
} satisfies Record<keyof ProjectActivityItem, z.ZodType>).transform((row) => ({
  ...row, public_summary: row.public_summary && summaryStatus[row.public_summary.code] === row.status ? row.public_summary : null,
}));

export const projectActivitySchema = z.object({
  items: z.array(item), has_more: z.boolean(), next_cursor: id.nullable(), as_of: timestamp,
} satisfies Record<keyof ProjectActivityResponse, z.ZodType>).refine((page) => page.has_more === Boolean(page.next_cursor));

export type ActivityPage = z.output<typeof projectActivitySchema>;
