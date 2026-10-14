"use client";

import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useWorkspacePaths } from "@multiremi/core/paths";
import { runtimeListOptions } from "@multiremi/core/runtimes";
import { externalChatCatalogOptions, externalChatListOptions } from "@multiremi/core/chat";
import { Button } from "@multiremi/ui/components/ui/button";
import { AppLink, useNavigation } from "../../navigation";
import { PageHeader } from "../../layout/page-header";
import { RuntimeMemberIdentity } from "../../runtimes/components/runtime-member-identity";
import { useT } from "../../i18n";
import { ExternalChatWindow } from "./external-chat-window";
import { ExternalChatProjectPicker } from "./external-chat-project-picker";

export function ExternalChatPage() {
  const { t } = useT("chat");
  const ws = useWorkspaceId();
  const paths = useWorkspacePaths();
  const navigation = useNavigation();
  const runtimeId = navigation.searchParams.get("external_runtime") ?? "";
  const sourceId = navigation.searchParams.get("external_source") ?? "";
  const threadId = navigation.searchParams.get("external_thread") ?? "";
  const [project, setProject] = useState({ source: "", id: "" });
  const sourceKey = `${runtimeId}:${sourceId}`;
  const projectId = project.source === sourceKey ? project.id : "";
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftKey = `${ws}:${sourceKey}:${threadId}`;
  const runtimes = useQuery(runtimeListOptions(ws));
  const runtime = runtimes.data?.find(row => row.id === runtimeId);
  const online = runtime?.status === "online";
  const supported = runtime?.metadata.external_chats === 1;
  const available = online && supported;
  const catalog = useQuery(externalChatCatalogOptions(ws, runtimeId, available));
  const source = catalog.data?.sources.find(row => row.id === sourceId);
  const threads = useInfiniteQuery(externalChatListOptions(ws, runtimeId, sourceId, projectId, available && !!source));
  const projects = [...new Map([
    ...(source?.projects ?? []), ...(threads.data?.pages.flatMap(page => page.projects) ?? []),
  ].map(row => [row.id, row])).values()];
  const chats = [...new Map(threads.data?.pages.flatMap(page => page.chats).map(chat => [chat.id, chat]) ?? []).values()]
    .sort((a, b) => b.updated_at - a.updated_at);

  const choose = (nextRuntime: string, nextSource?: string, nextThread?: string) =>
    navigation.replace(paths.externalChat(nextRuntime, nextSource, nextThread));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader>
        <h1 className="text-sm font-semibold">{t(($) => $.external.title)}</h1>
        <AppLink className="ml-3 text-xs text-primary underline" href={paths.chat()}>{t(($) => $.external.switch_remi)}</AppLink>
      </PageHeader>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside aria-label={t(($) => $.external.sources)} className="max-h-72 shrink-0 space-y-3 overflow-y-auto border-b bg-sidebar p-3 md:max-h-none md:w-80 md:border-r md:border-b-0">
          <p className="text-xs text-muted-foreground">{t(($) => $.external.readonly)}</p>
          {runtimes.isPending && <p role="status">{t(($) => $.page.loading)}</p>}
          {runtimes.isError && <p role="alert">{t(($) => $.external.failed)} <Button variant="outline" onClick={() => void runtimes.refetch()}>{t(($) => $.page.retry)}</Button></p>}
          {runtimes.data?.filter(row => row.provider === "codex").map(row => (
            <button key={row.id} type="button" aria-pressed={runtimeId === row.id} className="block w-full rounded-md border p-2 text-left" onClick={() => choose(row.id)}>
              <RuntimeMemberIdentity runtime={row} runtimeId={row.id} />
            </button>
          ))}
          {runtimes.data && !runtimes.data.some(row => row.provider === "codex") && <p>{t(($) => $.external.no_runtimes)}</p>}
          {runtimeId && !runtimes.isPending && !online && <p role="status">{t(($) => $.external.offline)}</p>}
          {runtime && online && !supported && <p role="status">{t(($) => $.external.upgrade)}</p>}
          {available && catalog.isPending && <p role="status">{t(($) => $.page.loading)}</p>}
          {catalog.isError && <p role="alert">{catalog.error.message} <Button variant="outline" onClick={() => void catalog.refetch()}>{t(($) => $.page.retry)}</Button></p>}
          {catalog.data?.warnings.map(warning => <p role="status" className="break-words text-xs text-warning" key={`${warning.source_id}:${warning.code}`}>{warning.message}</p>)}
          {catalog.data?.sources.length === 0 && <p>{t(($) => $.external.no_sources)}</p>}
          {catalog.data?.sources.map(row => (
            <button type="button" className="block w-full rounded border p-2 text-left" key={row.id} aria-pressed={row.id === sourceId} onClick={() => choose(runtimeId, row.id)}>
              <span className="block break-all font-medium">{row.name}</span>
              <span className="block break-all text-xs text-muted-foreground">{row.home}</span>
            </button>
          ))}
          {sourceId && catalog.data && !source && <p role="alert">{t(($) => $.external.source_missing)}</p>}
          {source && <>
            <ExternalChatProjectPicker key={sourceKey} projects={projects} projectId={projectId} onChange={id => setProject({ source: sourceKey, id })} />
            {threads.isPending && <p role="status">{t(($) => $.page.loading)}</p>}
            {threads.isError && <p role="alert">{threads.error.message} <Button variant="outline" onClick={() => void threads.refetch()}>{t(($) => $.page.retry)}</Button></p>}
            {threads.data && chats.length === 0 && <p>{t(($) => $.external.empty)}</p>}
            {chats.map(chat => <button type="button" className="block w-full rounded p-2 text-left hover:bg-accent" key={chat.id} aria-current={chat.id === threadId ? "true" : undefined} onClick={() => choose(runtimeId, sourceId, chat.id)}>
              <span className="block break-words">{chat.title || t(($) => $.window.untitled)}</span>
              <span className="block break-all text-xs text-muted-foreground">{chat.cwd}</span>
              <time className="block text-xs text-muted-foreground" dateTime={new Date(chat.updated_at * 1_000).toISOString()}>{new Date(chat.updated_at * 1_000).toLocaleString()}</time>
            </button>)}
            {threads.hasNextPage && <Button variant="outline" disabled={threads.isFetchingNextPage} onClick={() => void threads.fetchNextPage()}>{t(($) => $.external.load_more)}</Button>}
          </>}
        </aside>
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {runtimeId && sourceId && threadId ? <ExternalChatWindow key={draftKey} ws={ws} runtime={runtimeId} source={sourceId} thread={threadId} online={available && !!source}
            draft={drafts[draftKey] ?? ""} onDraftChange={value => setDrafts(previous => ({ ...previous, [draftKey]: value }))} />
            : <p className="p-6 text-sm text-muted-foreground">{t(($) => $.external.select)}</p>}
        </main>
      </div>
    </div>
  );
}
