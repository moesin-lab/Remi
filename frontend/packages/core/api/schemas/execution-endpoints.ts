import { z } from "zod";

export const EndpointModelSchema = z.object({ id: z.string(), name: z.string().optional(),
  context_window: z.number().optional(), max_output_tokens: z.number().optional(), source: z.enum(["manual", "discovered"]).optional() });
export const EndpointOptionsSchema = z.object({
  fetch_models: z.boolean().optional(), models_url: z.string().optional(),
  manual_models: z.array(EndpointModelSchema).optional(), headers: z.record(z.string(), z.string()).optional(),
  timeout_ms: z.number().optional(),
}).strict();
export const EndpointConnectionSchema = z.object({
  base_url: z.string(),
  protocols: z.array(z.enum(["openai-responses", "openai-chat-completions", "anthropic-messages", "google-generative"])).min(1),
  protocol_paths: z.record(z.string(), z.string()).optional(),
  protocol_urls: z.record(z.string(), z.string()).optional(),
  options: EndpointOptionsSchema.optional(),
  auth_mode: z.enum(["api_key", "env"]),
  env_key: z.string(),
  auth_header: z.enum(["bearer", "x-api-key"]),
  credential_id: z.string().optional(),
}).strict();
export const ExecutionEndpointSchema = z.object({
  id: z.string(), workspace_id: z.string(), name: z.string(), revision: z.number().int(),
  connection: EndpointConnectionSchema, created_at: z.string(), updated_at: z.string(),
});
export const ExecutionEndpointListSchema = z.object({ endpoints: z.array(ExecutionEndpointSchema) });
export const ExecutionEndpointResponseSchema = z.object({ endpoint: ExecutionEndpointSchema });
export type ExecutionEndpoint = z.infer<typeof ExecutionEndpointSchema>;
export type ExecutionEndpointInput = Pick<ExecutionEndpoint, "name" | "connection"> & { api_key?: string };
export const EndpointProbeSchema = z.object({
  protocol: z.string(), operation: z.enum(["models", "detect", "test"]), state: z.enum(["ok", "recognized", "error", "manual"]),
  url: z.string(), http_status: z.number().nullable(), duration_ms: z.number(), models: z.array(EndpointModelSchema),
  error_code: z.string().optional(), message: z.string().optional(), model: z.string().optional(),
});
export const EndpointInspectionSchema = z.object({
  inspection: z.object({ checked_at: z.string(), location: z.literal("server"), results: z.array(EndpointProbeSchema) }),
  persisted: z.boolean(),
});
export type EndpointInspectionResponse = z.infer<typeof EndpointInspectionSchema>;
export const EndpointCatalogsSchema = z.object({ catalogs: z.array(z.object({
  protocol: z.string(), revision: z.number(), last_checked_at: z.string(), last_success_at: z.string().nullable(),
  models_revision: z.number().nullable(), models: z.array(EndpointModelSchema), error_code: z.string().nullable(),
  message: z.string().nullable(), state: z.string(), http_status: z.number().nullable(), duration_ms: z.number(),
})) });
export type EndpointCatalogs = z.infer<typeof EndpointCatalogsSchema>;
