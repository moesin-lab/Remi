"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeftRight,
  ChevronRight,
  Eye,
  Info,
  Loader2,
  RotateCcw,
  Save,
  Sparkles,
  Undo2,
} from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@multiremi/core/api";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { createRequestId } from "@multiremi/core/utils";
import { workspaceOperatorUser } from "@multiremi/core/workspace/operator";
import {
  memberListOptions,
  workspaceKeys,
  workspaceSystemPromptOptions,
} from "@multiremi/core/workspace/queries";
import type {
  SystemPromptSlotKey,
  SystemPromptSlots,
  SystemPromptState,
  SystemPromptVersionSummary,
  WorkspacePromptSettings,
} from "@multiremi/core/types";
import { Alert, AlertDescription, AlertTitle } from "@multiremi/ui/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@multiremi/ui/components/ui/alert-dialog";
import { Badge } from "@multiremi/ui/components/ui/badge";
import { Button } from "@multiremi/ui/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@multiremi/ui/components/ui/collapsible";
import { Input } from "@multiremi/ui/components/ui/input";
import { Separator } from "@multiremi/ui/components/ui/separator";
import { Textarea } from "@multiremi/ui/components/ui/textarea";
import { cn } from "@multiremi/ui/lib/utils";
import { useT } from "../../i18n";
import {
  areSystemPromptSlotsEqual,
  countSystemPromptCodePoints,
  countUnicodeCodePoints,
  DEFAULT_MAX_SYSTEM_PROMPT_CODE_POINTS,
  normalizeSystemPromptSlots,
  parseSystemPromptApiError,
  shortHash,
  SYSTEM_PROMPT_SLOT_KEYS,
} from "../lib/system-prompt-utils";
import {
  SystemPromptCompareDialog,
  SystemPromptHistoryList,
  SystemPromptVersionDetailDialog,
  useFormatSystemPromptLabels,
  type DiffSourceKey,
} from "./system-prompt-history";
import { SystemPromptPreviewDialog } from "./system-prompt-preview-dialog";

/** The server's limit for the workspace's own supplementary appendix (ADR 0023). */
const APPENDIX_MAX_LENGTH = 16_002;
const HISTORY_PAGE_SIZE = 20;

