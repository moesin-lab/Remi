"use client";

import { useState, useRef } from "react";
import {
  ChevronRight,
  FolderKanban,
  Maximize2,
  Minimize2,
  Search,
  X as XIcon,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useCreateProject } from "@multiremi/core/projects/mutations";
import { useProjectDraftStore } from "@multiremi/core/projects";
import { repositoryListOptions } from "@multiremi/core/repositories";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useCurrentWorkspace, useWorkspacePaths } from "@multiremi/core/paths";
import type { IssueAssigneeType, WorkspaceRepository } from "@multiremi/core/types";
import { cn } from "@multiremi/ui/lib/utils";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle } from "@multiremi/ui/components/ui/dialog";
import { Popover, PopoverTrigger, PopoverContent } from "@multiremi/ui/components/ui/popover";
import { Tooltip, TooltipTrigger, TooltipContent } from "@multiremi/ui/components/ui/tooltip";
import { Button } from "@multiremi/ui/components/ui/button";
import { Input } from "@multiremi/ui/components/ui/input";
import { EmojiPicker } from "@multiremi/ui/components/common/emoji-picker";
import { ContentEditor, type ContentEditorRef, TitleEditor } from "../editor";
import { RepositoryOptionRow } from "../repositories/repository-option-row";
import { AssigneePicker } from "../issues/components/pickers/assignee-picker";
import { useNavigation } from "../navigation";
import { useT } from "../i18n";

const EMPTY_REPOSITORIES: WorkspaceRepository[] = [];

