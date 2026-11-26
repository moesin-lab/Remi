"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeftRight, Eye, History, Loader2, RotateCcw } from "lucide-react";
import { api } from "@multiremi/core/api";
import type {
  SystemPromptSlots,
  SystemPromptState,
  SystemPromptVersionSummary,
} from "@multiremi/core/types";
import { workspaceSystemPromptVersionOptions } from "@multiremi/core/workspace/queries";
import { Badge } from "@multiremi/ui/components/ui/badge";
import { Button } from "@multiremi/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@multiremi/ui/components/ui/dialog";
import { useT } from "../../i18n";
import { SYSTEM_PROMPT_SLOT_KEYS, shortHash } from "../lib/system-prompt-utils";
import { SystemPromptDiffView } from "./system-prompt-diff";

export type DiffSourceKey =
  | "current"
  | "latest_default"
  | "base_default"
  | "draft"
  | `version:${string}`;

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function actorLabel(
  actor: SystemPromptVersionSummary["actor"],
  systemLabel: string,
  unknownLabel: string,
): string {
  if (actor.displayName) return actor.displayName;
  if (actor.type === "system") return systemLabel;
  return actor.userId ?? actor.operatorId ?? unknownLabel;
}

export function useFormatSystemPromptLabels() {
  const { t } = useT("settings");

  const modeLabel = (mode: string) => {
    if (mode === "default") return t(($) => $.prompts.system_policy.mode_default);
    if (mode === "custom") return t(($) => $.prompts.system_policy.mode_custom);
    return mode;
  };

  const operationLabel = (operation: string) => {
    if (operation === "initialize") return t(($) => $.prompts.history.op_initialize);
    if (operation === "edit") return t(($) => $.prompts.history.op_edit);
    if (operation === "reset") return t(($) => $.prompts.history.op_reset);
    if (operation === "rollback") return t(($) => $.prompts.history.op_rollback);
    return operation;
  };

  return { modeLabel, operationLabel };
}

export interface SystemPromptHistoryListProps {
  workspaceId: string;
  versions: SystemPromptVersionSummary[];
  loading: boolean;
  error: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  canManage: boolean;
  onRetry: () => void;
  onLoadMore: () => void;
  onInspect: (version: SystemPromptVersionSummary) => void;
  onCompare: (left: DiffSourceKey, right: DiffSourceKey) => void;
  onRestore: (version: SystemPromptVersionSummary) => void;
}

