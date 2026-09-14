"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, MessageSquare, Play, Plus, Square, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { Bot, SaveBotInput } from "@multiremi/core/bots";
import { botDetailOptions, botListOptions, botSendersOptions } from "@multiremi/core/bots/queries";
import { useCreateBot, useDeleteBot, useUpdateBot, useUpdateBotSender } from "@multiremi/core/bots/mutations";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { Button } from "@multiremi/ui/components/ui/button";
import { Badge } from "@multiremi/ui/components/ui/badge";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@multiremi/ui/components/ui/alert-dialog";
import { PageHeader } from "../../layout/page-header";
import { useT } from "../../i18n";
import { BotForm, botInput } from "./bot-form";

export function BotsPage() {
  const wsId = useWorkspaceId();
  // A URL workspace change must discard resource selection and credential drafts.
  return <WorkspaceBots key={wsId} wsId={wsId} />;
}

function WorkspaceBots({ wsId }: { wsId: string }) {
  const { t } = useT("bots");
  const [selected, setSelected] = useState<string | null>(null);
  const bots = useQuery(botListOptions(wsId));
  if (selected !== null) return <BotEditor key={selected} wsId={wsId} botId={selected === "new" ? null : selected} onBack={() => setSelected(null)} onCreated={bot => setSelected(bot.id)} />;

  return <div className="flex h-full min-h-0 flex-col">
    <PageHeader><h1 className="text-sm font-semibold">{t($ => $.title)}</h1><Button size="sm" className="ml-auto" onClick={() => setSelected("new")}><Plus className="size-4" />{t($ => $.create)}</Button></PageHeader>
    <div className="flex-1 overflow-y-auto p-4 sm:p-6"><div className="mx-auto max-w-5xl space-y-4">
      <p className="text-sm text-muted-foreground">{t($ => $.description)}</p>
      {bots.isPending ? <p role="status" className="py-8 text-sm text-muted-foreground">{t($ => $.loading)}</p>
        : bots.isError ? <LoadError onRetry={() => void bots.refetch()} />
          : bots.data?.length ? <div className="grid gap-3 md:grid-cols-2">{bots.data.map(bot => <button key={bot.id} onClick={() => setSelected(bot.id)} className="flex min-w-0 flex-col gap-3 rounded-lg border p-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <div className="flex w-full min-w-0 items-center gap-2"><MessageSquare className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate font-medium">{bot.name}</span><Badge variant="secondary">{bot.enabled ? t($ => $.enabled) : t($ => $.stopped)}</Badge></div>
            <p className="max-w-full truncate text-xs text-muted-foreground">{bot.platform_bindings.map(binding => binding.app_id).join(" · ")}</p>
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground"><span>{t($ => $.account_count, { count: bot.platform_bindings.length })}</span><span>·</span><span>{bot.allowlist_enabled ? t($ => $.allowlist_on) : t($ => $.open_access)}</span></div>
          </button>)}</div>
            : <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-4 py-16 text-center"><MessageSquare className="size-8 text-muted-foreground" /><p className="text-sm font-medium">{t($ => $.empty)}</p><p className="max-w-md text-sm text-muted-foreground">{t($ => $.empty_hint)}</p><Button onClick={() => setSelected("new")}><Plus className="size-4" />{t($ => $.create)}</Button></div>}
    </div></div>
  </div>;
}

function BotEditor({ wsId, botId, onBack, onCreated }: { wsId: string; botId: string | null; onBack: () => void; onCreated: (bot: Bot) => void }) {
  const { t } = useT("bots");
  const detail = useQuery(botDetailOptions(wsId, botId ?? ""));
  const create = useCreateBot(wsId);
  const update = useUpdateBot(wsId, botId ?? "");
  const remove = useDeleteBot(wsId);
  const [dirty, setDirty] = useState(false);
  const [confirm, setConfirm] = useState<"delete" | "discard" | null>(null);
  const busy = create.isPending || update.isPending || remove.isPending;
  const bot = detail.data ?? null;

  async function save(input: SaveBotInput) {
    try {
      const saved = botId ? await update.mutateAsync(input) : await create.mutateAsync(input);
      toast.success(t($ => $.saved));
      if (!botId) onCreated(saved);
      return saved;
    } catch (error) {
      toast.error(errorMessage(error, t($ => $.save_failed)));
      throw error;
    }
  }
  async function setEnabled(enabled: boolean) {
    if (!bot || busy || dirty) return;
    try { await update.mutateAsync({ ...botInput(bot), enabled }); }
    catch (error) { toast.error(errorMessage(error, t($ => $.save_failed))); }
  }
  async function confirmAction() {
    if (confirm === "discard") { onBack(); return; }
    if (!botId) return;
    try { await remove.mutateAsync(botId); onBack(); }
    catch (error) { toast.error(errorMessage(error, t($ => $.delete_failed))); }
  }
  return <div className="flex h-full min-h-0 flex-col">
    <PageHeader><Button variant="ghost" size="icon" aria-label={t($ => $.back)} disabled={busy} onClick={() => dirty ? setConfirm("discard") : onBack()}><ArrowLeft className="size-4" /></Button><h1 className="ml-2 min-w-0 truncate text-sm font-semibold">{bot?.name ?? t($ => $.create)}</h1>{bot && <div className="ml-auto flex shrink-0 items-center gap-2"><Button size="sm" variant="outline" disabled={busy || dirty} title={dirty ? t($ => $.save_first) : undefined} onClick={() => void setEnabled(!bot.enabled)}>{bot.enabled ? <Square className="size-4" /> : <Play className="size-4" />}{bot.enabled ? t($ => $.stop) : t($ => $.start)}</Button><Button size="icon" variant="ghost" aria-label={t($ => $.delete)} disabled={busy} onClick={() => setConfirm("delete")}><Trash2 className="size-4 text-destructive" /></Button></div>}</PageHeader>
    <div className="flex-1 overflow-y-auto p-4 sm:p-6"><div className="mx-auto max-w-3xl space-y-6">
      {botId && detail.isPending ? <p role="status" className="text-sm text-muted-foreground">{t($ => $.loading)}</p>
        : botId && detail.isError && !bot ? <LoadError onRetry={() => void detail.refetch()} />
          : <>{botId && detail.isError && bot && <LoadError onRetry={() => void detail.refetch()} />}{bot && <ConnectionStatus bot={bot} />}<BotForm wsId={wsId} bot={bot} busy={busy} onSave={save} onDirtyChange={setDirty} />{bot && <BotSenders wsId={wsId} bot={bot} />}</>}
    </div></div>
    <AlertDialog open={confirm !== null} onOpenChange={open => { if (!open) setConfirm(null); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{confirm === "delete" ? t($ => $.delete_title) : t($ => $.discard_title)}</AlertDialogTitle><AlertDialogDescription>{confirm === "delete" ? t($ => $.delete_description) : t($ => $.discard_description)}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{t($ => $.cancel)}</AlertDialogCancel><AlertDialogAction onClick={() => void confirmAction()}>{confirm === "delete" ? t($ => $.delete) : t($ => $.discard)}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </div>;
}

function ConnectionStatus({ bot }: { bot: Bot }) {
  const { t } = useT("bots");
  return <section className="space-y-2 rounded-lg border p-4" aria-label={t($ => $.connection_status)}><h2 className="text-sm font-semibold">{t($ => $.connection_status)}</h2>{bot.platform_bindings.map(binding => <div key={binding.id} className="space-y-1"><div className="flex min-w-0 items-center gap-2"><span className="min-w-0 flex-1 truncate text-xs">{binding.app_id}</span><Badge variant="secondary">{binding.status === "online" ? t($ => $.online) : binding.status === "starting" ? t($ => $.starting) : binding.status === "failed" ? t($ => $.failed) : binding.status === "offline" ? t($ => $.offline) : binding.status === "stopped" ? t($ => $.stopped) : binding.status}</Badge></div>{binding.last_error && <p className="break-words text-xs text-destructive">{binding.last_error}</p>}</div>)}</section>;
}

function BotSenders({ wsId, bot }: { wsId: string; bot: Bot }) {
  const { t } = useT("bots");
  const senders = useQuery(botSendersOptions(wsId, bot.id));
  const update = useUpdateBotSender(wsId, bot.id);
  return <section className="space-y-3 rounded-lg border p-4" aria-label={t($ => $.senders)}><h2 className="text-sm font-semibold">{t($ => $.senders)}</h2><p className="text-xs text-muted-foreground">{t($ => $.senders_hint)}</p>
    {senders.isPending ? <p role="status" className="text-xs text-muted-foreground">{t($ => $.loading)}</p> : senders.isError ? <LoadError onRetry={() => void senders.refetch()} /> : !senders.data?.length ? <p className="text-sm text-muted-foreground">{t($ => $.senders_empty)}</p> : <ul className="divide-y">{senders.data.map(sender => <li key={sender.id} className="flex items-center gap-3 py-3"><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{sender.display_name ?? sender.external_id}</p><p className="truncate text-xs text-muted-foreground">{bot.platform_bindings.find(binding => binding.id === sender.platform_binding_id)?.app_id ?? sender.platform_binding_id} · {sender.external_id}</p></div><Badge variant="secondary">{sender.allowed ? t($ => $.allowed) : t($ => $.pending)}</Badge><Button size="sm" variant="outline" disabled={update.isPending} onClick={() => void update.mutateAsync({ senderId: sender.id, allowed: !sender.allowed }).catch(error => toast.error(errorMessage(error, t($ => $.save_failed))))}>{sender.allowed ? t($ => $.revoke) : t($ => $.allow)}</Button></li>)}</ul>}
  </section>;
}

function LoadError({ onRetry }: { onRetry: () => void }) {
  const { t } = useT("bots");
  return <div role="alert" className="flex items-center gap-3 py-4"><p className="text-sm text-destructive">{t($ => $.load_failed)}</p><Button variant="outline" size="sm" onClick={onRetry}>{t($ => $.retry)}</Button></div>;
}

function errorMessage(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }
