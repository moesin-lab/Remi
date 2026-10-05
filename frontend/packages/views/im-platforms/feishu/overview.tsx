"use client";

import { ArrowRight, Bot, Plug, ShieldCheck, Waypoints, ScrollText } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useWorkspacePaths } from "@multiremi/core/paths";
import { feishuBotOptions, feishuBotStatusOptions } from "@multiremi/core/feishu-bot/queries";
import { feishuEndpointsOptions, feishuSourcesOptions } from "@multiremi/core/feishu";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";
import { useImWorkspaceAccess } from "../workspace-access";
import { ImLoadError } from "../load-error";
import { FeishuBotStatusBadge } from "./feishu-bot-section";

export function FeishuOverview() {
  const { t } = useT("im-platforms");
  const paths = useWorkspacePaths();
  const wsId = useWorkspaceId();
  const access = useImWorkspaceAccess(wsId);
  const bot = useQuery(feishuBotOptions(wsId));
  const status = useQuery(feishuBotStatusOptions(wsId, access.canManage));
  const connections = useQuery(feishuEndpointsOptions(wsId, access.canManage));
  const sources = useQuery(feishuSourcesOptions(wsId, access.canManage));
  if (access.isError) return <ImLoadError retry={() => void access.refetch()} />;
  if (access.isPending) return <p role="status">{t($ => $.page.loading)}</p>;
  const config = bot.data?.role === "admin" ? bot.data.config : undefined;
  const availability = bot.data?.role === "member" ? bot.data.availability : undefined;
  return <div className="space-y-6">
    {!access.canManage && <p className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">{t($ => $.page.readOnly)}</p>}
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="flex flex-col gap-4 rounded-xl border bg-card p-5">
        <div className="flex items-start justify-between gap-3"><h2 className="flex items-center gap-2 font-medium"><Bot className="size-4" />{t($ => $.page.botConnection)}</h2>
          {status.data && !status.isError && <FeishuBotStatusBadge status={status.data.status} />}
        </div>
        <p className="text-sm text-muted-foreground">{t($ => $.page.botHint)}</p>
        {bot.isError || (access.canManage && status.isError) ? <ImLoadError retry={() => { void bot.refetch(); if (access.canManage) void status.refetch(); }} />
          : bot.isPending || (access.canManage && status.isPending) ? <p role="status" className="text-sm">{t($ => $.page.loading)}</p>
          : <div className="min-w-0 space-y-1 text-sm">
            <p className="truncate font-medium">{config?.bot_name || availability?.bot_name || t($ => (config?.configured || availability?.configured) ? $.page.configured : $.page.notConfigured)}</p>
            {config?.configured && <p className="truncate text-muted-foreground">{config.agent_name} · {config.runtime_name}</p>}
          </div>}
        <AppLink href={paths.imPlatform("feishu", "bot")} className="mt-auto inline-flex items-center gap-2 text-sm font-medium text-primary">{t($ => $.sections.bot.title)}<ArrowRight className="size-4" /></AppLink>
      </section>
      <section className="flex flex-col gap-4 rounded-xl border bg-card p-5">
        <h2 className="flex items-center gap-2 font-medium"><Plug className="size-4" />{t($ => $.page.ingestionConnection)}</h2>
        <p className="text-sm text-muted-foreground">{t($ => $.page.ingestionHint)}</p>
        {!access.canManage ? <p className="text-sm text-muted-foreground">{t($ => $.page.readOnly)}</p>
          : connections.isError || sources.isError ? <ImLoadError retry={() => { void connections.refetch(); void sources.refetch(); }} />
          : connections.isPending || sources.isPending ? <p role="status" className="text-sm">{t($ => $.page.loading)}</p>
          : <div className="text-sm"><p className="font-medium">{t($ => $.page.connectionCount, { count: connections.data?.endpoints.length ?? 0 })} · {t($ => $.page.sourceCount, { count: sources.data?.sources.length ?? 0 })}</p>
            {!connections.data?.endpoints.length && <p className="mt-1 text-muted-foreground">{t($ => $.page.noConnections)}</p>}
          </div>}
        <AppLink href={paths.imPlatform("feishu", "ingestion")} className="mt-auto inline-flex items-center gap-2 text-sm font-medium text-primary">{t($ => $.sections.ingestion.title)}<ArrowRight className="size-4" /></AppLink>
      </section>
    </div>
    <div className="grid gap-3 md:grid-cols-3">
      {([{ section: "access", icon: ShieldCheck }, { section: "conversations", icon: Waypoints }, { section: "messages", icon: ScrollText }] as const).map(({ section, icon: Icon }) => <AppLink key={section} href={paths.imPlatform("feishu", section)} className="space-y-2 rounded-xl border p-4 transition-colors hover:bg-accent/40">
        <h2 className="flex items-center gap-2 text-sm font-medium"><Icon className="size-4" />{t($ => $.sections[section].title)}</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">{t($ => $.sections[section].description)}</p>
      </AppLink>)}
    </div>
  </div>;
}
