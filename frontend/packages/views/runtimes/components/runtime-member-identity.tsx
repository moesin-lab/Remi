"use client";

import type { AgentRuntime } from "@multiremi/core/types";
import { useT } from "../../i18n";
import { machineTitle } from "./runtime-machines";
import { HealthBadge } from "./shared";

export function RuntimeMemberIdentity({
  runtime,
  runtimeId,
}: {
  runtime?: AgentRuntime;
  runtimeId: string;
}) {
  const { t } = useT("runtimes");
  if (!runtime) {
    return (
      <span className="min-w-0 flex-1">
        <code className="inline-block max-w-full break-all rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
          {runtimeId}
        </code>
      </span>
    );
  }

  const machine = machineTitle([runtime], {
    isCurrent: false,
    fallbackTitle: t(($) => $.location.machine_unknown),
  });
  return (
    <span className="min-w-0 flex-1 space-y-1">
      <span className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 break-all text-sm font-medium text-foreground">
          {runtime.name}
        </span>{" "}
        <HealthBadge health={runtime.status} />
      </span>{" "}
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="min-w-0 break-all">{machine}</span>{" "}
        <code className="break-all rounded bg-muted/70 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
          {runtimeId}
        </code>
      </span>
    </span>
  );
}
