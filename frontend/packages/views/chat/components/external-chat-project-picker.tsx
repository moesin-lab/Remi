"use client";

import type { ExternalChatProject } from "@multiremi/core/chat";
import { Combobox, ComboboxInput, ComboboxContent, ComboboxEmpty, ComboboxList, ComboboxItem } from "@multiremi/ui/components/ui/combobox";
import { useT } from "../../i18n";

export function ExternalChatProjectPicker({ projects, projectId, onChange }: {
  projects: ExternalChatProject[]; projectId: string; onChange: (id: string) => void;
}) {
  const { t } = useT("chat");
  const selected = projects.find(project => project.id === projectId);
  const options: { id: string; name: string; roots: string[] }[] = [{ id: "", name: t(($) => $.external.all_projects), roots: [] }, ...projects];

  return <div className="space-y-2">
    <Combobox items={options} value={options.find(option => option.id === projectId) ?? options[0]}
      onValueChange={option => { if (option) onChange(option.id); }}
      itemToStringLabel={option => option.name}
      itemToStringValue={option => option.id}
      filter={(option, query) => `${option.name} ${option.roots.join(" ")}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())}
      isItemEqualToValue={(option, value) => option.id === value.id}>
      <ComboboxInput className="w-full" aria-label={t(($) => $.external.search_projects)} placeholder={t(($) => $.external.search_projects)} />
      <ComboboxContent>
        <ComboboxEmpty>{t(($) => $.external.no_projects)}</ComboboxEmpty>
        <ComboboxList>{(option: { id: string; name: string }) => <ComboboxItem key={option.id} value={option}>{option.name}</ComboboxItem>}</ComboboxList>
      </ComboboxContent>
    </Combobox>
    {selected && <div className="rounded border p-2">
      <p className="break-words font-medium">{selected.name}</p>
      <p className="text-xs text-muted-foreground">{selected.kind === "native" ? t(($) => $.external.native_project) : selected.kind === "directory" ? t(($) => $.external.directory_project) : selected.kind}</p>
      {selected.roots.map(path => <p className="break-all text-xs text-muted-foreground" key={path}>{path}</p>)}
    </div>}
  </div>;
}
