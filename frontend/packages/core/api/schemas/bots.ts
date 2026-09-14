import { z } from "zod";

// Preserve unknown enum strings for display; required configuration fields
// must still be present so editing never silently drops a server setting.
export const BotTargetSchema = z.object({
  kind: z.string(),
  agent_id: z.string().min(1),
  runtime_id: z.string().nullable().optional(),
  project_id: z.string().nullable().optional(),
  runtime_workspace_id: z.string().nullable().optional(),
});

export const BotPlatformBindingSchema = z.object({
  id: z.string().min(1),
  platform: z.string(),
  app_id: z.string().min(1),
  domain: z.string(),
  host_runtime_id: z.string().min(1),
  enabled: z.boolean(),
  app_secret_configured: z.boolean(),
  app_secret_hint: z.string().nullable(),
  status: z.string(),
  last_error: z.string().nullable(),
  last_seen_at: z.string().nullable(),
});

export const BotRouteSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  match: z.object({
    platform_binding_ids: z.array(z.string()).optional(),
    chat_types: z.array(z.string()).optional(),
    chat_ids: z.array(z.string()).optional(),
    commands: z.array(z.string()).optional(),
  }),
  target: BotTargetSchema,
});

export const BotSchema = z.object({
  id: z.string().min(1),
  workspace_id: z.string().min(1),
  name: z.string(),
  enabled: z.boolean(),
  revision: z.number().int().nonnegative(),
  platform_bindings: z.array(BotPlatformBindingSchema),
  default_target: BotTargetSchema,
  routes: z.array(BotRouteSchema),
  allowlist_enabled: z.boolean(),
  issue_notifications: z.object({
    platform_binding_id: z.string().min(1),
    chat_id: z.string().min(1),
    project_ids: z.array(z.string()).optional(),
    target: BotTargetSchema.optional(),
  }).nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const BotSenderSchema = z.object({
  id: z.string().min(1),
  bot_id: z.string().min(1),
  platform_binding_id: z.string().min(1),
  external_id: z.string().min(1),
  display_name: z.string().nullable(),
  allowed: z.boolean(),
  first_seen_at: z.string(),
  last_seen_at: z.string(),
});

export const BotSessionSchema = z.object({
  id: z.string().min(1),
  bot_id: z.string().min(1),
  platform_binding_id: z.string().min(1),
  external_session_key: z.string(),
  target: BotTargetSchema,
  chat_session_id: z.string().min(1),
  chat_id: z.string().nullable(),
  thread_id: z.string().nullable(),
  reply_to_message_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const BotListSchema = z.object({ bots: z.array(BotSchema) });
export const BotSendersSchema = z.object({ senders: z.array(BotSenderSchema) });
export const BotSessionsSchema = z.object({ sessions: z.array(BotSessionSchema) });
export const DeleteBotResponseSchema = z.object({ deleted: z.literal(true) });
