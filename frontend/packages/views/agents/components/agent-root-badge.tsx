"use client";

import { ShieldAlert, ShieldCheck } from "lucide-react";
import type { RootSubjectProjection } from "@multiremi/contracts/root-authority";
import { Tooltip, TooltipContent, TooltipTrigger } from "@multiremi/ui/components/ui/tooltip";
import { useT } from "../../i18n";

interface AgentRootBadgeProps {
  root?: RootSubjectProjection | null;
}

/**
 * Displays an Agent's independent system root status orthogonal to its
 * business role (`normal | maintainer | supervisor`).
 *
 * Explicitly distinguishes "Root granted & effective" from
 * "Root granted, not effective in current attempt" (for example
 * `attempt_not_eligible` on an older attempt created before the grant).
 */
export function AgentRootBadge({ root }: AgentRootBadgeProps) {
  const { t } = useT("agents");
  if (!root || !root.granted) return null;

  const isEffective = root.effective === true;
  const reason = root.reason_code || "unknown";
  const label = isEffective
    ? t(($) => $.root.badge_effective)
    : t(($) => $.root.badge_granted_ineffective);
  const detail = isEffective
    ? t(($) => $.root.tooltip_effective, {
        generation: root.generation ?? 0,
      })
    : reason === "attempt_not_eligible"
      ? t(($) => $.root.tooltip_attempt_not_eligible)
      : t(($) => $.root.tooltip_ineffective_reason, { reason });

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            data-testid="agent-root-badge"
            data-root-effective={String(isEffective)}
            data-root-reason={reason}
            className={
              isEffective
                ? "inline-flex shrink-0 items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300"
                : "inline-flex shrink-0 items-center gap-1 rounded-md border border-muted-foreground/30 bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground"
            }
          >
            {isEffective ? (
              <ShieldCheck className="h-3 w-3 shrink-0" aria-hidden />
            ) : (
              <ShieldAlert className="h-3 w-3 shrink-0" aria-hidden />
            )}
            <span>{label}</span>
          </span>
        }
      />
      <TooltipContent className="max-w-xs text-xs">{detail}</TooltipContent>
    </Tooltip>
  );
}
