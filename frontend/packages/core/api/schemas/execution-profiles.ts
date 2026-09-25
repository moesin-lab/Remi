import { z } from "zod";
import { RuntimeClaudeProfileConfigSchema } from "./claude-profile";

export const ExecutionProfileSchema = z.object({
  id: z.string(), workspace_id: z.string(), name: z.string(),
  provider: z.enum(["claude", "codex"]), revision: z.number().int(),
  profile: RuntimeClaudeProfileConfigSchema.shape.profile.unwrap(),
  created_at: z.string(), updated_at: z.string(),
});
export const ExecutionProfileListSchema = z.object({ profiles: z.array(ExecutionProfileSchema) });
export const ExecutionProfileResponseSchema = z.object({ profile: ExecutionProfileSchema });
export type ExecutionProfile = z.infer<typeof ExecutionProfileSchema>;
export type ExecutionProfileInput = Pick<ExecutionProfile, "name" | "provider" | "profile"> & { api_key?: string };
export interface ExecutionGroupInput { name: string; provider: string; profile_id: string | null; runtime_ids: string[] }
