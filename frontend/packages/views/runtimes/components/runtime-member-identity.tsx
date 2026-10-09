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
      <code className="min-w-0 break-all text-xs text-muted-foreground">
        {runtimeId}
      </code>
    );
  }

  const machine = machineTitle([runtime], {
    isCurrent: false,
    fallbackTitle: t(($) => $.location.machine_unknown),
  });
  return (
    <span className="min-w-0 flex-1 space-y-1">
      <span className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 break-all">{runtime.name}</span>{" "}
        <HealthBadge health={runtime.status} />
      </span>{" "}
      <span className="block break-all text-xs text-muted-foreground">
        {machine}
      </span>{" "}
      <code className="block break-all text-xs text-muted-foreground">
        {runtimeId}
      </code>
    </span>
  );
}
