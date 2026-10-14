"use client";

import type { ExternalChatProject } from "@multiremi/core/chat";
import { Combobox, ComboboxInput, ComboboxContent, ComboboxEmpty, ComboboxList, ComboboxItem } from "@multiremi/ui/components/ui/combobox";
import { useT } from "../../i18n";

export function ExternalChatProjectPicker({ projects, projectId, onChange }: {
  projects: ExternalChatProject[]; projectId: string; onChange: (id: string) => void;
}) {
  const { t } = useT("chat");
  const projectsById = new Map(projects.map(project => [project.id, project]));
  const selected = projectsById.get(projectId);
  const options = ["", ...projectsById.keys()];

  return <div className="space-y-2">
    <Combobox items={options} value={selected ? projectId : ""}
      onValueChange={id => { if (id !== null) onChange(id); }}
      itemToStringLabel={id => projectsById.get(id)?.name ?? t(($) => $.external.all_projects)}
      filter={(id, query) => {
        const option = projectsById.get(id);
        const text = option ? `${option.name} ${option.roots.join(" ")}` : t(($) => $.external.all_projects);
        return text.toLocaleLowerCase().includes(query.toLocaleLowerCase());
      }}>
      <ComboboxInput className="w-full" aria-label={t(($) => $.external.search_projects)} placeholder={t(($) => $.external.search_projects)} />
      <ComboboxContent>
        <ComboboxEmpty>{t(($) => $.external.no_projects)}</ComboboxEmpty>
        <ComboboxList>{(id: string) => {
          const option = projectsById.get(id);
          return <ComboboxItem key={id} value={id} className="items-start py-2">
            <span className="min-w-0">
              <span className="block break-words">{option?.name ?? t(($) => $.external.all_projects)}</span>
              {option && <>
                <span className="block text-xs text-muted-foreground">{option.kind === "native" ? t(($) => $.external.native_project) : option.kind === "directory" ? t(($) => $.external.directory_project) : option.kind}</span>
                <span className="block break-all text-xs text-muted-foreground">{option.roots.join(" · ")}</span>
              </>}
            </span>
          </ComboboxItem>;
        }}</ComboboxList>
      </ComboboxContent>
    </Combobox>
    {selected && <div className="rounded border p-2">
      <p className="break-words font-medium">{selected.name}</p>
      <p className="text-xs text-muted-foreground">{selected.kind === "native" ? t(($) => $.external.native_project) : selected.kind === "directory" ? t(($) => $.external.directory_project) : selected.kind}</p>
      {selected.roots.map(path => <p className="break-all text-xs text-muted-foreground" key={path}>{path}</p>)}
    </div>}
  </div>;
}
