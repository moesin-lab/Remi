"use client";

import { AlertCircle, Check, Clock, Cloud, HelpCircle, Monitor } from "lucide-react";
import type { AgentRuntime } from "@multiremi/core/types";
import type { ExecutionGroupList } from "@multiremi/core/runtimes";
import { cn } from "@multiremi/ui/lib/utils";
import { useT } from "../../i18n";
import { machineTitle } from "./runtime-machines";
import { HealthDot } from "./shared";

export type CapabilityGroup = ExecutionGroupList["groups"][number];

export const ENGINE_PROTOCOLS: Record<string, string> = {
  codex: "openai-responses",
  claude: "anthropic-messages",
  antigravity: "google-generative",
};

export const ENDPOINT_PROTOCOLS = [
  { id: "openai-responses", shortLabel: "Responses", providerHint: "Codex" },
  { id: "openai-chat-completions", shortLabel: "Chat", providerHint: "System AI" },
  { id: "anthropic-messages", shortLabel: "Anthropic", providerHint: "Claude Code" },
  { id: "google-generative", shortLabel: "Google GenAI", providerHint: "Antigravity" },
] as const;

export function formatEngineLabel(provider: string): string {
  switch (provider) {
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "antigravity":
      return "Antigravity";
    default:
      return provider;
  }
}

export function formatProtocolShortLabel(protocol: string): string {
  const match = ENDPOINT_PROTOCOLS.find((item) => item.id === protocol);
  return match ? match.shortLabel : protocol;
}

export function getGroupEndpointId(group: CapabilityGroup): string | null {
  return group.endpoint_id ?? group.profile_id ?? null;
}

export function isLegacyGroupConnection(group: CapabilityGroup): boolean {
  return (group.managed === false || group.connection_mode === "legacy") && !getGroupEndpointId(group);
}

export function BindingStateBadge({
  group,
  runtimeId,
}: {
  group: CapabilityGroup;
  runtimeId: string;
}) {
  const { t } = useT("runtimes");
  const member = group.members?.find((m) => m.runtime_id === runtimeId);
  const status = member?.status;

  if (status === "ready") {
    return (
      <span
        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success"
        title={member?.error ?? undefined}
      >
        <Check className="h-3 w-3" aria-hidden="true" />
        <span>{t(($) => $.configuration.applied)}</span>
      </span>
    );
  }

  if (status === "error") {
    return (
      <span
        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive"
        title={member?.error ?? undefined}
      >
        <AlertCircle className="h-3 w-3" aria-hidden="true" />
        <span>{t(($) => $.configuration.failed)}</span>
      </span>
    );
  }

  if (status === "pending") {
    return (
      <span
        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning"
        title={member?.error ?? undefined}
      >
        <Clock className="h-3 w-3" aria-hidden="true" />
        <span>{t(($) => $.configuration.pending)}</span>
      </span>
    );
  }

  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
      title={member?.error ?? undefined}
    >
      <HelpCircle className="h-3 w-3" aria-hidden="true" />
      <span>{t(($) => $.configuration.unknown)}</span>
    </span>
  );
}

export function GroupRuntimeRow({
  group,
  runtime,
  runtimeId,
}: {
  group: CapabilityGroup;
  runtime?: AgentRuntime;
  runtimeId: string;
}) {
  const { t } = useT("runtimes");
  const member = group.members?.find((m) => m.runtime_id === runtimeId);
  const hasError = member?.status === "error";

  if (!runtime) {
    return (
      <div
        className={cn(
          "flex min-w-0 items-center justify-between gap-2 rounded-lg border bg-background px-2.5 py-1.5",
          hasError && "border-destructive/30 bg-destructive/[0.02]",
        )}
      >
        <code className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={runtimeId}>
          {runtimeId}
        </code>
        <BindingStateBadge group={group} runtimeId={runtimeId} />
      </div>
    );
  }

  const machine = machineTitle([runtime], {
    isCurrent: false,
    fallbackTitle: t(($) => $.location.machine_unknown),
  });
  const ModeIcon = runtime.runtime_mode === "cloud" ? Cloud : Monitor;

  return (
    <div
      className={cn(
        "flex min-w-0 items-center justify-between gap-2.5 rounded-lg border bg-background px-2.5 py-1.5 transition-colors",
        hasError && "border-destructive/30 bg-destructive/[0.02]",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <HealthDot health={runtime.status} className="shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-xs font-medium text-foreground" title={runtime.name}>
              {runtime.name}
            </span>
          </div>
          <div className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
            <ModeIcon className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
            <span className="truncate" title={`${machine} · ${runtimeId}`}>
              {machine}
            </span>
          </div>
        </div>
      </div>
      <BindingStateBadge group={group} runtimeId={runtimeId} />
    </div>
  );
}