export function SystemPromptHistoryList({
  versions,
  loading,
  error,
  hasMore,
  loadingMore,
  canManage,
  onRetry,
  onLoadMore,
  onInspect,
  onCompare,
  onRestore,
}: SystemPromptHistoryListProps) {
  const { t } = useT("settings");
  const { modeLabel, operationLabel } = useFormatSystemPromptLabels();

  const versionNumberById = useMemo(() => {
    const map = new Map<string, number>();
    for (const version of versions) {
      map.set(version.id, version.versionNumber);
    }
    return map;
  }, [versions]);

  return (
    <section aria-label={t(($) => $.prompts.history.title)} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-1.5 text-sm font-medium">
            <History className="size-4 text-muted-foreground" />
            {t(($) => $.prompts.history.title)}
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t(($) => $.prompts.history.description)}
          </p>
        </div>
        {versions.length >= 2 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onCompare(`version:${versions[1]!.id}`, `version:${versions[0]!.id}`)}
          >
            <ArrowLeftRight className="size-3.5" />
            {t(($) => $.prompts.history.compare_versions)}
          </Button>
        )}
      </div>

      {loading ? (
        <div className="flex min-h-24 items-center justify-center rounded-md border">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs">
          <span className="text-destructive">{t(($) => $.prompts.history.load_failed)}</span>
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            {t(($) => $.prompts.retry)}
          </Button>
        </div>
      ) : versions.length === 0 ? (
        <div className="rounded-md border border-dashed px-4 py-6 text-center text-xs text-muted-foreground">
          {t(($) => $.prompts.history.empty)}
        </div>
      ) : (
        <div className="divide-y rounded-md border">
          {versions.map((version) => {
            const restoredFromNum = version.restoredFromVersionId
              ? versionNumberById.get(version.restoredFromVersionId)
              : undefined;
            const actor = actorLabel(
              version.actor,
              t(($) => $.prompts.history.actor_system),
              t(($) => $.prompts.history.actor_unknown),
            );

            return (
              <div
                key={version.id}
                data-version-row={version.versionNumber}
                className="flex flex-wrap items-start justify-between gap-3 px-3 py-2.5"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-xs font-semibold">v{version.versionNumber}</span>
                    {version.isCurrent && (
                      <Badge variant="default" className="text-[11px]">
                        {t(($) => $.prompts.history.current_badge)}
                      </Badge>
                    )}
                    <Badge variant={version.mode === "custom" ? "secondary" : "outline"} className="text-[11px]">
                      {modeLabel(version.mode)}
                    </Badge>
                    <Badge variant="outline" className="text-[11px]">
                      {operationLabel(version.operation)}
                    </Badge>
                    {version.restoredFromVersionId && (
                      <span className="text-[11px] text-muted-foreground">
                        {restoredFromNum !== undefined
                          ? t(($) => $.prompts.history.restored_from_number, { version: restoredFromNum })
                          : t(($) => $.prompts.history.restored_from_id, { id: shortHash(version.restoredFromVersionId, 10) })}
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                    <span>{actor}</span>
                    <span>{formatTimestamp(version.createdAt)}</span>
                    <span className="font-mono text-[11px]" title={version.contentHash}>
                      #{shortHash(version.contentHash)}
                    </span>
                  </div>

                  {version.changeNote && (
                    <p className="break-words text-xs text-foreground whitespace-pre-wrap">
                      {version.changeNote}
                    </p>
                  )}
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => onInspect(version)}
                  >
                    <Eye className="size-3.5" />
                    {t(($) => $.prompts.history.view)}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => onCompare(`version:${version.id}`, "latest_default")}
                  >
                    <ArrowLeftRight className="size-3.5" />
                    {t(($) => $.prompts.history.compare)}
                  </Button>
                  {canManage && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => onRestore(version)}
                    >
                      <RotateCcw className="size-3.5" />
                      {t(($) => $.prompts.history.restore)}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {hasMore && (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loadingMore}
            onClick={onLoadMore}
          >
            {loadingMore && <Loader2 className="size-3.5 animate-spin" />}
            {t(($) => $.prompts.history.load_more)}
          </Button>
        </div>
      )}
    </section>
  );
}

export interface SystemPromptVersionDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  versionSummary: SystemPromptVersionSummary | null;
  canManage: boolean;
  onCompareWithCurrent: (versionId: string) => void;
  onCompareWithDefault: (versionId: string) => void;
  onRestore: (version: SystemPromptVersionSummary) => void;
}

export function SystemPromptVersionDetailDialog({
  open,
  onOpenChange,
  workspaceId,
  versionSummary,
  canManage,
  onCompareWithCurrent,
  onCompareWithDefault,
  onRestore,
}: SystemPromptVersionDetailDialogProps) {
  const { t } = useT("settings");
  const { modeLabel, operationLabel } = useFormatSystemPromptLabels();

  const detail = useQuery({
    ...workspaceSystemPromptVersionOptions(workspaceId, open ? (versionSummary?.id ?? null) : null),
  });

  const active = detail.data ?? versionSummary;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[min(85vh,50rem)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden sm:!max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            <span>
              {active
                ? t(($) => $.prompts.history.detail_title, { version: active.versionNumber })
                : t(($) => $.prompts.history.title)}
            </span>
            {active?.isCurrent && (
              <Badge variant="default" className="text-[11px]">
                {t(($) => $.prompts.history.current_badge)}
              </Badge>
            )}
            {active && (
              <>
                <Badge variant={active.mode === "custom" ? "secondary" : "outline"} className="text-[11px]">
                  {modeLabel(active.mode)}
                </Badge>
                <Badge variant="outline" className="text-[11px]">
                  {operationLabel(active.operation)}
                </Badge>
              </>
            )}
          </DialogTitle>
          {active && (
            <DialogDescription>
              {t(($) => $.prompts.history.detail_meta, {
                actor: actorLabel(
                  active.actor,
                  t(($) => $.prompts.history.actor_system),
                  t(($) => $.prompts.history.actor_unknown),
                ),
                time: formatTimestamp(active.createdAt),
                hash: shortHash(active.contentHash, 12),
              })}
            </DialogDescription>
          )}
        </DialogHeader>

        {detail.isPending ? (
          <div className="flex min-h-0 items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : detail.isError || !detail.data ? (
          <div className="flex min-h-0 flex-col items-center justify-center gap-3">
            <p className="text-sm text-destructive">{t(($) => $.prompts.history.detail_load_failed)}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void detail.refetch()}>
              {t(($) => $.prompts.retry)}
            </Button>
          </div>
        ) : (
          <div className="min-h-0 space-y-4 overflow-y-auto pr-1">
            {detail.data.changeNote && (
              <div className="rounded-md border bg-muted/20 px-3 py-2 text-xs">
                <p className="font-medium text-muted-foreground">{t(($) => $.prompts.change_note_label)}</p>
                <p className="mt-1 whitespace-pre-wrap break-words text-foreground">{detail.data.changeNote}</p>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onCompareWithCurrent(detail.data.id)}
              >
                <ArrowLeftRight className="size-3.5" />
                {t(($) => $.prompts.diff.compare_with_current)}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onCompareWithDefault(detail.data.id)}
              >
                <ArrowLeftRight className="size-3.5" />
                {t(($) => $.prompts.diff.compare_with_latest_default)}
              </Button>
              {canManage && (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => onRestore(detail.data)}
                >
                  <RotateCcw className="size-3.5" />
                  {t(($) => $.prompts.history.restore_as_new)}
                </Button>
              )}
            </div>

            <div className="space-y-3">
              {SYSTEM_PROMPT_SLOT_KEYS.map((slot) => (
                <section key={slot} className="space-y-1.5 rounded-md border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="text-xs font-medium">{t(($) => $.prompts.slots[slot].label)}</h4>
                    <span className="font-mono text-[11px] text-muted-foreground">{slot}</span>
                  </div>
                  {detail.data.content[slot] === "" ? (
                    <p className="text-xs italic text-muted-foreground">
                      {t(($) => $.prompts.diff.empty_slot)}
                    </p>
                  ) : (
                    <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/30 p-2.5 font-mono text-xs leading-relaxed text-foreground">
                      {detail.data.content[slot]}
                    </pre>
                  )}
                </section>
              ))}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export interface SystemPromptCompareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  state: SystemPromptState;
  draftContent: SystemPromptSlots;
  hasDraft: boolean;
  versions: SystemPromptVersionSummary[];
  initialLeft: DiffSourceKey;
  initialRight: DiffSourceKey;
}

function versionIdFromSource(source: DiffSourceKey): string | null {
  return source.startsWith("version:") ? source.slice("version:".length) : null;
}

export function SystemPromptCompareDialog({
  open,
  onOpenChange,
  workspaceId,
  state,
  draftContent,
  hasDraft,
  versions,
  initialLeft,
  initialRight,
}: SystemPromptCompareDialogProps) {
  const { t } = useT("settings");
  const { modeLabel, operationLabel } = useFormatSystemPromptLabels();
  const [leftSource, setLeftSource] = useState<DiffSourceKey>(initialLeft);
  const [rightSource, setRightSource] = useState<DiffSourceKey>(initialRight);

  useEffect(() => {
    if (open) {
      setLeftSource(initialLeft);
      setRightSource(initialRight);
    }
  }, [open, initialLeft, initialRight]);

  const leftVersionId = versionIdFromSource(leftSource);
  const rightVersionId = versionIdFromSource(rightSource);

  const leftQuery = useQuery({
    queryKey: ["workspaces", workspaceId, "system-prompt", "versions", leftVersionId ?? ""],
    queryFn: () => api.getWorkspaceSystemPromptVersion(workspaceId, leftVersionId!),
    enabled: open && Boolean(workspaceId && leftVersionId),
  });

  const rightQuery = useQuery({
    queryKey: ["workspaces", workspaceId, "system-prompt", "versions", rightVersionId ?? ""],
    queryFn: () => api.getWorkspaceSystemPromptVersion(workspaceId, rightVersionId!),
    enabled: open && Boolean(workspaceId && rightVersionId),
  });

  const options = useMemo(() => {
    const items: { value: DiffSourceKey; label: string }[] = [
      {
        value: "current",
        label: t(($) => $.prompts.diff.source_current, { revision: state.document.revision }),
      },
      {
        value: "latest_default",
        label: t(($) => $.prompts.diff.source_latest_default, {
          revision: shortHash(state.currentDefault.revision, 8),
        }),
      },
    ];
    if (state.document.mode === "custom") {
      items.push({
        value: "base_default",
        label: t(($) => $.prompts.diff.source_base_default, {
          revision: shortHash(state.baseDefault.revision, 8),
        }),
      });
    }
    if (hasDraft) {
      items.push({
        value: "draft",
        label: t(($) => $.prompts.diff.source_draft),
      });
    }
    for (const v of versions) {
      items.push({
        value: `version:${v.id}`,
        label: `v${v.versionNumber} · ${modeLabel(v.mode)} · ${operationLabel(v.operation)}`,
      });
    }
    return items;
  }, [state, hasDraft, versions, t, modeLabel, operationLabel]);

  function resolveContent(
    source: DiffSourceKey,
    versionData: { content: SystemPromptSlots } | undefined,
  ): SystemPromptSlots | null {
    if (source === "current") return state.content;
    if (source === "latest_default") return state.currentDefault.content;
    if (source === "base_default") return state.baseDefault.content;
    if (source === "draft") return draftContent;
    return versionData?.content ?? null;
  }

  function resolveLabel(source: DiffSourceKey): string {
    return options.find((opt) => opt.value === source)?.label ?? source;
  }

  const loading =
    (Boolean(leftVersionId) && leftQuery.isPending) ||
    (Boolean(rightVersionId) && rightQuery.isPending);
  const failed =
    (Boolean(leftVersionId) && leftQuery.isError) ||
    (Boolean(rightVersionId) && rightQuery.isError);

  const leftContent = resolveContent(leftSource, leftQuery.data);
  const rightContent = resolveContent(rightSource, rightQuery.data);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[min(85vh,52rem)] grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden sm:!max-w-5xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowLeftRight className="size-4 text-muted-foreground" />
            {t(($) => $.prompts.diff.title)}
          </DialogTitle>
          <DialogDescription>
            {t(($) => $.prompts.diff.description)}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 border-b pb-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs">
            <span className="font-medium text-muted-foreground">{t(($) => $.prompts.diff.base_label)}</span>
            <select
              aria-label={t(($) => $.prompts.diff.base_label)}
              value={leftSource}
              onChange={(event) => setLeftSource(event.target.value as DiffSourceKey)}
              className="w-full rounded-md border bg-background px-2.5 py-1.5 text-xs text-foreground"
            >
              {options.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs">
            <span className="font-medium text-muted-foreground">{t(($) => $.prompts.diff.target_label)}</span>
            <select
              aria-label={t(($) => $.prompts.diff.target_label)}
              value={rightSource}
              onChange={(event) => setRightSource(event.target.value as DiffSourceKey)}
              className="w-full rounded-md border bg-background px-2.5 py-1.5 text-xs text-foreground"
            >
              {options.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="min-h-0 overflow-y-auto pr-1">
          {loading ? (
            <div className="flex h-40 items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : failed || !leftContent || !rightContent ? (
            <div className="flex h-40 flex-col items-center justify-center gap-3">
              <p className="text-sm text-destructive">{t(($) => $.prompts.diff.load_failed)}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  if (leftVersionId) void leftQuery.refetch();
                  if (rightVersionId) void rightQuery.refetch();
                }}
              >
                {t(($) => $.prompts.retry)}
              </Button>
            </div>
          ) : (
            <SystemPromptDiffView
              leftLabel={resolveLabel(leftSource)}
              rightLabel={resolveLabel(rightSource)}
              leftContent={leftContent}
              rightContent={rightContent}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
