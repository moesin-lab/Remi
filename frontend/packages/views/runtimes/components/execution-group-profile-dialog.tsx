"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "@multiremi/core/auth";
import { memberListOptions } from "@multiremi/core/workspace/queries";
import { Button } from "@multiremi/ui/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@multiremi/ui/components/ui/dialog";
import { useT } from "../../i18n";
import { ExecutionGroupProviderProfile } from "./execution-group-provider-profile";

export function ExecutionGroupProfileDialog({ wsId, groupId, provider }: { wsId: string; groupId: string; provider: string }) {
  const [open, setOpen] = useState(false);
  const { t } = useT("runtimes");
  const userId = useAuthStore(state => state.user?.id);
  const members = useQuery({ ...memberListOptions(wsId), enabled: open && Boolean(wsId) });
  const role = members.data?.find(member => member.user_id === userId)?.role;
  if (!groupId || (provider !== "codex" && provider !== "claude")) return null;
  return <>
    <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>{t($ => $.execution_group.connection_title)}</Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>{t($ => $.execution_group.connection_title)}</DialogTitle></DialogHeader>
        {open && <ExecutionGroupProviderProfile wsId={wsId} groupId={groupId} provider={provider} canManage={role === "owner" || role === "admin"} />}
      </DialogContent>
    </Dialog>
  </>;
}
