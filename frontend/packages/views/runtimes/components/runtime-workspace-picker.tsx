"use client";

import { useQuery } from "@tanstack/react-query";
import { runtimeWorkspacesOptions } from "@multiremi/core/runtimes/workspaces";
import { useT } from "../../i18n";

export function RuntimeWorkspacePicker({ wsId, value, onChange, disabled = false }: {
  wsId: string;
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
}) {
  const { t } = useT("runtimes");
  const { data: workspaces = [], isPending, isError } = useQuery(runtimeWorkspacesOptions(wsId));
  const selected = workspaces.find(w => w.id === value);
  return (
    <div className="min-w-0 max-w-full space-y-1">
      <select
        aria-label={t($ => $.workspaces.picker_label)}
        title={selected ? `${selected.root_path} / ${selected.cwd}` : t($ => $.workspaces.automatic)}
        value={value ?? ""}
        disabled={disabled || isPending || isError}
        onChange={e => onChange(e.target.value || null)}
        className="h-8 w-full max-w-full truncate rounded-md border bg-background px-2 text-xs text-foreground disabled:opacity-60"
      >
        <option value="">{t($ => $.workspaces.automatic)}</option>
        {value && !selected && <option value={value}>{value} · {t($ => $.workspaces.unavailable)}</option>}
        {workspaces.map(w => <option key={w.id} value={w.id}>
          {w.name} · {w.daemon_id.slice(0, 8)}{w.status === "available" ? "" : ` · ${t($ => $.workspaces.unavailable)}`}
        </option>)}
      </select>
      {isError && <p role="alert" className="text-xs text-destructive">{t($ => $.workspaces.load_failed)}</p>}
      {selected?.status === "unavailable" && <p className="text-xs text-muted-foreground">{t($ => $.workspaces.wait_hint)}</p>}
    </div>
  );
}
