/// <reference types="vite/client" />
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { ApiClient, setApiInstance } from "@multiremi/core/api";
import { createAuthStore, registerAuthStore } from "@multiremi/core/auth";
import { createChatStore, registerChatStore } from "@multiremi/core/chat";
import { issueSessionsOptions } from "@multiremi/core/issues/queries";
import { I18nProvider } from "@multiremi/core/i18n/react";
import { setCurrentWorkspace } from "@multiremi/core/platform";
import { ReplicaEnvProvider } from "@multiremi/core/platform/replica-env";
import { WorkspaceSlugProvider } from "@multiremi/core/paths";
import { WSProvider } from "@multiremi/core/realtime";
import { NavigationProvider } from "../../packages/views/navigation";
import { ChatWindow } from "../../packages/views/chat/components/chat-window";
import { NewSessionDialog } from "../../packages/views/issues/components/issue-session-bar";
import { IssueSessionList } from "../../packages/views/issues/components/issue-session-list";
import { NoLinkedSessions } from "../../packages/views/issues/components/timeline-states";
import "../../apps/web/app/globals.css";

const workspace = { id: "ws_smoke", slug: "session-smoke", name: "Session smoke" };
const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const api = new ApiClient("");
setApiInstance(api);
setCurrentWorkspace(workspace.slug, workspace.id);
const auth = createAuthStore({ api, storage });
auth.setState({ user: {
  id: "usr_smoke", name: "Browser smoke", email: "browser@example.test", avatar_url: null,
  onboarded_at: "2026-10-08T00:00:00Z", onboarding_questionnaire: {}, starter_content_state: "imported",
  language: "en", profile_description: "", timezone: "UTC", created_at: "2026-10-08T00:00:00Z", updated_at: "2026-10-08T00:00:00Z",
}, isLoading: false });
registerAuthStore(auth);
const chat = createChatStore({ storage });
chat.getState().setActiveSession("chat_smoke");
chat.getState().setOpen(true);
registerChatStore(chat);
const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
client.setQueryData(["workspaces", "list"], [workspace]);
const resources = Object.fromEntries(Object.entries(import.meta.glob<Record<string, unknown>>("../../packages/views/locales/en/*.json", {
  eager: true, import: "default",
})).map(([path, value]) => [path.split("/").at(-1)!.replace(".json", ""), value]));
const surface = new URLSearchParams(window.location.search).get("surface") ?? "issue-empty";

function IssueSurface() {
  const issueId = surface === "issue-linked" ? "iss_smoke_linked" : "iss_smoke_empty";
  const { data: sessions = [] } = useQuery(issueSessionsOptions(issueId));
  const [selected, setSelected] = useState("");
  const [open, setOpen] = useState(false);
  return <main className="mx-auto flex h-screen max-w-4xl border-x">
    <IssueSessionList issueId={issueId} sessions={sessions} selectedSessionId={selected} agents={[]} onSelectSession={setSelected} />
    <section className="flex-1 p-5">
      <h1>Issue Session fixture</h1>
      <output data-testid="selected-session">{selected}</output>
      {sessions.length === 0 && <NoLinkedSessions onCreate={() => setOpen(true)} />}
      <NewSessionDialog issueId={issueId} sessions={sessions} open={open} onOpenChange={setOpen} onCreated={setSelected} />
    </section>
  </main>;
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}>
    <I18nProvider locale="en" resources={{ en: resources }}>
      <WorkspaceSlugProvider slug={workspace.slug}>
        <NavigationProvider value={{ pathname: "/session-smoke/chat/chat_smoke", searchParams: new URLSearchParams(),
          push: () => {}, replace: () => {}, back: () => {}, getShareableUrl: path => window.location.origin + path }}>
          {/* Synthetic storage has no token, so WSProvider never opens a socket. The real log reader uses HTTP. */}
          <WSProvider wsUrl="ws://127.0.0.1/fixture-unused" authStore={auth} storage={storage}>
            <ReplicaEnvProvider env={{ hasOpfs: false }}>
              {surface === "chat" ? <div className="h-screen"><ChatWindow presentation="page" initialSessionId="chat_smoke" /></div> : <IssueSurface />}
            </ReplicaEnvProvider>
          </WSProvider>
        </NavigationProvider>
      </WorkspaceSlugProvider>
    </I18nProvider>
  </QueryClientProvider>,
);
