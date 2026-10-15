"use client";

import { useEffect, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { externalChatModelsOptions, type ExternalChatModel } from "@multiremi/core/chat";
import { Button } from "@multiremi/ui/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@multiremi/ui/components/ui/popover";
import { ChevronDown } from "lucide-react";
import { useT } from "../../i18n";

export function ExternalChatModelPicker({ ws, runtime, source, online, supported, disabled, currentModel, value, onChange }: {
  ws: string; runtime: string; source: string; online: boolean; supported: boolean; disabled: boolean;
  currentModel: string | null; value: ExternalChatModel | null; onChange: (model: ExternalChatModel | null) => void;
}) {
  const { t } = useT("chat");
  const [open, setOpen] = useState(false);
  const catalog = useInfiniteQuery(externalChatModelsOptions(ws, runtime, source, open && online && supported));
  const { hasNextPage, isFetching, isError, fetchNextPage } = catalog;
  const models = [...new Map(catalog.data?.pages.flatMap(page => page.models).map(model => [model.id, model]) ?? []).values()];

  useEffect(() => {
    if (open && online && supported && hasNextPage && !isFetching && !isError) void fetchNextPage();
  }, [open, online, supported, hasNextPage, isFetching, isError, fetchNextPage]);

  const choose = (model: ExternalChatModel | null) => {
    if (disabled || !supported) return;

    onChange(model);
    setOpen(false);
  };

  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger render={<Button type="button" variant="ghost" size="sm" disabled={disabled}
      aria-label={t(($) => $.external.model_select)} title={value?.id ?? currentModel ?? undefined}
      className="max-w-44 shrink-0 bg-muted px-2 text-xs text-muted-foreground" />}>
      <span className="truncate">{value?.name || value?.id || currentModel || t(($) => $.external.model_inherit)}</span><ChevronDown className="size-3" />
    </PopoverTrigger>
    <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)] space-y-3">
      {currentModel && <p className="break-all text-xs text-muted-foreground">{t(($) => $.external.model_current, { model: currentModel })}</p>}
      <p className="text-xs text-muted-foreground">{t(($) => $.external.model_next_message)}</p>
      {!supported ? <p role="status" className="text-sm">{t(($) => $.external.model_upgrade)}</p> : <>
        <Button type="button" variant="outline" size="sm" className="w-full" disabled={disabled} aria-pressed={!value} onClick={() => choose(null)}>{t(($) => $.external.model_inherit)}</Button>
        <div className="max-h-64 space-y-1 overflow-y-auto">
          {models.map(model => <button type="button" key={model.id} disabled={disabled} aria-pressed={value?.id === model.id}
            className="block w-full rounded-md px-2 py-2 text-left text-sm hover:bg-accent disabled:pointer-events-none disabled:opacity-50" onClick={() => choose(model)}>
            <span className="block break-words font-medium">{model.name || model.id}</span>
            {model.name && model.name !== model.id && <span className="block break-all text-xs text-muted-foreground">{model.id}</span>}
            {model.description && <span className="block break-words text-xs text-muted-foreground">{model.description}</span>}
          </button>)}
        </div>
        {(catalog.isFetching || (online && catalog.hasNextPage && !catalog.isError)) && <p role="status" className="text-xs text-muted-foreground">{t(($) => $.external.model_loading)}</p>}
        {catalog.data && !catalog.isFetching && !catalog.hasNextPage && models.length === 0 && <p role="status" className="text-sm">{t(($) => $.external.model_empty)}</p>}
        {catalog.isError && <div role="alert" className="space-y-1 text-sm text-destructive">
          <p>{t(($) => $.external.model_failed)}</p><p className="break-words text-xs">{catalog.error.message}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void (catalog.isFetchNextPageError ? catalog.fetchNextPage() : catalog.refetch())}>{t(($) => $.page.retry)}</Button>
        </div>}
      </>}
    </PopoverContent>
  </Popover>;
}
