"use client";
import { useEffect, useId } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "@multiremi/core/auth";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { memberListOptions } from "@multiremi/core/workspace/queries";
import { Label } from "@multiremi/ui/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@multiremi/ui/components/ui/native-select";
import { useT } from "../../i18n";

export function RootHumanPicker({ value, onChange, disabled = false, defaultSelf = false, automation = false, onClear, emptyLabel }: { value: string | null; onChange: (id: string) => void; disabled?: boolean; defaultSelf?: boolean; automation?: boolean; onClear?: () => void; emptyLabel?: string }) {
  const id = useId();
  const wsId = useWorkspaceId();
  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const userId = useAuthStore(s => s.user?.id);
  const available = members;
  const ownMemberId = available.find(member => member.user_id === userId)?.id;
  useEffect(() => { if (defaultSelf && !value && ownMemberId) onChange(ownMemberId); }, [defaultSelf, value, ownMemberId, onChange]);
  const { t } = useT("issues");
  return <div className="min-w-0 space-y-1.5">
    <Label htmlFor={id}>{t($ => $.responsibility.human)}</Label>
    <NativeSelect id={id} className="w-full min-w-0" aria-label={t($ => $.responsibility.human)} value={value ?? ""} disabled={disabled} onChange={e => e.target.value ? onChange(e.target.value) : onClear?.()}>
      <NativeSelectOption value="">{emptyLabel ?? t($ => $.responsibility.select)}</NativeSelectOption>
      {available.map(member => <NativeSelectOption key={member.id} value={member.id}>{member.name}</NativeSelectOption>)}
    </NativeSelect>
    {automation && !value && <p className="text-xs text-muted-foreground">{t($ => $.responsibility.automation_hint)}</p>}
  </div>;
}
