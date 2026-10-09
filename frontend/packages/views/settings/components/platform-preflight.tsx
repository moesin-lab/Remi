"use client";

import { Check, ChevronDown, CircleAlert } from "lucide-react";
import type { PlatformStatus } from "@multiremi/core/platform-lifecycle";
import { Badge } from "@multiremi/ui/components/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@multiremi/ui/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@multiremi/ui/components/ui/collapsible";
import { useT } from "../../i18n";
import { useViewingTimezone } from "../../common/use-viewing-timezone";
import { MissingArtifacts } from "./platform-update-mode";

const CHECK_CODES = [
  "host", "compose", "application_runtime", "local_profile", "container_supervisors",
  "isolated_rehearsal", "backup", "postgresql", "program_storage", "current_release",
  "release_feed", "release_artifacts", "data_schema", "release_feed_or_schema",
] as const;
type Preflight = NonNullable<PlatformStatus["preflight"]>;
type CheckResult = Preflight["checks"][number];
type Translate = ReturnType<typeof useT<"settings">>["t"];
const checkKey = (code: string) => CHECK_CODES.find(key => key === code);

function failureMessage(check: CheckResult, t: Translate) {
  if (check.code === "release_feed_or_schema"
    && check.message === "This release has no supported application bundle; image-only releases cannot be applied in application mode") {
    return t($ => $.platform.preflight_bundle_unsupported);
  }
  const key = checkKey(check.code);
  return key ? t($ => $.platform.preflight_checks[key].failure) : t($ => $.platform.preflight_unknown_failure);
}

export function PlatformPreflightCard({ status }: { status: PlatformStatus }) {
  const { t, i18n } = useT("settings");
  const timezone = useViewingTimezone();
  const preflight = status.preflight;
  const missing = preflight?.source?.modes.find(item => item.mode === status.updateMode)?.missing ?? [];
  const ready = preflight?.ready && preflight.checks.every(check => check.ok);
  const platform = preflight?.platform === "win32" ? "Windows" : preflight?.platform === "darwin" ? "macOS" : preflight?.platform === "linux" ? "Linux" : preflight?.platform;
  const checkedAt = preflight ? new Date(preflight.checkedAt) : null;
  const checkedAtLabel = checkedAt && Number.isFinite(checkedAt.getTime())
    ? checkedAt.toLocaleString(i18n.language, { timeZone: timezone }) : "—";

  return (
    <Card data-testid="platform-preflight">
      <CardHeader className="border-b">
        <CardTitle>{t($ => $.platform.preflight_title)}</CardTitle>
        <CardDescription>{t($ => $.platform.preflight_hint)}</CardDescription>
        {preflight && <CardAction>
          <Badge variant={ready ? "secondary" : "outline"} className={ready ? "bg-success/10 text-success" : "border-destructive/30 text-destructive"}>
            {ready ? t($ => $.platform.preflight_ready) : t($ => $.platform.preflight_blocked)}
          </Badge>
        </CardAction>}
      </CardHeader>
      <CardContent className="space-y-3">
        {!preflight ? <p className="text-sm text-muted-foreground">{t($ => $.platform.check_unknown)}</p> : <>
          <p className="text-xs text-muted-foreground">{platform} / {preflight.arch} · {checkedAtLabel}</p>
          <ul className="divide-y">
            {preflight.checks.map(check => {
              const key = checkKey(check.code);
              return <li key={check.code} className="space-y-1 py-3 first:pt-0 last:pb-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    {check.ok ? <Check aria-hidden className="h-4 w-4 shrink-0 text-success" /> : <CircleAlert aria-hidden className="h-4 w-4 shrink-0 text-destructive" />}
                    <span className="break-words text-sm font-medium">{key ? t($ => $.platform.preflight_checks[key].label) : t($ => $.platform.preflight_unknown_check)}</span>
                  </div>
                  <Badge variant={check.ok ? "secondary" : "outline"} className={check.ok ? "shrink-0 bg-success/10 text-success" : "shrink-0 border-destructive/30 text-destructive"}>
                    {check.ok ? t($ => $.platform.preflight_passed) : t($ => $.platform.preflight_failed)}
                  </Badge>
                </div>
                {!check.ok && <div className="space-y-1 pl-6">
                  <p className="break-words text-sm text-muted-foreground">{failureMessage(check, t)}</p>
                  {check.code === "release_artifacts" && <MissingArtifacts missing={missing} />}
                </div>}
              </li>;
            })}
          </ul>
          {preflight.checks.length > 0 && <Collapsible className="border-t pt-3">
            <CollapsibleTrigger className="flex w-full items-center justify-between text-sm text-muted-foreground">
              {t($ => $.platform.preflight_diagnostics)}
              <ChevronDown aria-hidden className="h-4 w-4" />
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-3 pt-3">
              <p className="text-xs text-muted-foreground">{t($ => $.platform.preflight_diagnostics_hint)}</p>
              <dl className="space-y-2 rounded-md bg-muted/40 p-3 text-xs">
                {preflight.checks.map(check => <div key={check.code}>
                  <dt className="break-all font-mono font-medium">{check.code}</dt>
                  <dd className="whitespace-pre-wrap break-all text-muted-foreground">{check.message}</dd>
                </div>)}
              </dl>
            </CollapsibleContent>
          </Collapsible>}
        </>}
      </CardContent>
    </Card>
  );
}
