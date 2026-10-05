"use client";

import { ArrowRight, MessagesSquare } from "lucide-react";
import { IM_PLATFORMS } from "@multiremi/core/im-platforms";
import { useWorkspacePaths } from "@multiremi/core/paths";
import { PageHeader } from "../layout/page-header";
import { AppLink } from "../navigation";
import { useT } from "../i18n";

export function ImPlatformsPage() {
  const { t } = useT("im-platforms");
  const paths = useWorkspacePaths();
  return <div className="flex min-h-0 flex-1 flex-col">
    <PageHeader><h1 className="text-sm font-semibold">{t($ => $.page.title)}</h1></PageHeader>
    <div className="flex-1 overflow-y-auto p-4 md:p-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <p className="text-sm text-muted-foreground">{t($ => $.page.description)}</p>
        <div className="grid gap-4 md:grid-cols-2">
          {IM_PLATFORMS.map(platform => <AppLink key={platform.id} href={paths.imPlatform(platform.id)} className="group flex gap-4 rounded-xl border bg-card p-5 transition-colors hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><MessagesSquare className="size-5" /></div>
            <div className="min-w-0 flex-1 space-y-2">
              <h2 className="font-semibold">{t($ => $.platforms[platform.id].name)}</h2>
              <p className="text-sm leading-relaxed text-muted-foreground">{t($ => $.platforms[platform.id].description)}</p>
              <span className="inline-flex items-center gap-2 text-sm font-medium">{t($ => $.page.manage)}<ArrowRight className="size-4" /></span>
            </div>
          </AppLink>)}
        </div>
      </div>
    </div>
  </div>;
}
