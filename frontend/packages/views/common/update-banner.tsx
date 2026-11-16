"use client";
import { useT } from "../i18n";

export function UpdateBanner({ state, busy, drain, onRefresh }: {
  state: "draining" | "switching" | "updated" | null;
  busy?: boolean;
  drain?: { active_tasks: number; acked_daemons: number; online_daemons: number } | null;
  onRefresh?: () => void;
}) {
  const { t } = useT("common");
  if (!state) return null;
  return <div role="status" aria-live="polite" className="border-b bg-muted px-4 py-2 text-sm text-foreground" data-update-state={state}>
    {state === "draining" ? t($ => $.update.draining) : state === "switching" ? t($ => $.update.switching) : t($ => $.update.updated)}
    {state === "draining" && drain && <span> {t($ => $.update.progress, { tasks: drain.active_tasks, acked: drain.acked_daemons, total: drain.online_daemons })}</span>}
    {state === "updated" && (busy ? <span> {t($ => $.update.waiting)}</span> : <button type="button" className="ml-3 underline" onClick={onRefresh}>{t($ => $.update.refresh)}</button>)}
  </div>;
}
