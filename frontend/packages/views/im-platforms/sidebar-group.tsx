"use client";

import { MessagesSquare } from "lucide-react";
import { IM_PLATFORMS } from "@multiremi/core/im-platforms";
import { useWorkspacePaths } from "@multiremi/core/paths";
import { SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@multiremi/ui/components/ui/sidebar";
import { AppLink, useNavigation } from "../navigation";
import { useT } from "../i18n";

export function ImPlatformSidebarGroup() {
  const { t } = useT("im-platforms");
  const paths = useWorkspacePaths();
  const { pathname } = useNavigation();
  return <SidebarGroup data-testid="im-platforms-sidebar">
    <SidebarGroupLabel>{t($ => $.page.title)}</SidebarGroupLabel>
    <SidebarGroupContent><SidebarMenu className="gap-0.5">
      {IM_PLATFORMS.map(platform => {
        const href = paths.imPlatform(platform.id);
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return <SidebarMenuItem key={platform.id}>
          <SidebarMenuButton isActive={active} render={<AppLink href={href} aria-current={active ? "page" : undefined} />} className="text-muted-foreground hover:not-data-active:bg-sidebar-accent/70 data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground">
            <MessagesSquare /><span>{t($ => $.platforms[platform.id].name)}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>;
      })}
    </SidebarMenu></SidebarGroupContent>
  </SidebarGroup>;
}
