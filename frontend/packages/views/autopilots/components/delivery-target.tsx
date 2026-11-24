"use client";

import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@multiremi/core/api";
import { deliveryTargetsOptions } from "@multiremi/core/autopilots/queries";
import { useWorkspaceId } from "@multiremi/core/hooks";
import type { AutopilotDeliveryTarget } from "@multiremi/core/types";
import { useT } from "../../i18n";
import { PickerItem, PropertyPicker } from "../../issues/components/pickers/property-picker";

export function DeliveryTarget({ value, onChange }: {
  value: string | null | undefined;
  onChange?: (id: string | null) => void;
}) {
  const { t } = useT("autopilots");
  const wsId = useWorkspaceId();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const descriptionId = useId();
  const query = useQuery({ ...deliveryTargetsOptions(wsId), enabled: Boolean(value || onChange) });
  const targets = query.isSuccess && !query.isFetching ? query.data.targets : [];
  const selected = targets.find(target => target.id === value);
  const readError = query.error instanceof ApiError && query.error.status === 403
    ? t(($) => $.delivery.denied) : t(($) => $.delivery.read_error);
  const label = (target: AutopilotDeliveryTarget) => {
    const channel = target.channel === "web_chat" || target.channel === "feishu"
      ? t(($) => $.delivery[target.channel as "web_chat" | "feishu"])
      : t(($) => $.delivery.unknown_channel);
    return [target.title, channel, target.id].filter(Boolean).join(" · ");
  };
  let status: string;
  if (value === undefined) status = t(($) => $.delivery.unknown);
  else if (value === null) status = t(($) => $.delivery.unbound);
  else if (selected) status = label(selected);
  else {
    const reason = query.isFetching ? t(($) => $.delivery.loading) : query.isError
      ? readError : t(($) => $.delivery.unavailable);
    status = `${reason} · ${value}`;
  }
  if (!onChange) return <span className="break-words" title={status}>{status}</span>;
  const matches = targets.filter(target => label(target).toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()));
  const choose = (id: string) => {
    onChange(id);
    setOpen(false);
    setFilter("");
  };
  return <div className="space-y-1 text-sm">
    <p id={descriptionId} aria-live="polite">{status}</p>
    <PropertyPicker open={open} onOpenChange={setOpen} searchable align="start" width="w-72"
      onSearchChange={setFilter} searchPlaceholder={t(($) => $.delivery.choose)}
      triggerRender={<button type="button" aria-describedby={descriptionId} className="underline" />}
      trigger={t(($) => $.delivery.choose)}>
      {query.isError ? <button type="button" onClick={() => void query.refetch()}>{readError} · {t(($) => $.delivery.retry)}</button>
        : query.isFetching ? <p>{t(($) => $.delivery.loading)}</p>
        : matches.length === 0 ? <p>{t(($) => $.delivery.empty)}</p>
        : matches.map(target => <PickerItem key={target.id} selected={target.id === value} onClick={() => choose(target.id)}>
          <span className="break-all">{label(target)}</span>
        </PickerItem>)}
    </PropertyPicker>
    {value && <button type="button" className="ml-2 underline" onClick={() => onChange(null)}>{t(($) => $.delivery.clear)}</button>}
  </div>;
}
