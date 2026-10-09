"use client";

import { Suspense, useMemo } from "react";
import { CoreProvider } from "@multiremi/core/platform";
import { api } from "@multiremi/core/api";
import { createBrowserCookieLocaleAdapter } from "@multiremi/core/i18n/browser";
import type { LocaleResources, SupportedLocale } from "@multiremi/core/i18n";
import packageJson from "../package.json";
import { WebNavigationProvider } from "@/platform/navigation";
import {
  setLoggedInCookie,
  clearLoggedInCookie,
} from "@/features/auth/auth-cookie";
import { PageviewTracker } from "./pageview-tracker";
import { ReplicaEnvProvider } from "@multiremi/core/platform/replica-env";
import { WebRuntimeContext } from "./web-runtime";
import type { PublicWebRuntime } from "../config/public-runtime";
import { HydrationTimeProvider } from "@multiremi/views/i18n";

const replicaEnv = { createWorker: () => new Worker(new URL("../features/issues/replica-worker.ts", import.meta.url), { type: "module" }) };

// Derive WebSocket URL from the page origin so self-hosted / LAN deployments
// work without explicit NEXT_PUBLIC_WS_URL.  The Next.js rewrite rule
// (/ws → backend) handles proxying.
function deriveWsUrl(runtimeUrl?: string): string | undefined {
  if (runtimeUrl) return runtimeUrl;
  if (process.env.NEXT_PUBLIC_WS_URL) return process.env.NEXT_PUBLIC_WS_URL;
  if (typeof window === "undefined") return undefined;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

// The selected application supplies its runtime version. Older deployments and
// local dev fall back to the CI build version or package.json below.
const WEB_VERSION =
  process.env.NEXT_PUBLIC_APP_VERSION || packageJson.version || "dev";

export function WebProviders({
  children,
  locale,
  resources,
  runtime,
  renderedAt,
}: {
  children: React.ReactNode;
  locale: SupportedLocale;
  resources: Record<string, LocaleResources>;
  runtime?: PublicWebRuntime;
  renderedAt: number;
}) {
  // Keep bearer-token authentication for token-based login. Password login also
  // establishes an HttpOnly browser session, which the Web logout hook clears.
  const cookieAuth = false;
  // Stable identity reference so downstream effects keyed on it don't see a
  // new object on every parent render.
  const identity = useMemo(
    () => ({ platform: "web", version: runtime?.version || WEB_VERSION }),
    [runtime?.version],
  );
  const localeAdapter = useMemo(() => createBrowserCookieLocaleAdapter(), []);
  return (
    <WebRuntimeContext.Provider value={runtime}>
      <CoreProvider
        apiBaseUrl={runtime?.apiUrl ?? process.env.NEXT_PUBLIC_API_URL}
        wsUrl={deriveWsUrl(runtime?.wsUrl)}
        cookieAuth={cookieAuth}
        onLogin={setLoggedInCookie}
        onLogout={() => {
          clearLoggedInCookie();
          // The token-mode store has already cleared its bearer token. Include
          // browser cookies so the server revokes this session and expires the
          // HttpOnly cookie; native token-only clients keep their existing flow.
          void api.logout().catch(() => {});
        }}
        identity={identity}
        locale={locale}
        resources={resources}
        localeAdapter={localeAdapter}
      >
        {/* Suspense boundary is required by Next.js for useSearchParams in
            a client component mounted this high in the tree. */}
        <Suspense fallback={null}>
          <PageviewTracker />
        </Suspense>
        <ReplicaEnvProvider env={replicaEnv}>
          <HydrationTimeProvider now={renderedAt}>
            <WebNavigationProvider>{children}</WebNavigationProvider>
          </HydrationTimeProvider>
        </ReplicaEnvProvider>
      </CoreProvider>
    </WebRuntimeContext.Provider>
  );
}
