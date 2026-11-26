"use client";

import { useMemo, useState } from "react";
import type { SystemPromptSlotKey, SystemPromptSlots } from "@multiremi/core/types";
import { Badge } from "@multiremi/ui/components/ui/badge";
import { Button } from "@multiremi/ui/components/ui/button";
import { cn } from "@multiremi/ui/lib/utils";
import { useT } from "../../i18n";
import { computeSlotsDiff, type SlotDiff } from "../lib/system-prompt-utils";

export interface SystemPromptDiffViewProps {
  leftLabel: string;
  rightLabel: string;
  leftContent: SystemPromptSlots;
  rightContent: SystemPromptSlots;
  defaultOnlyChanged?: boolean;
}

export function SystemPromptDiffView({
  leftLabel,
  rightLabel,
  leftContent,
  rightContent,
  defaultOnlyChanged = false,
}: SystemPromptDiffViewProps) {
  const { t } = useT("settings");
  const [onlyChanged, setOnlyChanged] = useState(defaultOnlyChanged);

  const slotDiffs = useMemo(
    () => computeSlotsDiff(leftContent, rightContent),
    [leftContent, rightContent],
  );

  const changedCount = useMemo(
    () => slotDiffs.filter((item) => item.changed).length,
    [slotDiffs],
  );

  const visibleDiffs = onlyChanged ? slotDiffs.filter((item) => item.changed) : slotDiffs;

  const slotTitle = (slot: SystemPromptSlotKey) => t(($) => $.prompts.slots[slot].label);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="font-medium text-foreground">{leftLabel}</span>
          <span className="text-muted-foreground" aria-hidden="true">→</span>
          <span className="font-medium text-foreground">{rightLabel}</span>
          <Badge variant={changedCount > 0 ? "secondary" : "outline"}>
            {changedCount > 0
              ? t(($) => $.prompts.diff.changed_slots_count, { count: changedCount })
              : t(($) => $.prompts.diff.no_changes)}
          </Badge>
        </div>
        {changedCount > 0 && changedCount < slotDiffs.length && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => setOnlyChanged((prev) => !prev)}
          >
            {onlyChanged
              ? t(($) => $.prompts.diff.show_all_slots)
              : t(($) => $.prompts.diff.show_changed_only)}
          </Button>
        )}
      </div>

      {changedCount === 0 ? (
        <div className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          {t(($) => $.prompts.diff.identical)}
        </div>
      ) : (
        <div className="space-y-3">
          {visibleDiffs.map((slotDiff) => (
            <SlotDiffCard key={slotDiff.slot} diff={slotDiff} title={slotTitle(slotDiff.slot)} />
          ))}
        </div>
      )}
    </div>
  );
}

function SlotDiffCard({ diff, title }: { diff: SlotDiff; title: string }) {
  const { t } = useT("settings");

  return (
    <section
      aria-label={title}
      className="overflow-hidden rounded-md border bg-background"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/20 px-3 py-2">
        <div className="flex items-center gap-2">
          <h4 className="text-xs font-medium text-foreground">{title}</h4>
          <span className="font-mono text-[11px] text-muted-foreground">{diff.slot}</span>
        </div>
        {diff.changed ? (
          <div className="flex items-center gap-2 font-mono text-[11px]">
            {diff.addedCount > 0 && (
              <span className="text-emerald-700 dark:text-emerald-400">+{diff.addedCount}</span>
            )}
            {diff.removedCount > 0 && (
              <span className="text-destructive">-{diff.removedCount}</span>
            )}
          </div>
        ) : (
          <Badge variant="outline" className="text-[11px]">
            {t(($) => $.prompts.diff.unchanged)}
          </Badge>
        )}
      </div>

      {diff.lines.length === 0 ? (
        <div className="px-3 py-2 text-xs italic text-muted-foreground">
          {t(($) => $.prompts.diff.empty_slot)}
        </div>
      ) : (
        <div className="max-h-72 overflow-auto font-mono text-xs leading-5">
          {diff.lines.map((line, index) => (
            <div
              key={`${diff.slot}-${index}`}
              data-diff-line={line.type}
              className={cn(
                "flex gap-2 px-3 py-0.5 whitespace-pre-wrap break-words",
                line.type === "added" && "bg-emerald-500/10 text-emerald-900 dark:text-emerald-200",
                line.type === "removed" && "bg-destructive/10 text-destructive",
                line.type === "unchanged" && "text-foreground/80",
              )}
            >
              <span
                aria-hidden="true"
                className="w-8 shrink-0 select-none text-right tabular-nums text-muted-foreground/70"
              >
                {line.oldLineNumber ?? ""}
              </span>
              <span
                aria-hidden="true"
                className="w-8 shrink-0 select-none text-right tabular-nums text-muted-foreground/70"
              >
                {line.newLineNumber ?? ""}
              </span>
              <span aria-hidden="true" className="w-3 shrink-0 select-none font-semibold">
                {line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}
              </span>
              <span className="min-w-0 flex-1">{line.text}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
