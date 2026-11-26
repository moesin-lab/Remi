// Workspace env endpoint schemas (`/api/workspaces/:id/env`). Same leniency
// rules as the other domains: `.loose()` passes unknown fields, values default
// so an older/newer server never white-screens the settings page.
import { z } from "zod";

export const WorkspaceOperatorSchema = z.object({
  userId: z.literal("local"),
  memberId: z.string().min(1),
});

export const WorkspaceMemberSchema = z.object({
  id: z.string().min(1), workspace_id: z.string().min(1), user_id: z.string().min(1),
  role: z.enum(["owner", "admin", "member"]), name: z.string(),
  email: z.string().optional(), avatar_url: z.string().nullable(), created_at: z.string(),
}).loose();

export const WorkspaceEnvResponseSchema = z.object({
  workspace_id: z.string().default(""),
  env: z.record(z.string(), z.string()).default({}),
}).loose();

export type WorkspaceEnvResponse = z.infer<typeof WorkspaceEnvResponseSchema>;

export const EMPTY_WORKSPACE_ENV: WorkspaceEnvResponse = { workspace_id: "", env: {} };

/**
 * `/api/workspaces/:id/prompts`. Parsed strictly: the editor saves against
 * `revision`, so a body it cannot read must not become an empty prompt.
 */
export const WorkspacePromptSettingsSchema = z.object({
  prompt: z.string(),
  revision: z.number().int().nonnegative(),
  updatedAt: z.string().nullable().default(null),
  updatedBy: z.string().nullable().default(null),
}).loose();

const PromptTemplateSha256Schema = z.object({
  instructions: z.string().regex(/^[a-f0-9]{64}$/),
  input: z.string().regex(/^[a-f0-9]{64}$/),
});

export const PlatformPromptTemplatePreviewSchema = z.object({
  instructions: z.string(),
  input: z.string(),
  sha256: PromptTemplateSha256Schema,
}).loose();

export type PlatformPromptTemplatePreview = z.infer<typeof PlatformPromptTemplatePreviewSchema>;

export const EMPTY_PLATFORM_PROMPT_TEMPLATE: PlatformPromptTemplatePreview = {
  instructions: "",
  input: "",
  sha256: { instructions: "", input: "" },
};

export const SystemPromptSlotsSchema = z.object({
  common: z.string(),
  code_delivery: z.string(),
  chat_delivery: z.string(),
  issue_delivery: z.string(),
  finishing: z.string(),
}).loose();

export const SystemPromptDocumentSchema = z.object({
  id: z.string().nullable(),
  key: z.string(),
  workspaceId: z.string(),
  revision: z.number().int().nonnegative(),
  currentVersionId: z.string().nullable(),
  mode: z.string(),
}).loose();

export const SystemPromptDefaultSnapshotSchema = z.object({
  revision: z.string(),
  contentHash: z.string(),
  content: SystemPromptSlotsSchema,
}).loose();

export const SystemPromptLimitsSchema = z.object({
  maxCodePoints: z.number().int().positive(),
}).loose();

export const SystemPromptStateSchema = z.object({
  document: SystemPromptDocumentSchema,
  content: SystemPromptSlotsSchema,
  currentDefault: SystemPromptDefaultSnapshotSchema,
  baseDefault: SystemPromptDefaultSnapshotSchema,
  defaultUpdated: z.boolean(),
  limits: SystemPromptLimitsSchema,
}).loose();

export const SystemPromptActorSchema = z.object({
  type: z.string(),
  operatorId: z.string().nullable().default(null),
  userId: z.string().nullable().default(null),
  displayName: z.string().nullable().default(null),
}).loose();

export const SystemPromptVersionSummarySchema = z.object({
  id: z.string(),
  documentId: z.string(),
  workspaceId: z.string(),
  versionNumber: z.number().int().nonnegative(),
  mode: z.string(),
  operation: z.string(),
  contentHash: z.string(),
  baseDefaultRevision: z.string(),
  restoredFromVersionId: z.string().nullable().default(null),
  parentVersionId: z.string().nullable().default(null),
  actor: SystemPromptActorSchema,
  createdAt: z.string(),
  changeNote: z.string().nullable().default(null),
  requestId: z.string().nullable().default(null),
  isCurrent: z.boolean(),
}).loose();

export const SystemPromptVersionDetailSchema = SystemPromptVersionSummarySchema.extend({
  content: SystemPromptSlotsSchema,
  baseDefaultSnapshot: SystemPromptSlotsSchema.nullable().default(null),
}).loose();

export const SystemPromptVersionsPageSchema = z.object({
  versions: z.array(SystemPromptVersionSummarySchema),
  nextCursor: z.string().nullable().default(null),
}).loose();

export const SystemPromptMutationResponseSchema = SystemPromptStateSchema.extend({
  version: SystemPromptVersionDetailSchema,
  replayed: z.boolean().default(false),
}).loose();

export const SystemPromptPreviewResponseSchema = PlatformPromptTemplatePreviewSchema.extend({
  content: SystemPromptSlotsSchema,
  scenario: z.string().default("issue"),
  excludesLocalContext: z.boolean().default(true),
}).loose();

const BotMenuBehaviorSchema = z.object({
  type: z.enum(["target", "event_key", "send_message"]),
  url: z.string().optional(),
  eventKey: z.string().optional(),
  isPrimary: z.boolean().optional(),
}).loose();

const BotMenuItemSchema: z.ZodType<unknown> = z.lazy(() => z.object({
  name: z.string(),
  i18nName: z.record(z.string(), z.string()).optional(),
  icon: z.object({
    token: z.string().optional(),
    color: z.string().optional(),
    fileKey: z.string().optional(),
  }).loose().optional(),
  tag: z.string().optional(),
  behaviors: z.array(BotMenuBehaviorSchema).optional(),
  children: z.array(BotMenuItemSchema).optional(),
}).loose());

export const BotMenuConfigSchema = z.object({
  default: z.array(BotMenuItemSchema).optional(),
}).loose();

export const BotMenuResponseSchema = z.object({
  workspace_id: z.string(),
  bot_id: z.string(),
  legacy_target_count: z.number().int().nonnegative(),
  bot_menu: BotMenuConfigSchema,
}).loose();

export const BotMenuPublishResponseSchema = z.object({
  id: z.string(),
  bot_id: z.string(),
  workspace_id: z.string(),
  dry_run: z.boolean(),
  status: z.enum(["pending", "running", "completed", "failed", "timeout"]),
  result: z.object({
    defaultPublished: z.boolean(),
    userMenuCount: z.number(),
    clearedUserMenuCount: z.number().optional(),
    unresolvedLegacyTargetCount: z.number().optional(),
    dryRun: z.boolean(),
  }).loose().nullable(),
  error: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
}).loose();

export const EMPTY_BOT_MENU_RESPONSE = {
  bot_id: "default",
  legacy_target_count: 0,
  workspace_id: "",
  bot_menu: {},
};

export const EMPTY_BOT_MENU_PUBLISH_RESPONSE = {
  bot_id: "default",
  id: "",
  workspace_id: "",
  dry_run: true,
  status: "failed" as const,
  result: null,
  error: "Invalid server response",
  created_at: "",
  updated_at: "",
};

export const MagpieServiceSchema = z.object({ url: z.string().url().refine(value => /^https?:\/\//.test(value)).nullable() });
