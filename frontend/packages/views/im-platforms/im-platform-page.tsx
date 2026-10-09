"use client";

import { useEffect, useRef, type ComponentType } from "react";
import { Bot, LayoutDashboard, MessagesSquare, Plug, ScrollText, ShieldCheck, Waypoints } from "lucide-react";
import { getImPlatform, type ImPlatformId, type ImSection } from "@multiremi/core/im-platforms";
import { useCurrentWorkspace, useWorkspacePaths } from "@multiremi/core/paths";
import { cn } from "@multiremi/ui/lib/utils";
import { BreadcrumbHeader } from "../layout/breadcrumb-header";
import { AppLink, useNavigation } from "../navigation";
import { useT } from "../i18n";
import { FeishuOverview } from "./feishu/overview";
import { FeishuBotPanel, FeishuAccessPanel, FeishuConversationsPanel } from "./feishu/bot-panels";
import { FeishuIngestionPanel, FeishuMessagesPanel } from "./feishu/message-panels";

// Register an implementation for every capability a platform advertises.
// The shell has no platform API calls or assumptions about connection storage.
const PLATFORM_VIEWS: Record<ImPlatformId, Record<ImSection, ComponentType>> = {
  feishu: { overview: FeishuOverview, bot: FeishuBotPanel, access: FeishuAccessPanel, conversations: FeishuConversationsPanel, ingestion: FeishuIngestionPanel, messages: FeishuMessagesPanel },
};
const SECTION_ICONS = { overview: LayoutDashboard, bot: Bot, access: ShieldCheck, conversations: Waypoints, ingestion: Plug, messages: ScrollText };

export function ImPlatformPage({ platformId, section }: { platformId: ImPlatformId; section: ImSection }) {
  const { t } = useT("im-platforms");
  const paths = useWorkspacePaths();
  const workspace = useCurrentWorkspace();
  const selectedBot = useNavigation().searchParams.get("bot");
  const botSections: ImSection[] = ["bot", "access", "conversations"];
  const platform = getImPlatform(platformId)!;
  const View = PLATFORM_VIEWS[platformId][section];
  const navigation = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = navigation.current;
    if (!nav) return;
    const revealActiveSection = () => nav.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    revealActiveSection();
    const resize = new ResizeObserver(revealActiveSection);
    resize.observe(nav);
    return () => resize.disconnect();
  }, [platformId, section]);
  return <div className="flex min-h-0 flex-1 flex-col">
    <BreadcrumbHeader segments={[{ href: paths.imPlatforms(), label: t($ => $.page.title) }]} leaf={<span className="flex min-w-0 items-center gap-2 font-medium"><MessagesSquare className="size-4 shrink-0" />{t($ => $.platforms[platformId].name)}</span>} />
    <nav ref={navigation} aria-label={t($ => $.page.activity)} className="flex shrink-0 gap-1 overflow-x-auto border-b px-4 pt-2 md:px-6">
      {platform.sections.map(item => {
        const Icon = SECTION_ICONS[item];
        return <AppLink key={item} href={paths.imPlatform(platformId, item) + (selectedBot && selectedBot !== "new" && botSections.includes(item) ? `?bot=${encodeURIComponent(selectedBot)}` : "")} aria-current={section === item ? "page" : undefined} className={cn("flex shrink-0 items-center gap-2 border-b-2 px-3 py-3 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-ring", section === item ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
          <Icon className="size-4" />{t($ => $.sections[item].title)}
        </AppLink>;
      })}
    </nav>
    <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
      <div className={cn("mx-auto space-y-6", section === "messages" ? "max-w-7xl" : "max-w-5xl")}>
        <header className="space-y-2">
          <h1 className="text-xl font-semibold tracking-tight">{t($ => $.sections[section].title)}</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">{t($ => $.sections[section].description)}</p>
        </header>
        <View key={`${workspace?.id}:${platformId}:${section}`} />
      </div>
    </div>
  </div>;
}
