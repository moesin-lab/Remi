export interface PublicWebRuntime {
  localProfile?: string;
  siteUrl?: string;
  wsUrl?: string;
  apiUrl?: string;
  version?: string;
}

/** Explicit allowlist: only these public values may cross the RSC boundary. */
export function publicWebRuntime(env: Record<string, string | undefined>): PublicWebRuntime {
  return {
    localProfile: env.REMI_WEB_LOCAL_PROFILE,
    siteUrl: env.REMI_WEB_SITE_URL,
    wsUrl: env.REMI_WEB_WS_URL,
    apiUrl: env.REMI_WEB_API_URL,
    version: env.REMI_APPLICATION_VERSION,
  };
}