function PillButton({
  children,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
        "hover:bg-accent/60 transition-colors cursor-pointer",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function CreateProjectModal({ onClose }: { onClose: () => void }) {
  const { t } = useT("modals");
  const router = useNavigation();
  const workspace = useCurrentWorkspace();
  const workspaceName = workspace?.name;
  const wsPaths = useWorkspacePaths();
  const wsId = useWorkspaceId();
  const { data: repositoryResponse, isLoading: repositoriesLoading } = useQuery(
    repositoryListOptions(wsId),
  );
  const repositories = repositoryResponse?.repositories ?? EMPTY_REPOSITORIES;

  const draft = useProjectDraftStore((s) => s.draft);
  const setDraft = useProjectDraftStore((s) => s.setDraft);
  const clearDraft = useProjectDraftStore((s) => s.clearDraft);

  const [title, setTitle] = useState(draft.title);
  const descEditorRef = useRef<ContentEditorRef>(null);
  const [defaultAssigneeType, setDefaultAssigneeType] = useState<"agent" | "squad" | null>(
    draft.defaultAssigneeType ?? null,
  );
  const [defaultAssigneeId, setDefaultAssigneeId] = useState<string | null>(
    draft.defaultAssigneeId ?? null,
  );
  const [icon, setIcon] = useState<string | undefined>(draft.icon);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [repositorySearch, setRepositorySearch] = useState("");
  const [selectedRepositoryIds, setSelectedRepositoryIds] = useState<string[]>([]);

  const normalizedRepositorySearch = repositorySearch.trim().toLowerCase();
  const filteredRepositories = repositories.filter((repository) => {
    if (!normalizedRepositorySearch) return true;
    return [repository.name, repository.url, repository.description]
      .filter(Boolean)
      .some((value) => value!.toLowerCase().includes(normalizedRepositorySearch));
  });
  const selectedRepositories = repositories.filter((repository) =>
    selectedRepositoryIds.includes(repository.id),
  );

  const toggleRepository = (repositoryId: string) => {
    setSelectedRepositoryIds((current) =>
      current.includes(repositoryId)
        ? current.filter((id) => id !== repositoryId)
        : [...current, repositoryId],
    );
  };

  // Sync field changes to draft store
  const updateTitle = (v: string) => { setTitle(v); setDraft({ title: v }); };
  const updateDefaultAssignee = (type: IssueAssigneeType | null, id: string | null) => {
    if (type === "member") return;
    setDefaultAssigneeType(type);
    setDefaultAssigneeId(id);
    setDraft({ defaultAssigneeType: type, defaultAssigneeId: id });
  };
  const updateIcon = (v: string | undefined) => { setIcon(v); setDraft({ icon: v }); };




  const createProject = useCreateProject();

  const handleSubmit = async () => {
    if (!title.trim() || selectedRepositories.length === 0 || submitting) return;
    const resources = selectedRepositories.map((repository) => ({
      resource_type: "github_repo" as const,
      resource_ref: {
        url: repository.url,
        ...(repository.default_branch
          ? { default_branch_hint: repository.default_branch }
          : {}),
      },
    }));
    setSubmitting(true);
    try {
      const project = await createProject.mutateAsync({
        title: title.trim(),
        description: descEditorRef.current?.getMarkdown()?.trim() || undefined,
        icon,
        lead_type: null,
        lead_id: null,
        default_assignee_type: defaultAssigneeType,
        default_assignee_id: defaultAssigneeId,
        // Server attaches these in the same transaction as the project.
        resources,
      });
      clearDraft();
      onClose();
      toast.success(t(($) => $.create_project.toast_created));
      router.push(wsPaths.projectDetail(project.id));
    } catch (err) {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t(($) => $.create_project.toast_failed),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        className={cn(
          "p-0 gap-0 flex flex-col overflow-hidden",
          "!top-1/2 !left-1/2 !-translate-x-1/2",
          "!transition-all !duration-300 !ease-out",
          isExpanded
            ? "!max-w-4xl !w-full !h-5/6 !-translate-y-1/2"
            : "!max-w-2xl !w-full !h-[34rem] !-translate-y-1/2",
        )}
      >
        <DialogTitle className="sr-only">{t(($) => $.create_project.title)}</DialogTitle>

        <div className="flex items-center justify-between px-5 pt-3 pb-2 shrink-0">
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">{workspaceName}</span>
            <ChevronRight className="size-3 text-muted-foreground/50" />
            <span className="font-medium">{t(($) => $.create_project.title_breadcrumb)}</span>
          </div>
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={() => setIsExpanded(!isExpanded)}
                    className="rounded-sm p-1.5 opacity-70 hover:opacity-100 hover:bg-accent/60 transition-all cursor-pointer"
                  >
                    {isExpanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
                  </button>
                }
              />
              <TooltipContent side="bottom">
                {isExpanded
                  ? t(($) => $.common.collapse_tooltip)
                  : t(($) => $.common.expand_tooltip)}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={onClose}
                    className="rounded-sm p-1.5 opacity-70 hover:opacity-100 hover:bg-accent/60 transition-all cursor-pointer"
                  >
                    <XIcon className="size-4" />
                  </button>
                }
              />
              <TooltipContent side="bottom">{t(($) => $.common.close)}</TooltipContent>
            </Tooltip>
          </div>
        </div>

        <div className="px-5 pb-2 shrink-0">
          <Popover open={iconPickerOpen} onOpenChange={setIconPickerOpen}>
            <PopoverTrigger
              render={
                <button
                  type="button"
                  className={cn(
                    "cursor-pointer rounded-lg p-1 -ml-1 hover:bg-accent/60 transition-colors",
                    icon ? "text-2xl" : "text-muted-foreground",
                  )}
                  title={t(($) => $.create_project.icon_tooltip)}
                >
                {icon || <FolderKanban className="size-5" />}
                </button>
              }
            />
            <PopoverContent align="start" className="w-auto p-0">
              <EmojiPicker
                onSelect={(emoji) => {
                  updateIcon(emoji);
                  setIconPickerOpen(false);
                }}
              />
            </PopoverContent>
          </Popover>
          <TitleEditor
            autoFocus
            defaultValue={draft.title}
            placeholder={t(($) => $.create_project.title_placeholder)}
            className="text-lg font-semibold"
            onChange={(v) => updateTitle(v)}
            onSubmit={handleSubmit}
          />
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-4">
          <div className="min-h-16">
            <ContentEditor
              ref={descEditorRef}
              defaultValue={draft.description}
              placeholder={t(($) => $.create_project.description_placeholder)}
              onUpdate={(md) => setDraft({ description: md })}
              debounceMs={500}
            />
          </div>

          <section className="mt-3" aria-labelledby="create-project-repositories">
            <div className="mb-2 flex items-start justify-between gap-4">
              <div>
                <h3 id="create-project-repositories" className="text-sm font-medium">
                  {t(($) => $.create_project.repositories_label)}
                </h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t(($) => $.create_project.repositories_description)}
                </p>
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">
                {t(($) => $.create_project.repositories_selected, {
                  count: selectedRepositories.length,
                })}
              </span>
            </div>

            <div className="relative mb-2">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={repositorySearch}
                onChange={(event) => setRepositorySearch(event.target.value)}
                aria-label={t(($) => $.create_project.repository_search_placeholder)}
                placeholder={t(($) => $.create_project.repository_search_placeholder)}
                className="pl-8"
              />
            </div>

            <div className="max-h-48 overflow-y-auto rounded-lg border">
              {repositoriesLoading ? (
                <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                  {t(($) => $.create_project.repository_loading)}
                </div>
              ) : filteredRepositories.length > 0 ? (
                filteredRepositories.map((repository) => {
                  const checked = selectedRepositoryIds.includes(repository.id);

                  return (
                    <RepositoryOptionRow
                      key={repository.id}
                      repository={repository}
                      checked={checked}
                      onToggle={() => toggleRepository(repository.id)}
                    />
                  );
                })
              ) : repositories.length > 0 ? (
                <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                  {t(($) => $.create_project.repository_search_empty)}
                </div>
              ) : (
                <div className="flex flex-col items-center px-3 py-6 text-center">
                  <p className="text-sm text-muted-foreground">
                    {t(($) => $.create_project.repository_empty)}
                  </p>
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="mt-1 h-auto px-0"
                    onClick={() => {
                      onClose();
                      router.push(wsPaths.repositories());
                    }}
                  >
                    {t(($) => $.create_project.manage_repositories)}
                  </Button>
                </div>
              )}
            </div>
          </section>
        </div>

        <div className="flex items-center justify-between gap-2 px-4 py-3 border-t shrink-0">
          <div className="flex items-center gap-1.5 flex-wrap min-w-0">
          <AssigneePicker
            assigneeType={defaultAssigneeType}
            assigneeId={defaultAssigneeId}
            allowedTypes={["agent", "squad"]}
            unassignedLabel={t(($) => $.create_project.default_executor)}
            onUpdate={(updates) =>
              updateDefaultAssignee(
                updates.assignee_type ?? null,
                updates.assignee_id ?? null,
              )
            }
            align="start"
            triggerRender={<PillButton />}
          />

          </div>

          {!title.trim() || selectedRepositories.length === 0 ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  // A disabled button can't receive focus, so the trigger wraps
                  // it in a focusable span — keyboard users can still summon the
                  // reason the submit is blocked.
                  <span className="shrink-0" tabIndex={0}>
                    <Button size="sm" onClick={handleSubmit} disabled>
                      {t(($) => $.create_project.submit)}
                    </Button>
                  </span>
                }
              />
              <TooltipContent side="top">
                {!title.trim()
                  ? t(($) => $.create_project.title_required)
                  : t(($) => $.create_project.repository_required)}
              </TooltipContent>
            </Tooltip>
          ) : (
            <Button
              size="sm"
              onClick={handleSubmit}
              disabled={submitting}
              className="shrink-0"
            >
              {submitting ? t(($) => $.create_project.submitting) : t(($) => $.create_project.submit)}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
