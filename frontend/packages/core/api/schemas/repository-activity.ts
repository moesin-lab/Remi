import { z } from "zod";
import type { RepositoryActivityItem, RepositoryActivityResponse } from "@multiremi/contracts";

const text = z.string().nullish().transform((value) => value ?? null);
const id = z.string().min(1);
const item = z.object({
  task_id: id, status: id, relation: id,
  agent: z.object({ id, name: text }).nullish(),
  issue: z.object({ id, key: text, title: text }).nullish(),
  issue_session: z.object({ id, title: text }).nullish(),
  attempt: z.number().int().positive().default(1), created_at: text, started_at: text, ended_at: text,
  progress_summary: text, wait_reason: text, failure_reason: text, error_summary: text,
  worktree: z.object({ branch: text, status: text }).nullish(),
  change_requests: z.array(z.object({ id, number: z.number().int().nullable(), state: id, url: text })).default([]),
  change_request_count: z.number().int().nonnegative().default(0),
} satisfies Record<keyof RepositoryActivityItem, z.ZodType>);

export const activityResponseSchema = z.object({
  items: z.array(item), next_cursor: id.nullable(), has_more: z.boolean(), as_of: text,
} satisfies Record<keyof RepositoryActivityResponse, z.ZodType>).refine((page) => page.has_more === Boolean(page.next_cursor));

export type ActivityPage = z.output<typeof activityResponseSchema>;
