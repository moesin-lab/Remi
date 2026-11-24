/// <reference types="vite/client" />
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiClient, setApiInstance } from "@multiremi/core/api";
import { createAuthStore, registerAuthStore } from "@multiremi/core/auth";
import { I18nProvider } from "@multiremi/core/i18n/react";
import { setCurrentWorkspace } from "@multiremi/core/platform";
import { WorkspaceSlugProvider } from "@multiremi/core/paths";
import { useAgentPermissions } from "@multiremi/core/permissions";
import type { Agent } from "@multiremi/core/types";
import { CapabilityBanner } from "@multiremi/ui/components/common/capability-banner";
import { TooltipProvider } from "@multiremi/ui/components/ui/tooltip";
import { NavigationProvider } from "../../packages/views/navigation";
import { SettingsPage } from "../../packages/views/settings/components/settings-page";
import { AgentRootBadge } from "../../packages/views/agents/components/agent-root-badge";
import "../../apps/web/app/globals.css";

const params = new URLSearchParams(window.location.search);
const surface = params.get("surface") ?? "root-admin";
const initialTab = params.get("tab") ?? "profile";

const workspace = { id: "ws_root_smoke", slug: "root-smoke", name: "Root Smoke Workspace" };
const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const api = new ApiClient("");
setApiInstance(api);
setCurrentWorkspace(workspace.slug, workspace.id);

const auth = createAuthStore({ api, storage });
auth.setState({
  user: {
    id: surface === "non-root-member" ? "usr_owner_non_root" : "usr_root_human",
    name: surface === "non-root-member" ? "Workspace Owner" : "Root Operator",
    email: surface === "non-root-member" ? "owner@example.test" : "root@example.test",
    avatar_url: null,
    onboarded_at: "2026-11-24T00:00:00Z",
    onboarding_questionnaire: {},
    starter_content_state: "imported",
    language: "en",
    profile_description: "",
    timezone: "UTC",
    created_at: "2026-11-24T00:00:00Z",
    updated_at: "2026-11-24T00:00:00Z",
  },
  isLoading: false,
});
registerAuthStore(auth);

const client = new QueryClient({
  defaultOptions: {
    queries: { retry: false },
    mutations: { retry: false },
  },
});
client.setQueryData(["workspaces", "list"], [workspace]);

const resources = Object.fromEntries(
  Object.entries(
    import.meta.glob<Record<string, unknown>>("../../packages/views/locales/en/*.json", {
      eager: true,
      import: "default",
    }),
  ).map(([path, value]) => [path.split("/").at(-1)!.replace(".json", ""), value]),
);

const protectedRootAgent: Agent = {
  id: "agt_root_worker",
  name: "Root Worker Agent",
  description: "Synthetic root agent fixture",
  avatar_url: null,
  workspace_id: workspace.id,
  owner_id: "usr_owner_non_root",
  visibility: "workspace",
  role: "normal",
  provider: "codex",
  status: "idle",
  runtime_mode: "local",
  runtime_id: "rt_trusted_1",
  runtime_config: {},
  custom_args: [],
  max_concurrent_tasks: 1,
  model: "gpt-5",
  skills: [],
  instructions: "Synthetic root agent fixture",
  root: {
    granted: true,
    effective: true,
    grant_id: "rgr_existing_1",
    generation: 2,
    scope: "system",
    reason_code: "effective",
    expires_at: null,
    revoked_at: null,
  },
  created_at: "2026-11-24T00:00:00Z",
  updated_at: "2026-11-24T00:00:00Z",
  archived_at: null,
  archived_by: null,
};

function ProtectedAgentSurface() {
  const { canEdit } = useAgentPermissions(protectedRootAgent, workspace.id);
  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6" data-testid="protected-agent-surface">
      <div className="flex items-center gap-2">
        <h1 className="text-base font-semibold">{protectedRootAgent.name}</h1>
        <span data-testid="agent-role-badge" className="rounded bg-muted px-2 py-0.5 text-xs">
          {protectedRootAgent.role}
        </span>
        <AgentRootBadge root={protectedRootAgent.root} />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Attempt-ineligible preview:</span>
        <AgentRootBadge
          root={{
            granted: true,
            effective: false,
            grant_id: "rgr_existing_1",
            generation: 2,
            scope: "system",
            reason_code: "attempt_not_eligible",
            expires_at: null,
            revoked_at: null,
          }}
        />
      </div>
      {!canEdit.allowed && (
        <CapabilityBanner
          reason={canEdit.reason}
          resource="agent"
        />
      )}
      <button
        type="button"
        data-testid="agent-edit-button"
        disabled={!canEdit.allowed}
        className="rounded border px-3 py-1.5 text-xs disabled:opacity-50"
      >
        Edit agent execution
      </button>
    </main>
  );
}

function App() {
  const [search, setSearch] = useState(() => {
    const next = new URLSearchParams(window.location.search);
    if (initialTab) next.set("tab", initialTab);
    return next;
  });

  const nav = {
    pathname: "/root-smoke/settings",
    searchParams: search,
    push: (url: string) => {
      const parsed = new URL(url, window.location.origin);
      setSearch(new URLSearchParams(parsed.search));
    },
    replace: (url: string) => {
      const parsed = new URL(url, window.location.origin);
      setSearch(new URLSearchParams(parsed.search));
    },
    back: () => {},
    getShareableUrl: (path: string) => window.location.origin + path,
  };

  return (
    <QueryClientProvider client={client}>
      <I18nProvider locale="en" resources={{ en: resources }}>
        <TooltipProvider>
          <WorkspaceSlugProvider slug={workspace.slug}>
            <NavigationProvider value={nav}>
              {surface === "protected-agent" ? (
                <ProtectedAgentSurface />
              ) : (
                <div className="min-h-screen bg-background text-foreground">
                  <SettingsPage />
                </div>
              )}
            </NavigationProvider>
          </WorkspaceSlugProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
