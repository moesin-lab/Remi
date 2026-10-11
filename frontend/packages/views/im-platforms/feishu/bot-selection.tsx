"use client";

import { createContext, useContext, useId, type ReactNode } from "react";
import { Bot, Plus } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { feishuBotsOptions } from "@multiremi/core/feishu-bot/queries";
import { Button } from "@multiremi/ui/components/ui/button";
import { Label } from "@multiremi/ui/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@multiremi/ui/components/ui/select";
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
  const selectorId = useId();
  const workspaceId = useWorkspaceId();
  const access = useImWorkspaceAccess(workspaceId);
  const navigation = useNavigation();
  const query = useQuery(feishuBotsOptions(workspaceId, access.canManage));
  const bots = query.data?.bots ?? [];
  const requested = navigation.searchParams.get("bot");
  const botId = requested ?? (bots.find(bot => bot.bot_id === "default")?.bot_id ?? bots[0]?.bot_id ?? "default");
  const selectedBot = bots.find(bot => bot.bot_id === botId);
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
      <div className="flex items-end gap-3">
        <div className="grid min-w-0 flex-1 gap-1.5 sm:max-w-sm">
          <Label htmlFor={selectorId}>{t($ => $.bots.select)}</Label>
          <Select value={botId} onValueChange={value => { if (value) selectBot(value); }}>
            <SelectTrigger id={selectorId} className="w-full min-w-0">
              <Bot className="size-4 text-muted-foreground" />
              <SelectValue className="min-w-0">
                <span className="min-w-0 flex-1 truncate">
                  {selectedBot?.name || selectedBot?.bot_name || selectedBot?.app_id
                    || t($ => botId === "new" ? $.bots.add : missing ? $.bots.missing : $.bots.empty)}
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {bots.length === 0 && <SelectItem value="default">{t($ => $.bots.empty)}</SelectItem>}
              {bots.map(bot => <SelectItem key={bot.bot_id} value={bot.bot_id}><span className="min-w-0 whitespace-normal break-words">{bot.name || bot.bot_name || bot.app_id}</span></SelectItem>)}
              {botId === "new" && <SelectItem value="new">{t($ => $.bots.add)}</SelectItem>}
              {missing && <SelectItem value={botId}>{t($ => $.bots.missing)}</SelectItem>}
            </SelectContent>
          </Select>
        </div>
        {allowCreate && bots.length > 0 && <Button variant="outline" className="shrink-0" disabled={botId === "new"} onClick={() => selectBot("new")}><Plus className="size-4" />{t($ => $.bots.add)}</Button>}
      </div>
      {missing || (botId === "new" && !allowCreate)
        ? <p className="text-sm text-muted-foreground">{t($ => $.bots.missing)}</p>
        : <div key={`${workspaceId}:${botId}`}>{children}</div>}
    </div>
  </BotSelection.Provider>;
}
