"use client";

import type { ReactNode } from "react";
import { Activity, BookText, ListTodo } from "lucide-react";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@multiremi/ui/components/ui/tabs";
import { useWorkspacePaths } from "@multiremi/core/paths";
import { ProjectWikiSection } from "./project-wiki-section";
import { useNavigation } from "../../../navigation";
import { useT } from "../../../i18n";

export type ProjectContentTab = "issues" | "wiki" | "activity";

/**
 * Issues | Wiki switch for the project detail content panel.
 *
 * The issues surface arrives as a slot rather than being rendered here, so the
 * board doesn't have to know it lives behind a tab. Both branches are real
 * `TabsContent` panels: Base UI derives each tab's `aria-controls` from the
 * panel registered under the matching value, so rendering the content as a
 * sibling of the tab list would leave a tablist whose tabs control nothing and
 * a content region with no `tabpanel` role. The panels re-create the flex
 * column the panel column used to provide directly (`text-base` pins the
 * inherited font size the surfaces were built against — `TabsContent` ships
 * `text-sm`). The active tab is route state, not local state: the caller
 * derives it from the URL (`/projects/:id` vs `…/wiki`) and picking a tab
 * navigates, so a wiki page survives a refresh and can be shared.
 */
export function ProjectContentTabs({
  projectId,
  issues,
  activity,
  contentTab,
  wikiSlug,
}: {
  projectId: string;
  issues?: ReactNode;
  activity?: ReactNode;
  contentTab: ProjectContentTab;
  wikiSlug?: string;
}) {
  const { t } = useT("projects");
  const paths = useWorkspacePaths();
  const { push } = useNavigation();

  return (
    <Tabs
      value={contentTab}
      onValueChange={(value) =>
        push(
          value === "wiki"
            ? paths.projectWiki(projectId)
            : value === "activity" ? paths.projectActivity(projectId) : paths.projectDetail(projectId),
        )
      }
      className="min-h-0 flex-1 gap-0"
    >
      <TabsList variant="line" className="mx-3 mt-2 shrink-0">
        <TabsTrigger value="issues">
          <ListTodo className="h-4 w-4" />
          {t(($) => $.wiki.tab_issues)}
        </TabsTrigger>
        <TabsTrigger value="wiki">
          <BookText className="h-4 w-4" />
          {t(($) => $.wiki.tab_wiki)}
        </TabsTrigger>
        <TabsTrigger value="activity"><Activity className="h-4 w-4" />{t(($) => $.activity.title)}</TabsTrigger>
      </TabsList>
      <TabsContent value="issues" className="flex min-h-0 flex-col text-base">
        {issues}
      </TabsContent>
      <TabsContent value="wiki" className="flex min-h-0 flex-col text-base">
        <ProjectWikiSection projectId={projectId} selectedRef={wikiSlug} />
      </TabsContent>
      <TabsContent value="activity" className="flex min-h-0 flex-col text-base">{activity}</TabsContent>
    </Tabs>
  );
}
