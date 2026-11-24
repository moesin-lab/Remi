import { z } from "zod";
import { BooleanWithDefaultSchema, OptionalBooleanSchema, OptionalStringSchema } from "./primitives";

export interface AppConfigResponse {
  cdn_domain: string;
  allow_signup: boolean;
  google_client_id?: string;
  posthog_key?: string;
  posthog_host?: string;
  analytics_environment?: string;
  daemon_server_url?: string;
  workspace_creation_disabled?: boolean;
  /**
   * Read-only primary security activation flag reported by `GET /api/config`.
   * Only an explicit `false` means JWT registration is disabled; `true` or
   * `undefined` (missing/unknown/malformed) must never default to `false`.
   */
  jwt_registration_required?: boolean;
}

export const AppConfigSchema = z.object({
  cdn_domain: z.string().default(""),
  allow_signup: BooleanWithDefaultSchema(true),
  google_client_id: OptionalStringSchema,
  posthog_key: OptionalStringSchema,
  posthog_host: OptionalStringSchema,
  analytics_environment: OptionalStringSchema,
  daemon_server_url: OptionalStringSchema,
  workspace_creation_disabled: BooleanWithDefaultSchema(false).optional(),
  jwt_registration_required: OptionalBooleanSchema,
}).loose();

export const EMPTY_APP_CONFIG: AppConfigResponse = {
  cdn_domain: "",
  allow_signup: true,
  google_client_id: "",
  daemon_server_url: "",
  workspace_creation_disabled: false,
};
