"use client";

import { useWorkspacePaths } from "@multiremi/core/paths";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";

export function ChatModeTabs({ external = false }: { external?: boolean }) {
  const { t } = useT("chat");
  const paths = useWorkspacePaths();

  return <nav aria-label={t(($) => $.page.title)} className="ml-4 flex items-center gap-1 text-xs">
    {[
      { href: paths.chat(), label: t(($) => $.external.switch_remi), active: !external },
      { href: paths.externalChat(), label: t(($) => $.external.switch_external), active: external },
    ].map(item => item.active
      ? <span key={item.href} aria-current="page" className="rounded-md bg-accent px-2.5 py-1.5 font-medium text-foreground">{item.label}</span>
      : <AppLink key={item.href} href={item.href} className="rounded-md px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{item.label}</AppLink>)}
  </nav>;
}
