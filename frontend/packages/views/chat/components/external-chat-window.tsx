"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@multiremi/core/api";
import { externalChatHistoryOptions, externalChatKeys, externalChatWriteIsUnknown, externalChatReceiptStorageKey, readExternalChatReceipt, writeExternalChatReceipt, EXTERNAL_CHAT_MAX_TEXT_CHARS, type ExternalChatReceipt, type ExternalChatTurn } from "@multiremi/core/chat";
import { defaultSessionStorage } from "@multiremi/core/platform";
import { createSafeId } from "@multiremi/core/utils";
import { Button } from "@multiremi/ui/components/ui/button";
import { Markdown } from "@multiremi/ui/markdown";
import { useT } from "../../i18n";
import { ExternalChatRequestCard } from "./external-chat-request";

const terminal = (status: string) => ["completed", "failed", "interrupted", "cancelled"].includes(status);
interface NativeSendState { receipt: ExternalChatReceipt; text?: string }

export function ExternalChatWindow({ ws, runtime, source, thread, online, draft, onDraftChange }: {
  ws: string; runtime: string; source: string; thread: string; online: boolean;
  draft: string; onDraftChange: (value: string) => void;
}) {
  const { t } = useT("chat");
  const client = useQueryClient();
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const sending = useRef(false);
  const scrollRoot = useRef<HTMLDivElement>(null);
  const followTail = useRef(true);
  const [sendError, setSendError] = useState(false);
  const lastReceiptKey = externalChatKeys.lastReceipt(ws, runtime, source, thread);
  const storageKey = externalChatReceiptStorageKey(ws, runtime, source, thread);
  const [stored] = useState(() => readExternalChatReceipt(defaultSessionStorage, storageKey, thread));
  const [storageAvailable, setStorageAvailable] = useState(stored.available);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  // Restore only the acknowledgement, never the text or the native POST.
  const { data: sendState } = useQuery({
    queryKey: lastReceiptKey, queryFn: (): NativeSendState | null => null, enabled: false,
    initialData: (): NativeSendState | null => stored.receipt ? { receipt: stored.receipt } : null, staleTime: Infinity,
  });
  const recordSend = (state: NativeSendState | null) => {
    client.setQueryData(lastReceiptKey, state);
    setStorageAvailable(writeExternalChatReceipt(defaultSessionStorage, storageKey, state?.receipt ?? null));
  };
  const lastReceipt = mounted ? sendState?.receipt : undefined;
  const history = useInfiniteQuery({
    ...externalChatHistoryOptions(ws, runtime, source, thread, online),
    refetchInterval: query => {
      const acknowledgedTurn = lastReceipt?.turn_id
        ? query.state.data?.pages.flatMap(page => page.turns).find(turn => turn.id === lastReceipt.turn_id)
        : undefined;
      const acknowledgedActive = lastReceipt?.outcome === "accepted" && !!lastReceipt.turn_id && (!acknowledgedTurn || !terminal(acknowledgedTurn.status));
      return query.state.data?.pages[0]?.chat.status === "active" || acknowledgedActive ? 2_000 : 5_000;
    },
  });
  const current = history.data?.pages[0];
  const turns = new Map<string, ExternalChatTurn>();
  for (const page of [...(history.data?.pages ?? [])].reverse()) {
    for (const turn of page.turns) {
      const previous = turns.get(turn.id);
      const items = [...new Map([...(previous?.items ?? []), ...turn.items].map(item => [item.id, item])).values()];
      turns.set(turn.id, { ...turn, items });
    }
  }
  const allTurns = [...turns.values()];
  const receiptTurn = lastReceipt?.turn_id ? turns.get(lastReceipt.turn_id) : undefined;
  const receiptRunning = lastReceipt?.outcome === "accepted" && !!lastReceipt.turn_id && (!receiptTurn || !terminal(receiptTurn.status));
  const activeTurn = allTurns.find(turn => ["inProgress", "running", "active"].includes(turn.status));
  const active = current?.chat.status === "active" || receiptRunning || !!activeTurn || !!current?.requests.length;
  const turnId = activeTurn?.id ?? (receiptRunning ? lastReceipt?.turn_id : current?.requests[0]?.turn_id);
  const historyKey = externalChatKeys.history(ws, runtime, source, thread);
  const refresh = () => {
    void client.invalidateQueries({ queryKey: historyKey });
    void client.invalidateQueries({ queryKey: externalChatKeys.threads(ws, runtime, source, "").slice(0, -1) });
  };

  const send = useMutation({
    retry: false,
    mutationFn: (input: { text: string; request_id: string }) => api.sendExternalChatMessage(runtime, source, thread, input),
  });
  const uncertain = lastReceipt?.outcome === "unknown";
  const receipt = useQuery({
    queryKey: externalChatKeys.receipt(ws, runtime, source, thread, lastReceipt?.request_id ?? ""),
    queryFn: () => api.getExternalChatReceipt(runtime, source, thread, lastReceipt!.request_id),
    enabled: online && uncertain && !send.isPending,
    refetchInterval: query => query.state.data?.outcome === "accepted" ? false : 2_000,
    refetchIntervalInBackground: false, retry: false,
  });
  useEffect(() => {
    if (!sendState || !uncertain || receipt.data?.outcome !== "accepted") return;
    client.setQueryData<NativeSendState>(lastReceiptKey, { receipt: receipt.data, text: sendState.text });
    setStorageAvailable(writeExternalChatReceipt(defaultSessionStorage, storageKey, receipt.data));
    if (sendState.text !== undefined && draftRef.current === sendState.text) onDraftChange("");
    void client.invalidateQueries({ queryKey: historyKey });
  }, [receipt.data, uncertain, client, lastReceiptKey, sendState, onDraftChange, historyKey, storageKey]);

  const interrupt = useMutation({ mutationFn: (turn: string) => api.interruptExternalChatTurn(runtime, source, thread, turn), retry: false, onSuccess: refresh });
  const respond = useMutation({
    mutationFn: ({ id, ...input }: { id: string; decision?: "accept" | "decline" | "cancel"; answers?: Record<string, string[]> }) =>
      api.respondExternalChatRequest(runtime, source, thread, id, input),
    retry: false, onSuccess: refresh,
  });
  const canSend = mounted && online && !!current && !history.isError && ["idle", "notLoaded"].includes(current.chat.status) && !active && !uncertain && !send.isPending;

  useLayoutEffect(() => {
    const root = scrollRoot.current;
    if (root && followTail.current && !history.isFetchingNextPage) root.scrollTop = root.scrollHeight;
  }, [history.data, history.isFetchingNextPage]);

  const submit = async () => {
    if (!canSend || !draft.trim() || sending.current) return;
    sending.current = true;
    setSendError(false);
    const input = { text: draft, request_id: createSafeId() };
    recordSend({
      receipt: { request_id: input.request_id, thread_id: thread, turn_id: null, outcome: "unknown" }, text: input.text,
    });
    try {
      const result = await send.mutateAsync(input);
      recordSend({ receipt: result, text: input.text });
      if (result.outcome === "accepted" && draftRef.current === input.text) onDraftChange("");
      refresh();
    } catch (error) {
      if (!externalChatWriteIsUnknown(error)) {
        recordSend(null);
        setSendError(true);
      }
    } finally {
      sending.current = false;
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="space-y-1 border-b p-3">
        <p className="text-sm font-medium">{current?.chat.title || t(($) => $.external.title)}</p>
        <p className="text-xs text-muted-foreground">{t(($) => $.external.readonly)}</p>
        {current && <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-xs">
          {([
            [t(($) => $.external.model), current.chat.model],
            [t(($) => $.external.provider), current.chat.model_provider],
            [t(($) => $.external.effort), current.chat.reasoning_effort],
            [t(($) => $.external.cwd), current.chat.cwd],
            [t(($) => $.external.project_id), current.chat.native_project_id],
            [t(($) => $.external.status), current.chat.status],
          ] as const).map(([label, value]) => value && <div className="contents" key={label}><dt>{label}</dt><dd className="break-all">{value}</dd></div>)}
        </dl>}
      </header>
      {!online && <p role="status" className="p-3 text-sm">{t(($) => $.external.offline)}</p>}
      {online && history.isPending && <p role="status" className="p-3">{t(($) => $.page.loading)}</p>}
      {history.isError && <p role="alert" className="p-3 text-sm text-destructive">{history.error.message} <Button variant="outline" onClick={() => void history.refetch()}>{t(($) => $.page.retry)}</Button></p>}
      {current?.chat.status === "systemError" && <p role="alert" className="p-3 text-sm text-destructive">{current.chat.status} <Button variant="outline" disabled={!online} onClick={() => void history.refetch()}>{t(($) => $.page.retry)}</Button></p>}
      <div ref={scrollRoot} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" onScroll={event => {
        const root = event.currentTarget;
        followTail.current = root.scrollHeight - root.scrollTop - root.clientHeight < 24;
      }}>
        {history.hasNextPage && <Button variant="outline" disabled={history.isFetchingNextPage || !online} onClick={() => { followTail.current = false; void history.fetchNextPage(); }}>{t(($) => $.external.older)}</Button>}
        {current && allTurns.length === 0 && <p className="text-sm text-muted-foreground">{t(($) => $.external.no_messages)}</p>}
        {allTurns.map(turn => <section className="space-y-3" key={turn.id}>
          {turn.items.map(item => item.role === "user" || item.type === "agentMessage" ? (
            <div className={item.role === "user" ? "rounded-lg bg-muted p-3" : "p-1"} key={item.id}>
              <Markdown>{item.text}</Markdown>
              {item.truncated && <p className="text-xs text-muted-foreground">{t(($) => $.external.truncated)}</p>}
            </div>
          ) : <details className="rounded-md border p-2" key={item.id}><summary className="cursor-pointer text-xs">{item.type}</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{item.text}</pre>{item.truncated && <p className="text-xs">{t(($) => $.external.truncated)}</p>}</details>)}
          {turn.error && <p role="alert" className="text-sm text-destructive">{turn.error}</p>}
        </section>)}
        {current?.requests.map(request => <ExternalChatRequestCard request={request} key={request.id} disabled={!online || respond.isPending}
          onRespond={input => respond.mutate({ id: request.id, ...input })} />)}
      </div>
      {active && <div className="space-y-2 border-t p-3 text-sm">
        <p role="status">{t(($) => $.external.busy)}</p>
        {current?.requests.length === 0 && <p className="text-xs text-muted-foreground">{t(($) => $.external.native_client)}</p>}
        {turnId && <Button variant="outline" disabled={!online || interrupt.isPending} onClick={() => interrupt.mutate(turnId)}>{t(($) => $.external.interrupt)}</Button>}
      </div>}
      {(interrupt.isError || respond.isError) && <p role="alert" className="px-3 text-sm text-destructive">{t(($) => $.external.action_failed)}</p>}
      {uncertain && !send.isPending && <div role="alert" className="space-y-1 px-3 text-sm text-warning">
        <p>{t(($) => $.external.unknown)}</p><code className="break-all text-xs">{lastReceipt.request_id}</code>
        <Button variant="outline" disabled={!online || receipt.isFetching} onClick={() => void receipt.refetch()}>{t(($) => $.external.check_receipt)}</Button>
      </div>}
      {sendError && <p role="alert" className="px-3 text-sm text-destructive">{t(($) => $.external.send_failed)}</p>}
      {mounted && !storageAvailable && <p role="alert" className="px-3 text-sm text-warning">{t(($) => $.external.receipt_storage_unavailable)}</p>}
      <form className="space-y-2 border-t p-3" onSubmit={event => { event.preventDefault(); void submit(); }}>
        <textarea aria-label={t(($) => $.external.message)} maxLength={EXTERNAL_CHAT_MAX_TEXT_CHARS} value={draft} disabled={!online || !current}
          onChange={event => onDraftChange(event.target.value)} className="min-h-20 w-full resize-y rounded-md border bg-background p-2 text-sm" />
        <Button type="submit" disabled={!canSend || !draft.trim()}>{t(($) => send.isPending ? $.external.sending : $.external.send)}</Button>
      </form>
    </div>
  );
}
