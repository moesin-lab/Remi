"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { feishuBotsOptions } from "@multiremi/core/feishu-bot/queries";
import { Button } from "@multiremi/ui/components/ui/button";
import { useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { useImWorkspaceAccess } from "../workspace-access";
import { ImLoadError } from "../load-error";

const BotSelection = createContext({ botId: "default", selectBot: (_botId: string) => {} });
export function useFeishuBotSelection() { return useContext(BotSelection); }

/** The URL carries only the selected identity. Configurations stay in the
 * query cache; remounting the editor discards unsaved credentials on switch. */
export function FeishuBotSelection({ children, allowCreate = false }: { children: ReactNode; allowCreate?: boolean }) {
  const { t } = useT("im-platforms");
  const workspaceId = useWorkspaceId();
  const access = useImWorkspaceAccess(workspaceId);
  const navigation = useNavigation();
  const query = useQuery(feishuBotsOptions(workspaceId, access.canManage));
  const bots = query.data?.bots ?? [];
  const requested = navigation.searchParams.get("bot");
  const botId = requested ?? (bots.find(bot => bot.bot_id === "default")?.bot_id ?? bots[0]?.bot_id ?? "default");
  function selectBot(id: string) {
    const params = new URLSearchParams(navigation.searchParams);
    if (id === "default") params.delete("bot");
    else params.set("bot", id);
    navigation.replace(`${navigation.pathname}${params.size ? `?${params}` : ""}`);
  }
  if (access.isPending || (access.canManage && query.isPending)) return <p role="status">{t($ => $.bots.loading)}</p>;
  if (access.isError || (access.canManage && query.isError)) return <ImLoadError retry={() => { void access.refetch(); void query.refetch(); }} />;
  if (!access.canManage) return children;
  const missing = requested && requested !== "new" && !bots.some(bot => bot.bot_id === requested);
  return <BotSelection.Provider value={{ botId, selectBot }}>
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-4">
        <label className="min-w-48 flex-1 space-y-2 text-sm font-medium">
          <span>{t($ => $.bots.select)}</span>
          <select aria-label={t($ => $.bots.select)} value={botId} onChange={event => selectBot(event.target.value)} className="block h-9 w-full rounded-md border bg-background px-3 text-sm">
            {bots.length === 0 && <option value="default">{t($ => $.bots.empty)}</option>}
            {bots.map(bot => <option key={bot.bot_id} value={bot.bot_id}>{bot.name || bot.bot_name || bot.app_id}</option>)}
            {botId === "new" && <option value="new">{t($ => $.bots.add)}</option>}
            {missing && <option value={botId}>{t($ => $.bots.missing)}</option>}
          </select>
        </label>
        {allowCreate && bots.length > 0 && <Button variant="outline" disabled={botId === "new"} onClick={() => selectBot("new")}>{t($ => $.bots.add)}</Button>}
      </div>
      {missing || (botId === "new" && !allowCreate)
        ? <p className="text-sm text-muted-foreground">{t($ => $.bots.missing)}</p>
        : <div key={`${workspaceId}:${botId}`}>{children}</div>}
    </div>
  </BotSelection.Provider>;
}
