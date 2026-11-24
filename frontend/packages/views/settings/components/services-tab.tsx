"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@multiremi/core/api";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { magpieServiceOptions, memberListOptions } from "@multiremi/core/workspace/queries";
import { workspaceOperatorUser } from "@multiremi/core/workspace/operator";
import { Button } from "@multiremi/ui/components/ui/button";
import { Input } from "@multiremi/ui/components/ui/input";
import { useT } from "../../i18n";

export function ServicesTab() {
  const { t } = useT("runtimes");
  return <div className="space-y-6">
    <h2 className="text-lg font-semibold">{t($ => $.magpie.services)}</h2>
    <section className="space-y-3 rounded-lg border p-4">
      <h3 className="font-medium">Magpie</h3>
      <MagpieServiceSettings />
    </section>
  </div>;
}

export function MagpieServiceSettings() {
  const { t } = useT("runtimes");
  const wsId = useWorkspaceId();
  const queryClient = useQueryClient();
  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const canManage = members.some(member => member.user_id === workspaceOperatorUser.id && ["owner", "admin"].includes(member.role));
  const options = magpieServiceOptions(wsId);
  const profile = useQuery(options);
  const [draft, setDraft] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (url: string | null) => api.updateMagpieService(wsId, url),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: options.queryKey });
      setDraft(null);
    },
  });
  if (profile.isPending) return <p>{t($ => $.magpie.loading)}</p>;
  if (profile.isError) return <p role="alert">{profile.error.message}</p>;
  return <form className="space-y-3" onSubmit={event => {
    event.preventDefault();
    save.mutate((draft ?? profile.data.url ?? "").trim() || null);
  }}>
    <label className="block space-y-2 text-sm">
      <span>{t($ => $.magpie.address)}</span>
      <Input type="url" value={draft ?? profile.data.url ?? ""} onChange={event => { setDraft(event.target.value); save.reset(); }} placeholder="http://devbox:3430/" disabled={save.isPending || !canManage} />
    </label>
    <p className="text-xs text-muted-foreground">{t($ => $.magpie.address_hint)}</p>
    <Button type="submit" size="sm" disabled={save.isPending || !canManage}>{t($ => $.magpie.save)}</Button>
    {save.isSuccess && <p role="status" className="text-sm">{t($ => $.magpie.saved)}</p>}
    {save.isError && <p role="alert" className="text-sm text-destructive">{save.error.message}</p>}
  </form>;
}
