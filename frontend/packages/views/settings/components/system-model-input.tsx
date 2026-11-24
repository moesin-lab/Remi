import { Autocomplete } from "@base-ui/react/autocomplete";
import { useState } from "react";
import { useSystemModelCatalog, type ExecutionEndpoint, type SystemProtocol } from "@multiremi/core/runtimes";
import { Button } from "@multiremi/ui/components/ui/button";
import { Input } from "@multiremi/ui/components/ui/input";
import { useT } from "../../i18n";

type Props = { id: string; value: string; onValueChange: (value: string) => void; placeholder: string; className: string;
  workspaceId: string; endpoint?: ExecutionEndpoint; protocol: SystemProtocol; pending?: boolean; inactive?: boolean };

export function SystemModelInput({ workspaceId, endpoint, protocol, pending, inactive, value, onValueChange, ...input }: Props) {
  const { t } = useT("settings");
  const catalog = useSystemModelCatalog(workspaceId, inactive ? undefined : endpoint, protocol);
  const disabled = endpoint?.connection.options?.fetch_models === false;
  const [open, setOpen] = useState(false);
  const term = value.trim().toLowerCase();
  const matches = catalog.models.filter(model => model.id.toLowerCase().includes(term) || model.name?.toLowerCase().includes(term));
  return <>
    <Autocomplete.Root items={catalog.models} filteredItems={matches} value={value} onValueChange={onValueChange} openOnInputClick modal={false}
      open={open && !inactive && matches.length > 0} onOpenChange={setOpen} itemToStringValue={model => model.id}>
      <Autocomplete.Input {...input} render={<Input />} />
      {!inactive && <Autocomplete.Portal>
        <Autocomplete.Positioner sideOffset={4} className="z-50 w-(--anchor-width)">
          <Autocomplete.Popup className="max-h-56 overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-md">
            <Autocomplete.List>{(model: (typeof catalog.models)[number]) => <Autocomplete.Item key={model.id} value={model}
              className="cursor-pointer px-2 py-1 text-sm data-highlighted:bg-accent">
              <span className="break-all font-mono">{model.id}</span>{model.name && model.name !== model.id && <span className="ml-2">{model.name}</span>}
            </Autocomplete.Item>}</Autocomplete.List>
          </Autocomplete.Popup>
        </Autocomplete.Positioner>
      </Autocomplete.Portal>}
    </Autocomplete.Root>
    {!inactive && <>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {endpoint && <span>{protocol}</span>}
        <span role="status">
          {pending || catalog.loading ? t($ => $.modelGateway.catalog_loading)
            : !endpoint ? t($ => $.modelGateway.catalog_unbound)
            : disabled ? t($ => $.modelGateway.catalog_disabled)
            : catalog.failed && catalog.code === "empty_catalog" ? t($ => $.modelGateway.catalog_empty)
            : catalog.failed ? `${t($ => $.modelGateway.catalog_error)} ${catalog.code ?? ""}`
            : !catalog.models.length ? t($ => $.modelGateway.catalog_empty) : null}
          {catalog.stale && ` ${t($ => $.modelGateway.catalog_stale)} ${new Date(catalog.stale).toLocaleString()}`}
        </span>
        {endpoint && !disabled && <Button type="button" variant="outline" size="sm" disabled={catalog.loading} onClick={() => void catalog.refresh()}>
          {t($ => $.modelGateway.catalog_refresh)}
        </Button>}
      </div>
    </>}
  </>;
}
