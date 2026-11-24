import type { ComponentProps } from "react";
import { useSystemModelCatalog, type ExecutionEndpoint, type SystemProtocol } from "@multiremi/core/runtimes";
import { Button } from "@multiremi/ui/components/ui/button";
import { Input } from "@multiremi/ui/components/ui/input";
import { useT } from "../../i18n";

type Props = ComponentProps<typeof Input> & { workspaceId: string; endpoint?: ExecutionEndpoint; protocol: SystemProtocol; pending?: boolean; inactive?: boolean };

export function SystemModelInput({ workspaceId, endpoint, protocol, pending, inactive, ...input }: Props) {
  const { t } = useT("settings");
  const catalog = useSystemModelCatalog(workspaceId, inactive ? undefined : endpoint, protocol);
  const listId = `${input.id}-models`;
  const disabled = endpoint?.connection.options?.fetch_models === false;
  return <>
    <Input {...input} list={inactive ? undefined : listId} />
    {!inactive && <>
      <datalist id={listId}>
        {catalog.models.map(model => <option key={model.id} value={model.id} label={model.name ?? model.id} />)}
      </datalist>
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
