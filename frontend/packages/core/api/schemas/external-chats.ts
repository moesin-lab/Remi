import { z } from "zod";

export const ExternalChatProjectSchema = z.object({
  id: z.string(), kind: z.string(), name: z.string(), roots: z.array(z.string()), readonly: z.literal(true),
});
const SourceSchema = z.object({
  id: z.string(), name: z.string(), home: z.string(), provider: z.literal("codex"),
  connection: z.string(), projects: z.array(ExternalChatProjectSchema),
});
const SummarySchema = z.object({
  id: z.string(), source_id: z.string(), project_id: z.string().nullable(), native_project_id: z.string().nullable(),
  title: z.string(), cwd: z.string(), created_at: z.number(), updated_at: z.number(), status: z.string(),
  model: z.string().nullable(), model_provider: z.string(), reasoning_effort: z.string().nullable(), readonly: z.literal(true),
});
const QuestionSchema = z.object({
  id: z.string(), header: z.string(), question: z.string(), is_secret: z.boolean().optional(),
  options: z.array(z.object({ label: z.string(), description: z.string() })).optional(),
});
export const ExternalChatCatalogSchema = z.object({
  sources: z.array(SourceSchema), warnings: z.array(z.object({ source_id: z.string(), code: z.string(), message: z.string() })),
});
export const ExternalChatListSchema = z.object({
  chats: z.array(SummarySchema), projects: z.array(ExternalChatProjectSchema), next_cursor: z.string().nullable(),
});
export const ExternalChatModelsSchema = z.object({
  source_id: z.string(),
  models: z.array(z.object({ id: z.string().min(1), name: z.string(), description: z.string() })),
  next_cursor: z.string().nullable(),
});
export const ExternalChatHistorySchema = z.object({
  chat: SummarySchema, next_cursor: z.string().nullable(),
  turns: z.array(z.object({
    id: z.string(), status: z.string(), error: z.string().optional(),
    items: z.array(z.object({ id: z.string(), type: z.string(), role: z.string(), text: z.string(), truncated: z.boolean().optional() })),
  })),
  requests: z.array(z.object({
    id: z.string(), thread_id: z.string(), turn_id: z.string(), kind: z.string(), text: z.string(), questions: z.array(QuestionSchema).optional(),
  })),
});
export const ExternalChatReceiptSchema = z.object({
  request_id: z.string().uuid(), thread_id: z.string(), turn_id: z.string().nullable(), outcome: z.enum(["accepted", "unknown"]),
});
export const ExternalChatAcceptedSchema = z.object({ accepted: z.literal(true) });
export const ExternalChatErrorSchema = z.object({ error: z.string(), code: z.string(), outcome: z.literal("unknown").optional() });
