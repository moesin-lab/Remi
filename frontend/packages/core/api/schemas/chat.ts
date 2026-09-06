import { z } from "zod";

export const ChatSessionSchema = z.object({
  id: z.string(), workspace_id: z.string(), creator_id: z.string(), agent_id: z.string(),
  title: z.string(), status: z.string(), has_unread: z.boolean().default(false),
  created_at: z.string(), updated_at: z.string(), runtime_workspace_id: z.string().nullable().optional(), project_id: z.string().nullable().optional(),
}).loose();
export const ChatSessionListSchema = z.array(ChatSessionSchema);