export function PromptsTab() {
  const { t } = useT("settings");
  const workspaceId = useWorkspaceId();
  const queryClient = useQueryClient();
  const user = workspaceOperatorUser;
  const members = useQuery(memberListOptions(workspaceId));
  const systemPrompt = useQuery(workspaceSystemPromptOptions(workspaceId));
  const appendix = useQuery({
    queryKey: ["workspace-prompt-settings", workspaceId],
    queryFn: () => api.getWorkspacePromptSettings(workspaceId),
    enabled: Boolean(workspaceId),
  });

  const currentMember = members.data?.find((member) => member.user_id === user?.id) ?? null;
  const canManage = currentMember?.role === "owner" || currentMember?.role === "admin";

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-base font-semibold">{t(($) => $.prompts.title)}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t(($) => $.prompts.description)}</p>
      </div>

      {/* Zone 1: System Default Behavior (system-policy) */}
      {systemPrompt.isPending ? (
        <div className="flex min-h-40 items-center justify-center rounded-lg border">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : systemPrompt.isError || !systemPrompt.data ? (
        <div className="space-y-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
          <p className="text-sm text-destructive">{t(($) => $.prompts.system_policy.load_failed)}</p>
          <Button variant="outline" size="sm" onClick={() => void systemPrompt.refetch()}>
            {t(($) => $.prompts.retry)}
          </Button>
        </div>
      ) : (
        <SystemPromptPolicySection
          key={`policy:${workspaceId}`}
          workspaceId={workspaceId}
          serverState={systemPrompt.data}
          canManage={canManage}
          onStateUpdated={(next) => {
            queryClient.setQueryData(workspaceKeys.systemPrompt(workspaceId), next);
            void queryClient.invalidateQueries({
              queryKey: workspaceKeys.systemPromptVersions(workspaceId),
            });
          }}
          onRefetchLatest={async () => {
            const result = await systemPrompt.refetch();
            return result.data ?? null;
          }}
        />
      )}

      <Separator />

      {/* Zone 2: Independent Workspace Supplementary Instructions (prompt_appendix) */}
      {appendix.isPending ? (
        <div className="flex min-h-20 items-center justify-center rounded-lg border">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : appendix.isError || !appendix.data ? (
        <div className="space-y-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
          <p className="text-sm text-destructive">{t(($) => $.prompts.load_failed)}</p>
          <Button variant="outline" size="sm" onClick={() => void appendix.refetch()}>
            {t(($) => $.prompts.retry)}
          </Button>
        </div>
      ) : (
        <WorkspaceAppendixSection
          key={`appendix:${workspaceId}`}
          workspaceId={workspaceId}
          serverSettings={appendix.data}
          canManage={canManage}
          onSaved={(next) => queryClient.setQueryData(["workspace-prompt-settings", workspaceId], next)}
          onRefetch={() => void appendix.refetch()}
        />
      )}
    </div>
  );
}

interface PendingRequestRef {
  signature: string;
  requestId: string;
}

function toSystemPromptState(result: SystemPromptState): SystemPromptState {
  return {
    document: result.document,
    content: result.content,
    currentDefault: result.currentDefault,
    baseDefault: result.baseDefault,
    defaultUpdated: result.defaultUpdated,
    limits: result.limits,
  };
}

function SystemPromptPolicySection({
  workspaceId,
  serverState,
  canManage,
  onStateUpdated,
  onRefetchLatest,
}: {
  workspaceId: string;
  serverState: SystemPromptState;
  canManage: boolean;
  onStateUpdated: (next: SystemPromptState) => void;
  onRefetchLatest: () => Promise<SystemPromptState | null>;
}) {
  const { t } = useT("settings");
  const { modeLabel } = useFormatSystemPromptLabels();

  const [draft, setDraft] = useState<SystemPromptSlots>(() => serverState.content);
  const [draftBaselineContent, setDraftBaselineContent] = useState<SystemPromptSlots>(() => serverState.content);
  const [draftRevision, setDraftRevision] = useState<number>(() => serverState.document.revision);
  const [draftBaseDefaultRevision, setDraftBaseDefaultRevision] = useState<string>(
    () => serverState.baseDefault.revision,
  );
  const [changeNote, setChangeNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [conflictRevision, setConflictRevision] = useState<number | null>(null);

  const [previewOpen, setPreviewOpen] = useState(false);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [resetNote, setResetNote] = useState("");
  const [resetting, setResetting] = useState(false);

  const [inspectVersion, setInspectVersion] = useState<SystemPromptVersionSummary | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<SystemPromptVersionSummary | null>(null);
  const [restoreNote, setRestoreNote] = useState("");
  const [restoring, setRestoring] = useState(false);

  const [compareState, setCompareState] = useState<{
    open: boolean;
    left: DiffSourceKey;
    right: DiffSourceKey;
  }>({ open: false, left: "current", right: "latest_default" });

  const pendingRequestRef = useRef<PendingRequestRef | null>(null);

  const dirty = useMemo(
    () => !areSystemPromptSlotsEqual(draft, draftBaselineContent),
    [draft, draftBaselineContent],
  );

  // Sync non-dirty editor state when serverState refreshes (e.g. via WS workspace:updated).
  // Never overwrite a dirty draft!
  useEffect(() => {
    if (dirty || conflictRevision !== null) return;
    if (
      serverState.document.revision !== draftRevision ||
      !areSystemPromptSlotsEqual(serverState.content, draftBaselineContent) ||
      serverState.baseDefault.revision !== draftBaseDefaultRevision
    ) {
      setDraft(serverState.content);
      setDraftBaselineContent(serverState.content);
      setDraftRevision(serverState.document.revision);
      setDraftBaseDefaultRevision(serverState.baseDefault.revision);
    }
  }, [serverState, dirty, conflictRevision, draftRevision, draftBaselineContent, draftBaseDefaultRevision]);

  const versionsQuery = useInfiniteQuery({
    queryKey: workspaceKeys.systemPromptVersions(workspaceId),
    queryFn: ({ pageParam }) =>
      api.listWorkspaceSystemPromptVersions(workspaceId, {
        cursor: pageParam,
        limit: HISTORY_PAGE_SIZE,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: Boolean(workspaceId),
  });

  const versions = useMemo(
    () => versionsQuery.data?.pages.flatMap((page) => page.versions) ?? [],
    [versionsQuery.data],
  );

  const maxCodePoints = serverState.limits.maxCodePoints || DEFAULT_MAX_SYSTEM_PROMPT_CODE_POINTS;
  const totalCodePoints = useMemo(() => countSystemPromptCodePoints(draft), [draft]);
  const overLimit = totalCodePoints > maxCodePoints;
  const staleInBackground = dirty && serverState.document.revision !== draftRevision;
  const hasConflict = conflictRevision !== null || staleInBackground;
  const effectiveServerRevision = conflictRevision ?? serverState.document.revision;

  function getOrCreateRequestId(signature: string): string {
    if (pendingRequestRef.current?.signature === signature) {
      return pendingRequestRef.current.requestId;
    }
    const requestId = createRequestId();
    pendingRequestRef.current = { signature, requestId };
    return requestId;
  }

  function clearPendingRequest() {
    pendingRequestRef.current = null;
  }

  function applyServerState(next: SystemPromptState) {
    setDraft(next.content);
    setDraftBaselineContent(next.content);
    setDraftRevision(next.document.revision);
    setDraftBaseDefaultRevision(next.baseDefault.revision);
    setChangeNote("");
    setConflictRevision(null);
    clearPendingRequest();
  }

  function openCompare(left: DiffSourceKey, right: DiffSourceKey) {
    setCompareState({ open: true, left, right });
  }

  function handleSlotChange(slot: SystemPromptSlotKey, value: string) {
    setDraft((prev) => ({ ...prev, [slot]: value }));
  }

  function handleDiscardDraft() {
    applyServerState(serverState);
  }

  async function handleSave(overrideExpectedRevision?: number) {
    if (!canManage || overLimit || saving) return;
    if (overrideExpectedRevision === undefined && !dirty) return;

    const normalized = normalizeSystemPromptSlots(draft);
    const expectedRevision = overrideExpectedRevision ?? draftRevision;
    const trimmedNote = changeNote.trim();
    const signature = JSON.stringify({
      op: "edit",
      expectedRevision,
      normalized,
      changeNote: trimmedNote,
      baseDefaultRevision: draftBaseDefaultRevision,
    });
    const requestId = getOrCreateRequestId(signature);

    setSaving(true);
    try {
      const result = await api.updateWorkspaceSystemPrompt(workspaceId, {
        content: normalized,
        expectedRevision,
        requestId,
        ...(trimmedNote ? { changeNote: trimmedNote } : {}),
        baseDefaultRevision: draftBaseDefaultRevision,
      });
      const nextState = toSystemPromptState(result);
      onStateUpdated(nextState);
      applyServerState(nextState);
      toast.success(t(($) => $.prompts.system_policy.saved, { version: result.version.versionNumber }));
    } catch (error) {
      const parsed = parseSystemPromptApiError(error);
      if (parsed.isRevisionConflict) {
        clearPendingRequest();
        const latest = await onRefetchLatest();
        setConflictRevision(latest?.document.revision ?? parsed.currentRevision ?? serverState.document.revision);
        toast.error(t(($) => $.prompts.system_policy.conflict_toast));
      } else if (parsed.isRequestConflict) {
        clearPendingRequest();
        toast.error(t(($) => $.prompts.system_policy.request_conflict_toast));
      } else if (parsed.isForbidden) {
        toast.error(t(($) => $.prompts.system_policy.forbidden_toast));
      } else {
        toast.error(parsed.message ?? t(($) => $.prompts.system_policy.save_failed));
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleConfirmReset() {
    if (!canManage || resetting) return;
    const expectedRevision = serverState.document.revision;
    const trimmedNote = resetNote.trim();
    const signature = JSON.stringify({ op: "reset", expectedRevision, changeNote: trimmedNote });
    const requestId = getOrCreateRequestId(signature);

    setResetting(true);
    try {
      const result = await api.resetWorkspaceSystemPrompt(workspaceId, {
        expectedRevision,
        requestId,
        ...(trimmedNote ? { changeNote: trimmedNote } : {}),
      });
      const nextState = toSystemPromptState(result);
      onStateUpdated(nextState);
      applyServerState(nextState);
      setResetNote("");
      setResetDialogOpen(false);
      toast.success(t(($) => $.prompts.system_policy.reset_success, { version: result.version.versionNumber }));
    } catch (error) {
      const parsed = parseSystemPromptApiError(error);
      if (parsed.isRevisionConflict) {
        clearPendingRequest();
        const latest = await onRefetchLatest();
        setConflictRevision(latest?.document.revision ?? parsed.currentRevision ?? serverState.document.revision);
        setResetDialogOpen(false);
        toast.error(t(($) => $.prompts.system_policy.conflict_toast));
      } else if (parsed.isRequestConflict) {
        clearPendingRequest();
        toast.error(t(($) => $.prompts.system_policy.request_conflict_toast));
      } else if (parsed.isForbidden) {
        toast.error(t(($) => $.prompts.system_policy.forbidden_toast));
      } else {
        toast.error(parsed.message ?? t(($) => $.prompts.system_policy.reset_failed));
      }
    } finally {
      setResetting(false);
    }
  }

  async function handleConfirmRestore() {
    if (!canManage || !restoreTarget || restoring) return;
    const expectedRevision = serverState.document.revision;
    const trimmedNote = restoreNote.trim();
    const signature = JSON.stringify({
      op: "restore",
      versionId: restoreTarget.id,
      expectedRevision,
      changeNote: trimmedNote,
    });
    const requestId = getOrCreateRequestId(signature);

    setRestoring(true);
    try {
      const result = await api.restoreWorkspaceSystemPromptVersion(workspaceId, {
        versionId: restoreTarget.id,
        expectedRevision,
        requestId,
        ...(trimmedNote ? { changeNote: trimmedNote } : {}),
      });
      const nextState = toSystemPromptState(result);
      onStateUpdated(nextState);
      applyServerState(nextState);
      setRestoreNote("");
      setRestoreTarget(null);
      setInspectVersion(null);
      toast.success(
        t(($) => $.prompts.history.restore_success, {
          from: restoreTarget.versionNumber,
          version: result.version.versionNumber,
        }),
      );
    } catch (error) {
      const parsed = parseSystemPromptApiError(error);
      if (parsed.isRevisionConflict) {
        clearPendingRequest();
        const latest = await onRefetchLatest();
        setConflictRevision(latest?.document.revision ?? parsed.currentRevision ?? serverState.document.revision);
        setRestoreTarget(null);
        toast.error(t(($) => $.prompts.system_policy.conflict_toast));
      } else if (parsed.isRequestConflict) {
        clearPendingRequest();
        toast.error(t(($) => $.prompts.system_policy.request_conflict_toast));
      } else if (parsed.isForbidden) {
        toast.error(t(($) => $.prompts.system_policy.forbidden_toast));
      } else {
        toast.error(parsed.message ?? t(($) => $.prompts.history.restore_failed));
      }
    } finally {
      setRestoring(false);
    }
  }

  return (
    <section aria-label={t(($) => $.prompts.system_policy.title)} className="space-y-5">
      {/* Section Header & Status */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{t(($) => $.prompts.system_policy.title)}</h3>
            <Badge
              variant={serverState.document.mode === "custom" ? "secondary" : "outline"}
              data-system-prompt-mode={serverState.document.mode}
            >
              {modeLabel(serverState.document.mode)}
            </Badge>
            <Badge variant="outline" className="font-mono text-[11px]">
              {serverState.document.revision > 0
                ? `v${serverState.document.revision}`
                : t(($) => $.prompts.system_policy.uninitialized_badge)}
            </Badge>
            {dirty && (
              <Badge variant="secondary" className="text-[11px]">
                {t(($) => $.prompts.system_policy.unsaved_badge)}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {t(($) => $.prompts.system_policy.description)}
          </p>
          <p className="font-mono text-[11px] text-muted-foreground">
            {t(($) => $.prompts.system_policy.default_revision_meta, {
              revision: shortHash(serverState.currentDefault.revision, 8),
            })}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => openCompare(dirty ? "current" : "latest_default", dirty ? "draft" : "current")}
          >
            <ArrowLeftRight className="size-3.5" />
            {t(($) => $.prompts.diff.open_compare)}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setPreviewOpen(true)}
          >
            <Eye className="size-3.5" />
            {t(($) => $.prompts.preview.open_button)}
          </Button>
        </div>
      </div>

      {/* Platform Default Updated Banner */}
      {serverState.defaultUpdated && (
        <Alert data-system-prompt-default-updated="true">
          <Sparkles className="size-4" />
          <AlertTitle>{t(($) => $.prompts.system_policy.default_updated_title)}</AlertTitle>
          <AlertDescription className="space-y-2 text-xs">
            <p>
              {t(($) => $.prompts.system_policy.default_updated_description, {
                base: shortHash(serverState.baseDefault.revision, 8),
                latest: shortHash(serverState.currentDefault.revision, 8),
              })}
            </p>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => openCompare("current", "latest_default")}
              >
                <ArrowLeftRight className="size-3.5" />
                {t(($) => $.prompts.system_policy.compare_with_latest_default)}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => openCompare("base_default", "latest_default")}
              >
                {t(($) => $.prompts.system_policy.compare_default_changes)}
              </Button>
              {canManage && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setResetDialogOpen(true)}
                >
                  <RotateCcw className="size-3.5" />
                  {t(($) => $.prompts.system_policy.reset_to_latest_default)}
                </Button>
              )}
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* 409 Conflict / Background Stale Draft Banner (Preserves User Draft!) */}
      {hasConflict && (
        <Alert variant="destructive" data-system-prompt-conflict="true">
          <AlertTriangle className="size-4" />
          <AlertTitle>{t(($) => $.prompts.system_policy.conflict_title)}</AlertTitle>
          <AlertDescription className="space-y-2 text-xs">
            <p>
              {t(($) => $.prompts.system_policy.conflict_description, {
                draftRevision,
                serverRevision: effectiveServerRevision,
              })}
            </p>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => openCompare("current", "draft")}
              >
                <ArrowLeftRight className="size-3.5" />
                {t(($) => $.prompts.system_policy.conflict_compare_draft)}
              </Button>
              {canManage && (
                <Button
                  type="button"
                  size="sm"
                  disabled={saving || overLimit}
                  onClick={() => void handleSave(serverState.document.revision)}
                >
                  {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                  {t(($) => $.prompts.system_policy.conflict_save_onto_latest, {
                    revision: serverState.document.revision,
                  })}
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleDiscardDraft}
              >
                <Undo2 className="size-3.5" />
                {t(($) => $.prompts.system_policy.conflict_reload_server)}
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* 5-Slot Full-Document Editor */}
      <div className="space-y-4">
        {SYSTEM_PROMPT_SLOT_KEYS.map((slot) => {
          const value = draft[slot];
          const defaultValue = serverState.currentDefault.content[slot];
          const slotCodePoints = countUnicodeCodePoints(value);
          const differsFromDefault = value.replace(/\r\n?/g, "\n") !== defaultValue.replace(/\r\n?/g, "\n");
          const explicitlyEmptyCustom =
            serverState.document.mode === "custom" && value === "" && defaultValue !== "";

          return (
            <div key={slot} className="space-y-1.5 rounded-md border bg-card/40 p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <label htmlFor={`system-prompt-slot-${slot}`} className="text-sm font-medium">
                    {t(($) => $.prompts.slots[slot].label)}
                  </label>
                  <span className="font-mono text-[11px] text-muted-foreground">{slot}</span>
                  {explicitlyEmptyCustom ? (
                    <Badge variant="secondary" className="text-[11px]">
                      {t(($) => $.prompts.system_policy.slot_explicitly_empty)}
                    </Badge>
                  ) : differsFromDefault ? (
                    <Badge variant="outline" className="text-[11px]">
                      {t(($) => $.prompts.system_policy.slot_differs_from_default)}
                    </Badge>
                  ) : null}
                </div>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {t(($) => $.prompts.system_policy.slot_count, { count: slotCodePoints })}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {t(($) => $.prompts.slots[slot].hint)}
              </p>
              <Textarea
                id={`system-prompt-slot-${slot}`}
                value={value}
                onChange={(event) => handleSlotChange(slot, event.target.value)}
                placeholder={t(($) => $.prompts.slots[slot].placeholder)}
                disabled={!canManage || saving}
                aria-invalid={overLimit}
                className={cn(
                  "min-h-24 resize-y font-mono text-xs leading-relaxed",
                  overLimit && "border-destructive",
                )}
              />
            </div>
          );
        })}

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <p className="text-muted-foreground">
            {t(($) => $.prompts.system_policy.full_document_hint)}
          </p>
          <p className={cn("tabular-nums text-muted-foreground", overLimit && "font-medium text-destructive")}>
            {t(($) => $.prompts.system_policy.total_code_points, {
              count: totalCodePoints,
              max: maxCodePoints,
            })}
          </p>
        </div>
      </div>

      {/* Change Note + Action Bar */}
      <div className="space-y-3 rounded-md border bg-muted/20 p-3.5">
        <div className="space-y-1.5">
          <label htmlFor="system-prompt-change-note" className="text-xs font-medium">
            {t(($) => $.prompts.change_note_label)}
          </label>
          <Input
            id="system-prompt-change-note"
            value={changeNote}
            onChange={(event) => setChangeNote(event.target.value)}
            placeholder={t(($) => $.prompts.change_note_placeholder)}
            disabled={!canManage || saving}
            maxLength={500}
            className="text-xs"
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <p className="flex min-w-0 flex-1 items-start gap-1.5 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" />
            <span>
              {canManage
                ? t(($) => $.prompts.system_policy.effective_timing_hint)
                : t(($) => $.prompts.system_policy.read_only)}
            </span>
          </p>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {dirty && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={saving}
                onClick={handleDiscardDraft}
              >
                <Undo2 className="size-3.5" />
                {t(($) => $.prompts.system_policy.discard_draft)}
              </Button>
            )}
            {canManage && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={saving || resetting}
                onClick={() => setResetDialogOpen(true)}
              >
                <RotateCcw className="size-3.5" />
                {t(($) => $.prompts.system_policy.reset_button)}
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              disabled={!canManage || !dirty || overLimit || saving}
              onClick={() => void handleSave()}
            >
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
              {saving ? t(($) => $.prompts.saving) : t(($) => $.prompts.system_policy.save_button)}
            </Button>
          </div>
        </div>
      </div>

      {/* Version History */}
      <SystemPromptHistoryList
        workspaceId={workspaceId}
        versions={versions}
        loading={versionsQuery.isPending}
        error={versionsQuery.isError}
        hasMore={Boolean(versionsQuery.hasNextPage)}
        loadingMore={versionsQuery.isFetchingNextPage}
        canManage={canManage}
        onRetry={() => void versionsQuery.refetch()}
        onLoadMore={() => void versionsQuery.fetchNextPage()}
        onInspect={(version) => setInspectVersion(version)}
        onCompare={openCompare}
        onRestore={(version) => {
          setRestoreNote("");
          setRestoreTarget(version);
        }}
      />

      {/* Zone 3: Read-only Protected Protocols & Assembly Preview */}
      <SystemPromptPreviewDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        workspaceId={workspaceId}
        draftContent={draft}
        isDirty={dirty}
      />

      {/* Version Detail Dialog */}
      <SystemPromptVersionDetailDialog
        open={Boolean(inspectVersion)}
        onOpenChange={(open) => {
          if (!open) setInspectVersion(null);
        }}
        workspaceId={workspaceId}
        versionSummary={inspectVersion}
        canManage={canManage}
        onCompareWithCurrent={(versionId) => {
          setInspectVersion(null);
          openCompare(`version:${versionId}`, "current");
        }}
        onCompareWithDefault={(versionId) => {
          setInspectVersion(null);
          openCompare(`version:${versionId}`, "latest_default");
        }}
        onRestore={(version) => {
          setRestoreNote("");
          setRestoreTarget(version);
        }}
      />

      {/* Compare / Diff Dialog */}
      <SystemPromptCompareDialog
        open={compareState.open}
        onOpenChange={(open) => setCompareState((prev) => ({ ...prev, open }))}
        workspaceId={workspaceId}
        state={serverState}
        draftContent={draft}
        hasDraft={dirty}
        versions={versions}
        initialLeft={compareState.left}
        initialRight={compareState.right}
      />

      {/* Reset to Default Confirmation Dialog */}
      <AlertDialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(($) => $.prompts.reset_dialog.title)}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(($) => $.prompts.reset_dialog.description)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <label htmlFor="system-prompt-reset-note" className="text-xs font-medium">
              {t(($) => $.prompts.change_note_label)}
            </label>
            <Input
              id="system-prompt-reset-note"
              value={resetNote}
              onChange={(event) => setResetNote(event.target.value)}
              placeholder={t(($) => $.prompts.reset_dialog.note_placeholder)}
              disabled={resetting}
              maxLength={500}
              className="text-xs"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={resetting}>
              {t(($) => $.prompts.reset_dialog.cancel)}
            </AlertDialogCancel>
            <AlertDialogAction disabled={resetting} onClick={() => void handleConfirmReset()}>
              {resetting && <Loader2 className="size-3.5 animate-spin" />}
              {t(($) => $.prompts.reset_dialog.confirm)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Restore Version Confirmation Dialog */}
      <AlertDialog
        open={Boolean(restoreTarget)}
        onOpenChange={(open) => {
          if (!open) setRestoreTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {restoreTarget
                ? t(($) => $.prompts.restore_dialog.title, { version: restoreTarget.versionNumber })
                : ""}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {restoreTarget?.mode === "default"
                ? t(($) => $.prompts.restore_dialog.description_from_default, {
                    version: restoreTarget.versionNumber,
                  })
                : restoreTarget
                  ? t(($) => $.prompts.restore_dialog.description, {
                      version: restoreTarget.versionNumber,
                    })
                  : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <label htmlFor="system-prompt-restore-note" className="text-xs font-medium">
              {t(($) => $.prompts.change_note_label)}
            </label>
            <Input
              id="system-prompt-restore-note"
              value={restoreNote}
              onChange={(event) => setRestoreNote(event.target.value)}
              placeholder={t(($) => $.prompts.restore_dialog.note_placeholder)}
              disabled={restoring}
              maxLength={500}
              className="text-xs"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restoring}>
              {t(($) => $.prompts.restore_dialog.cancel)}
            </AlertDialogCancel>
            <AlertDialogAction disabled={restoring} onClick={() => void handleConfirmRestore()}>
              {restoring && <Loader2 className="size-3.5 animate-spin" />}
              {t(($) => $.prompts.restore_dialog.confirm)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

/**
 * Zone 2: Independent workspace supplementary instructions (`settings.prompt_appendix`).
 * Collapsed by default when empty, expanded when non-empty.
 */
function WorkspaceAppendixSection({
  workspaceId,
  serverSettings,
  canManage,
  onSaved,
  onRefetch,
}: {
  workspaceId: string;
  serverSettings: WorkspacePromptSettings;
  canManage: boolean;
  onSaved: (next: WorkspacePromptSettings) => void;
  onRefetch: () => void;
}) {
  const { t } = useT("settings");
  const [open, setOpen] = useState(() => serverSettings.prompt.trim().length > 0);
  const [prompt, setPrompt] = useState(serverSettings.prompt);
  const [basePrompt, setBasePrompt] = useState(serverSettings.prompt);
  const [baseRevision, setBaseRevision] = useState(serverSettings.revision);
  const [saving, setSaving] = useState(false);

  const dirty = prompt !== basePrompt;
  const length = [...prompt].length;
  const overLimit = length > APPENDIX_MAX_LENGTH;
  const hasSavedContent = serverSettings.prompt.trim().length > 0;

  useEffect(() => {
    if (dirty) return;
    if (serverSettings.revision !== baseRevision || serverSettings.prompt !== basePrompt) {
      setPrompt(serverSettings.prompt);
      setBasePrompt(serverSettings.prompt);
      setBaseRevision(serverSettings.revision);
    }
  }, [serverSettings, dirty, baseRevision, basePrompt]);

  async function save() {
    if (!dirty || overLimit || saving || !canManage) return;
    setSaving(true);
    try {
      const next = await api.updateWorkspacePromptSettings(workspaceId, {
        prompt: prompt.trimEnd(),
        expected_revision: baseRevision,
      });
      onSaved(next);
      setPrompt(next.prompt);
      setBasePrompt(next.prompt);
      setBaseRevision(next.revision);
      toast.success(t(($) => $.prompts.saved));
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        toast.error(t(($) => $.prompts.revision_conflict));
        onRefetch();
      } else {
        toast.error(error instanceof Error ? error.message : t(($) => $.prompts.save_failed));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border bg-card/30">
      <CollapsibleTrigger
        data-appendix-toggle="true"
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-accent/40"
      >
        <div className="flex min-w-0 items-center gap-2">
          <ChevronRight
            className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{t(($) => $.prompts.appendix.title)}</span>
              <Badge variant={hasSavedContent ? "secondary" : "outline"} className="text-[11px]">
                {hasSavedContent
                  ? t(($) => $.prompts.appendix.status_configured)
                  : t(($) => $.prompts.appendix.status_empty)}
              </Badge>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t(($) => $.prompts.appendix.summary)}
            </p>
          </div>
        </div>
      </CollapsibleTrigger>

      <CollapsibleContent className="space-y-4 border-t px-4 py-4">
        <p className="rounded-md border bg-muted/30 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          {t(($) => $.prompts.appendix.boundary_notice)}
        </p>

        <div className="space-y-2">
          <div>
            <label htmlFor="workspace-prompt" className="text-sm font-medium">
              {t(($) => $.prompts.prompt_label)}
            </label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t(($) => $.prompts.prompt_hint)}
            </p>
          </div>
          <Textarea
            id="workspace-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={t(($) => $.prompts.prompt_placeholder)}
            disabled={!canManage || saving}
            aria-invalid={overLimit}
            className={cn(
              "min-h-40 resize-y font-mono text-xs leading-relaxed",
              overLimit && "border-destructive",
            )}
          />
          <p className={cn("text-right text-xs tabular-nums text-muted-foreground", overLimit && "text-destructive")}>
            {t(($) => $.prompts.character_count, { count: length, max: APPENDIX_MAX_LENGTH })}
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4 border-t pt-3">
          <p className="text-xs text-muted-foreground">
            {canManage ? t(($) => $.prompts.scope_hint) : t(($) => $.prompts.read_only)}
          </p>
          <Button
            type="button"
            size="sm"
            disabled={!canManage || !dirty || overLimit || saving}
            onClick={() => void save()}
          >
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
            {saving ? t(($) => $.prompts.saving) : t(($) => $.prompts.save)}
          </Button>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
