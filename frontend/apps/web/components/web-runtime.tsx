'use client';

import { createContext, useContext } from 'react';
import type { PublicWebRuntime } from '../config/public-runtime';

export const WebRuntimeContext = createContext<PublicWebRuntime | undefined>(undefined);

export function useWebRuntime(): PublicWebRuntime {
  const runtime = useContext(WebRuntimeContext);
  return {
    localProfile: runtime?.localProfile ?? process.env.NEXT_PUBLIC_LOCAL_PROFILE,
    siteUrl: runtime?.siteUrl ?? process.env.NEXT_PUBLIC_SITE_URL,
    wsUrl: runtime?.wsUrl ?? process.env.NEXT_PUBLIC_WS_URL,
    apiUrl: runtime?.apiUrl ?? process.env.NEXT_PUBLIC_API_URL,
    version: runtime?.version ?? process.env.NEXT_PUBLIC_APP_VERSION,
  };
}
