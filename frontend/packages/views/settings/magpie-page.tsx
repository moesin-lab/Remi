"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { magpieServiceOptions } from "@multiremi/core/workspace/queries";
import { ExternalLink, RefreshCw, Settings } from "lucide-react";
import { Button } from "@multiremi/ui/components/ui/button";
import { useWorkspacePaths } from "@multiremi/core/paths";
import { AppLink } from "../navigation";
import { useT } from "../i18n";

export function MagpiePage() {
  const { t } = useT("runtimes");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const options = magpieServiceOptions(wsId);
  const profile = useQuery(options);
  const url = profile.data?.url ?? null;
  const [reload, setReload] = useState(0);

  if (profile.isPending) return <p className="p-6 text-sm">{t($ => $.magpie.loading)}</p>;
  if (profile.isError) return <p role="alert" className="p-6 text-sm text-destructive">{profile.error.message}</p>;

  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex h-10 shrink-0 items-center gap-1 border-b px-3">
      <span className="mr-auto text-sm font-medium">Magpie</span>
      {url && <>
        <a className="rounded p-2 hover:bg-accent" href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" title={t($ => $.magpie.open)} aria-label={t($ => $.magpie.open)}><ExternalLink className="size-4" /></a>
        <Button variant="ghost" size="icon" title={t($ => $.magpie.reload)} aria-label={t($ => $.magpie.reload)} onClick={() => setReload(n => n + 1)}><RefreshCw className="size-4" /></Button>
      </>}
      <AppLink className="rounded p-2 hover:bg-accent" href={`${paths.settings()}?tab=services`} title={t($ => $.magpie.configure)} aria-label={t($ => $.magpie.configure)}><Settings className="size-4" /></AppLink>
    </div>
    {!url && <p className="p-6 text-sm">{t($ => $.magpie.empty)}</p>}
    {url && <>
      <iframe key={`${url}:${reload}`} title="Magpie" src={url} className="min-h-0 w-full flex-1 border-0" referrerPolicy="no-referrer"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads" />
    </>}
  </div>;
}
