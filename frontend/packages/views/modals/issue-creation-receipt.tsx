"use client";

import { useEffect, useRef } from "react";
import type { CreatedIssue } from "@multiremi/core/types";
import { useWorkspacePaths } from "@multiremi/core/paths";
import { Button } from "@multiremi/ui/components/ui/button";
import { DialogTitle } from "@multiremi/ui/components/ui/dialog";
import { CheckCircle2 } from "lucide-react";
import { useNavigation } from "../navigation";
import { useT } from "../i18n";

/** A durable acknowledgement in the creation flow, separate from live status. */
export function IssueCreationReceipt({ issue, intake = false, compact = false, onClose, onCreateAnother }: {
  issue: CreatedIssue;
  intake?: boolean;
  compact?: boolean;
  onClose: () => void;
  onCreateAnother: () => void;
}) {
  const { t } = useT("modals");
  const paths = useWorkspacePaths();
  const { push } = useNavigation();
  const viewRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (!compact) viewRef.current?.focus(); }, [compact, issue.id]);

  let explanation = t(($) => $.create_issue.receipt.unknown);
  if (intake) explanation = t(($) => $.create_issue.receipt.intake);
  else if (issue.dispatch_status === "dispatched") explanation = t(($) => $.create_issue.receipt.queued);
  else if (issue.dispatch_status === "skipped") {
    const reason = issue.dispatch_skipped_reason;
    if (reason === "no_assignee") explanation = t(($) => $.create_issue.receipt.no_assignee);
    else if (reason === "member_assignee") explanation = t(($) => $.create_issue.receipt.member_assignee);
    else if (reason === "backlog_status") explanation = t(($) => $.create_issue.receipt.backlog_status);
    else if (reason === "dependencies_unmet") explanation = t(($) => $.create_issue.receipt.dependencies_unmet);
    else if (reason === "no_runnable_agent") explanation = t(($) => $.create_issue.receipt.no_runnable_agent);
    else explanation = t(($) => $.create_issue.receipt.skipped);
  }

  return (
    <section aria-label={t(($) => $.create_issue.receipt.label)} className={compact
      ? "mx-5 mb-3 shrink-0 rounded-lg border bg-muted/30 p-3"
      : "flex min-h-0 flex-1 flex-col justify-center gap-4 overflow-y-auto p-6"}>
      <div role="status" className="min-w-0 space-y-2">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="size-4 shrink-0 text-success" />
          {compact ? <p className="text-sm font-medium">{t(($) => $.create_issue.toast_created)}</p>
            : <DialogTitle>{t(($) => $.create_issue.toast_created)}</DialogTitle>}
        </div>
        <p className="break-words text-sm font-medium">{issue.identifier} · {issue.title}</p>
        <p className="text-sm text-muted-foreground">{explanation}</p>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button ref={viewRef} size="sm" onClick={() => { push(paths.issueDetail(issue.id)); onClose(); }}>
          {intake ? t(($) => $.create_issue.receipt.view_intake) : t(($) => $.create_issue.view_issue)}
        </Button>
        {!compact && <>
          <Button size="sm" variant="outline" onClick={onCreateAnother}>{t(($) => $.create_issue.receipt.create_another)}</Button>
          <Button size="sm" variant="ghost" onClick={onClose}>{t(($) => $.common.close)}</Button>
        </>}
      </div>
    </section>
  );
}
