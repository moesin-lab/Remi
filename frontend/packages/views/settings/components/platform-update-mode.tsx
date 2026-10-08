"use client";

import { useState } from "react";
import type { PlatformStatus } from "@multiremi/core/platform-lifecycle";
import { Badge } from "@multiremi/ui/components/ui/badge";
import { Button } from "@multiremi/ui/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@multiremi/ui/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@multiremi/ui/components/ui/dialog";
import { Label } from "@multiremi/ui/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@multiremi/ui/components/ui/select";
import { useT } from "../../i18n";

const MODES = ["images", "host_application", "internal_application", "systemd_release"] as const;
type Mode = typeof MODES[number];
type Translate = ReturnType<typeof useT<"settings">>["t"];
const isMode = (mode: string | null | undefined): mode is Mode => MODES.some(value => value === mode);

function modeLabel(mode: string | null | undefined, t: Translate) {
  return isMode(mode) ? t($ => $.platform.update_modes[mode].label) : t($ => $.platform.mode_unknown);
}

function checkedSource(status: PlatformStatus) {
  const source = status.preflight?.source;
  const age = status.preflight ? Date.now() - Date.parse(status.preflight.checkedAt) : NaN;
  return source && source.url === (status.releaseFeedUrl ?? status.defaultReleaseFeedUrl)
    && status.updaterStatus === "ready" && age >= -60_000 && age <= 360_000 ? source : null;
}

export function PlatformUpdateModeCard({ status }: { status: PlatformStatus }) {
  const { t } = useT("settings");
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<Mode>("internal_application");
  const current = status.updateMode;
  const blocked = Boolean(status.activeOperation) || status.maintenance.mode !== "normal";
  const source = checkedSource(status);
  const capability = source?.modes.find(item => item.mode === target);

  return (
    <Card data-testid="platform-update-mode" className="rounded-lg">
      <CardHeader>
        <CardTitle>{t($ => $.platform.mode_title)}</CardTitle>
        <CardDescription>{t($ => $.platform.mode_reported)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="font-medium" data-testid="platform-current-mode">{modeLabel(current, t)}</p>
            <p className="text-sm text-muted-foreground">{isMode(current) ? t($ => $.platform.update_modes[current].description) : t($ => $.platform.mode_unknown_hint)}</p>
          </div>
          <Button variant="outline" onClick={() => { setTarget(current === "internal_application" ? "images" : "internal_application"); setOpen(true); }}>
            {t($ => $.platform.mode_guide)}
          </Button>
        </div>
        {status.updaterStatus !== "ready" && <p role="status" className="text-sm text-muted-foreground">{t($ => $.platform.mode_offline)}</p>}
      </CardContent>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85dvh] min-w-0 overflow-y-auto [overflow-wrap:anywhere] sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t($ => $.platform.mode_guide)}</DialogTitle>
            <DialogDescription>{t($ => $.platform.mode_guide_hint)}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="platform-target-mode">{t($ => $.platform.mode_target)}</Label>
            <Select value={target} onValueChange={value => { if (isMode(value)) setTarget(value); }}>
              <SelectTrigger id="platform-target-mode" className="w-full"><SelectValue>{modeLabel(target, t)}</SelectValue></SelectTrigger>
              <SelectContent>{MODES.map(mode => <SelectItem key={mode} value={mode}>{modeLabel(mode, t)}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          {target === current ? <p role="status">{t($ => $.platform.mode_already_active)}</p> : <>
            {blocked && <p role="alert" className="text-sm text-destructive">{t($ => $.platform.mode_busy)}</p>}
            {status.updaterStatus !== "ready" && <p role="alert" className="text-sm text-destructive">{t($ => $.platform.mode_offline)}</p>}
            <div className="rounded-md border p-3 text-sm" data-testid="platform-migration-source">
              <p>{capability?.available ? t($ => $.platform.mode_source_available) : capability ? t($ => $.platform.mode_source_missing) : t($ => $.platform.source_unchecked)}</p>
              {capability && <MissingArtifacts missing={capability.missing} />}
              <p className="mt-2 text-muted-foreground">{t($ => $.platform.mode_source_shared)}</p>
            </div>
            <ol className="list-decimal space-y-3 pl-5 text-sm">
              <li>{t($ => $.platform.migration_prepare)}</li>
              <li>{t($ => $.platform.migration_backup)}</li>
              <li>{t($ => $.platform.update_modes[target].migration)}</li>
              {(current === "internal_application" || current === "host_application" || target === "internal_application") && <li>{t($ => $.platform.migration_overlay)}</li>}
              <li>{t($ => $.platform.migration_verify)}</li>
            </ol>
            <p className="text-sm text-muted-foreground">{t($ => $.platform.migration_downtime)}</p>
          </>}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export function PlatformSourceCapabilities({ status, dirty }: { status: PlatformStatus; dirty: boolean }) {
  const { t } = useT("settings");
  const source = checkedSource(status);
  const effectiveUrl = status.releaseFeedUrl ?? status.defaultReleaseFeedUrl;
  return <div className="space-y-3 border-t pt-3" data-testid="platform-source-capabilities">
    <p className="break-all text-xs text-muted-foreground">{t($ => $.platform.source_effective, { url: effectiveUrl || t($ => $.platform.source_not_configured) })}</p>
    {dirty && <p role="status" className="text-sm">{t($ => $.platform.source_unsaved)}</p>}
    {!source ? <p className="text-sm text-muted-foreground">{t($ => $.platform.source_unchecked)}</p>
      : source.error ? <p role="alert" className="break-words text-sm text-destructive">{t($ => $.platform.source_check_failed, { error: source.error })}</p>
        : <>
          <p className="text-sm font-medium">{t($ => $.platform.source_contents)}</p>
          <ul className="space-y-3">{source.modes.map(capability => <li key={capability.mode} className="space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span>{modeLabel(capability.mode, t)}</span>
              {capability.mode === status.updateMode && <Badge variant="outline">{t($ => $.platform.mode_current)}</Badge>}
              <Badge variant={capability.available ? "secondary" : "outline"}>{capability.available ? t($ => $.platform.source_available) : t($ => $.platform.source_missing)}</Badge>
            </div>
            <MissingArtifacts missing={capability.missing} />
          </li>)}</ul>
          <p className="text-xs text-muted-foreground">{t($ => $.platform.source_capabilities_hint)}</p>
        </>}
  </div>;
}

function MissingArtifacts({ missing }: { missing: string[] }) {
  const { t } = useT("settings");
  const known = ["release_identity", "source_archive", "api_image", "web_image", "application_bundle", "application_metadata", "architecture_bundle", "supervisor", "bundled_runtimes", "native_tools"] as const;
  return missing.length > 0 && <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">{missing.map(issue => {
    const key = known.find(value => value === issue);
    return <li key={issue}>{key ? t($ => $.platform.missing_artifacts[key]) : t($ => $.platform.source_unknown_requirement, { requirement: issue })}</li>;
  })}</ul>;
}
