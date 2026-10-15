"use client";

import { useEffect, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ArrowLeft, MessageSquare, Monitor } from "lucide-react";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useWorkspacePaths } from "@multiremi/core/paths";
import { runtimeListOptions } from "@multiremi/core/runtimes";
import { externalChatCatalogOptions, externalChatListOptions } from "@multiremi/core/chat";
import { Button } from "@multiremi/ui/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@multiremi/ui/components/ui/select";
import { cn } from "@multiremi/ui/lib/utils";
import { useNavigation } from "../../navigation";
import { PageHeader } from "../../layout/page-header";
import { machineTitle } from "../../runtimes/components/runtime-machines";
import { useT } from "../../i18n";
import { ChatModeTabs } from "./chat-mode-tabs";
import { ExternalChatWindow } from "./external-chat-window";
import { ExternalChatProjectPicker } from "./external-chat-project-picker";
import { useFormatTimeAgo } from "./use-format-time-ago";

export function ExternalChatPage() {
  const { t } = useT("chat");
  const ws = useWorkspaceId();
  const paths = useWorkspacePaths();
  const navigation = useNavigation();
  const formatTimeAgo = useFormatTimeAgo();
  const runtimeId = navigation.searchParams.get("external_runtime") ?? "";
  const sourceId = navigation.searchParams.get("external_source") ?? "";
  const threadId = navigation.searchParams.get("external_thread") ?? "";
  const projectId = navigation.searchParams.get("external_project") ?? "";
  const [showList, setShowList] = useState(!threadId);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const sourceKey = `${runtimeId}:${sourceId}`;
  const draftKey = `${ws}:${sourceKey}:${threadId}`;
  const runtimes = useQuery(runtimeListOptions(ws));
  const codexRuntimes = runtimes.data?.filter(row => row.provider === "codex") ?? [];
  const runtime = codexRuntimes.find(row => row.id === runtimeId);
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
  const runtimeLabel = (row: (typeof codexRuntimes)[number]) => machineTitle([row], { isCurrent: false, fallbackTitle: row.name });

  useEffect(() => {
    if (available && !sourceId && catalog.data?.sources.length === 1) {
      navigation.replace(paths.externalChat(runtimeId, catalog.data.sources[0]!.id));
    }
  }, [available, sourceId, catalog.data, navigation, paths, runtimeId]);
  useEffect(() => { setShowList(!threadId); }, [threadId]);

  const choose = (nextRuntime: string, nextSource?: string, nextThread?: string, nextProject?: string) => {
    setShowList(!nextThread);
    navigation.push(paths.externalChat(nextRuntime, nextSource, nextThread, nextProject));
  };

  return <div className="flex h-full min-h-0 flex-col overflow-hidden">
    <PageHeader>
      <h1 className="text-sm font-semibold">{t(($) => $.page.title)}</h1>
      <ChatModeTabs external />
    </PageHeader>
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <aside aria-label={t(($) => $.external.sources)} className={cn("min-h-0 w-full shrink-0 flex-col border-r bg-sidebar md:flex md:w-80", showList ? "flex" : "hidden")}>
        <div className="shrink-0 space-y-2 border-b p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium">{t(($) => $.external.title)}</span>
            {threadId && <Button variant="ghost" size="icon-sm" className="md:hidden" aria-label={t(($) => $.page.back)} onClick={() => setShowList(false)}><ArrowLeft /></Button>}
          </div>
          <Select value={runtimeId || null} onValueChange={id => { if (id && id !== runtimeId) choose(id); }}>
            <SelectTrigger className="w-full" aria-label={t(($) => $.external.runtime)}>
              <Monitor className="size-3.5 text-muted-foreground" />
              <SelectValue>{runtime ? runtimeLabel(runtime) : t(($) => $.external.select_runtime)}</SelectValue>
            </SelectTrigger>
            <SelectContent>{codexRuntimes.map(row => <SelectItem key={row.id} value={row.id}>
              <span className="min-w-0"><span className="block truncate">{runtimeLabel(row)}</span><span className="block truncate text-xs text-muted-foreground">{row.name}</span></span>
              <span className={cn("ml-auto size-1.5 shrink-0 rounded-full", row.status === "online" ? "bg-success" : "bg-muted-foreground")} />
            </SelectItem>)}</SelectContent>
          </Select>
          {catalog.data && catalog.data.sources.length > 0 && <Select value={sourceId || null} onValueChange={id => { if (id && id !== sourceId) choose(runtimeId, id); }}>
            <SelectTrigger className="w-full" aria-label={t(($) => $.external.source)} title={source?.home}><SelectValue>{source?.name ?? t(($) => $.external.select_source)}</SelectValue></SelectTrigger>
            <SelectContent>{catalog.data.sources.map(row => <SelectItem key={row.id} value={row.id}>
              <span className="min-w-0"><span className="block truncate">{row.name}</span><span className="block break-all whitespace-normal text-xs text-muted-foreground">{row.home}</span></span>
            </SelectItem>)}</SelectContent>
          </Select>}
          {source && <ExternalChatProjectPicker key={sourceKey} projects={projects} projectId={projectId} onChange={id => { if (id !== projectId) choose(runtimeId, sourceId, undefined, id); }} />}
          <p className="text-[11px] text-muted-foreground">{t(($) => $.external.config_readonly)}</p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2" aria-label={t(($) => $.page.history)}>
          {runtimes.isPending && <p role="status" className="p-2 text-sm text-muted-foreground">{t(($) => $.page.loading)}</p>}
          {runtimes.isError && <div role="alert" className="p-2 text-sm text-destructive">{t(($) => $.external.failed)} <Button variant="outline" size="sm" onClick={() => void runtimes.refetch()}>{t(($) => $.page.retry)}</Button></div>}
          {runtimes.data && codexRuntimes.length === 0 && <p className="p-2 text-sm text-muted-foreground">{t(($) => $.external.no_runtimes)}</p>}
          {runtimeId && !runtimes.isPending && !online && <p role="status" className="p-2 text-sm text-muted-foreground">{t(($) => $.external.offline)}</p>}
          {runtime && online && !supported && <p role="status" className="p-2 text-sm text-muted-foreground">{t(($) => $.external.upgrade)}</p>}
          {available && catalog.isPending && <p role="status" className="p-2 text-sm text-muted-foreground">{t(($) => $.page.loading)}</p>}
          {catalog.isError && <div role="alert" className="p-2 text-sm text-destructive">{catalog.error.message} <Button variant="outline" size="sm" onClick={() => void catalog.refetch()}>{t(($) => $.page.retry)}</Button></div>}
          {catalog.data?.warnings.map(warning => <p role="status" className="break-words p-2 text-xs text-warning" key={`${warning.source_id}:${warning.code}`}>{warning.message}</p>)}
          {catalog.data?.sources.length === 0 && <p className="p-2 text-sm text-muted-foreground">{t(($) => $.external.no_sources)}</p>}
          {sourceId && catalog.data && !source && <p role="alert" className="p-2 text-sm text-destructive">{t(($) => $.external.source_missing)}</p>}
          {source && <>
            {threads.isPending && <p role="status" className="p-2 text-sm text-muted-foreground">{t(($) => $.page.loading)}</p>}
            {threads.isError && <div role="alert" className="p-2 text-sm text-destructive">{threads.error.message} <Button variant="outline" size="sm" onClick={() => void threads.refetch()}>{t(($) => $.page.retry)}</Button></div>}
            {threads.data && chats.length === 0 && <p className="p-2 text-sm text-muted-foreground">{t(($) => $.external.empty)}</p>}
            {chats.map(chat => <button type="button" key={chat.id} aria-current={chat.id === threadId ? "true" : undefined} title={`${chat.title}\n${chat.cwd}`}
              className={cn("relative flex min-h-11 w-full min-w-0 items-center gap-2 overflow-hidden rounded-md px-2 py-2 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", chat.id === threadId && "bg-accent/70")}
              onClick={() => choose(runtimeId, sourceId, chat.id, projectId)}>
              {chat.id === threadId && <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-brand" />}
              <MessageSquare className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1"><span className="block truncate text-sm">{chat.title || t(($) => $.window.untitled)}</span><span className="block truncate text-xs text-muted-foreground">{chat.cwd}</span></span>
              <time className="shrink-0 text-[11px] text-muted-foreground" dateTime={new Date(chat.updated_at * 1_000).toISOString()}>{formatTimeAgo(new Date(chat.updated_at * 1_000).toISOString())}</time>
            </button>)}
            {threads.hasNextPage && <Button variant="ghost" size="sm" className="mt-2 w-full" disabled={threads.isFetchingNextPage} onClick={() => void threads.fetchNextPage()}>{t(($) => $.external.load_more)}</Button>}
          </>}
        </div>
      </aside>
      <section className={cn("min-h-0 min-w-0 flex-1 flex-col md:flex", showList ? "hidden" : "flex")}>
        {runtimeId && sourceId && threadId ? <ExternalChatWindow key={draftKey} ws={ws} runtime={runtimeId} source={sourceId} thread={threadId} online={available && !!source}
          modelsSupported={runtime?.metadata.external_chat_models === 1}
          onShowList={() => setShowList(true)} draft={drafts[draftKey] ?? ""} onDraftChange={value => setDrafts(previous => ({ ...previous, [draftKey]: value }))} />
          : <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center"><MessageSquare className="size-8 text-muted-foreground/50" /><p className="text-sm text-muted-foreground">{t(($) => $.external.select)}</p></div>}
      </section>
    </div>
  </div>;
}
