"use client";

import { useState } from "react";
import {
  ChevronRight,
  Globe,
  History,
  Layers,
  Terminal,
} from "lucide-react";
import type { AgentRuntime } from "@multiremi/core/types";
import type {
  ExecutionEndpoint,
  ExecutionGroupInput,
  ExecutionGroupList,
} from "@multiremi/core/runtimes";
import { Button } from "@multiremi/ui/components/ui/button";
import { Input } from "@multiremi/ui/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@multiremi/ui/components/ui/native-select";
import {
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@multiremi/ui/components/ui/sheet";
import { Textarea } from "@multiremi/ui/components/ui/textarea";
import { useT } from "../../i18n";
import {
  ENGINE_PROTOCOLS,
  formatEngineLabel,
  getGroupEndpointId,
} from "./execution-config-shared";
import { ProviderLogo } from "./provider-logo";
import { RuntimeMemberIdentity } from "./runtime-member-identity";

type Group = ExecutionGroupList["groups"][number];

export function GroupForm({
  initial,
  endpoints,
  runtimes,
  pending,
  errorMessage,
  inSheet = false,
  onSave,
  onCancel,
}: {
  initial?: Group;
  endpoints: ExecutionEndpoint[];
  runtimes: AgentRuntime[];
  pending: boolean;
  errorMessage?: string | null;
  inSheet?: boolean;
  onSave(input: ExecutionGroupInput): void;
  onCancel(): void;
}) {
  const { t } = useT("runtimes");
  const initialEndpointId = initial ? getGroupEndpointId(initial) : null;
  const [input, setInput] = useState<ExecutionGroupInput>({
    name: initial?.name ?? "",
    description: initial?.description ?? "",
    provider: initial?.provider ?? "codex",
    endpoint_id: initialEndpointId,
    runtime_ids: initial?.runtime_ids ?? [],
    model_policy: initial?.model_policy ?? {},
  });
  const [models, setModels] = useState(
    initial?.model_policy?.models?.join("\n") ?? "",
  );
  const [legacyConnection, setLegacyConnection] = useState(
    initial?.connection_mode === "legacy" && !initialEndpointId,
  );

  const compatibleRuntimes = runtimes.filter(
    (r) => r.provider === input.provider || r.provider === "any",
  );
  const missingMembers = input.runtime_ids.filter(
    (id) => !compatibleRuntimes.some((r) => r.id === id),
  );
  const compatibleEndpoints = endpoints.filter((e) =>
    e.connection.protocols.some((p) => p === ENGINE_PROTOCOLS[input.provider]),
  );
  const endpoint = compatibleEndpoints.find((e) => e.id === input.endpoint_id);
  const invalid = !!input.endpoint_id && !endpoint;
  const selectedCompatibleCount = compatibleRuntimes.filter((r) =>
    input.runtime_ids.includes(r.id),
  ).length;

  const HeaderTag = inSheet ? SheetHeader : "div";
  const TitleTag = inSheet ? SheetTitle : "h3";
  const DescriptionTag = inSheet ? SheetDescription : "p";
  const FooterTag = inSheet ? SheetFooter : "div";

  return (
    <form
      aria-label={t(($) => $.configuration.groups)}
      className={
        inSheet
          ? "flex min-h-0 flex-1 flex-col"
          : "rounded-xl border bg-card"
      }
      onSubmit={(event) => {
        event.preventDefault();
        const allowed = [
          ...new Set(
            models
              .split(/[,\n]/)
              .map((id) => id.trim())
              .filter(Boolean),
          ),
        ];
        onSave({
          ...input,
          model_policy: {
            ...(input.model_policy?.model
              ? { model: input.model_policy.model.trim() }
              : {}),
            ...(allowed.length ? { models: allowed } : {}),
          },
        });
      }}
    >
      <HeaderTag className="shrink-0 border-b px-5 py-4 pr-12">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border bg-muted/40">
            {input.provider ? (
              <ProviderLogo provider={input.provider} className="h-4 w-4" />
            ) : (
              <Layers className="h-4 w-4 text-muted-foreground" />
            )}
          </span>
          <div className="min-w-0">
            <TitleTag className="truncate text-sm font-semibold text-foreground">
              {initial
                ? t(($) => $.configuration.edit_group)
                : t(($) => $.configuration.add_group)}
            </TitleTag>
            <DescriptionTag className="mt-0.5 text-xs text-muted-foreground">
              {t(($) => $.configuration.new_group_description)}
            </DescriptionTag>
          </div>
        </div>
      </HeaderTag>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <fieldset disabled={pending} className="min-w-0 space-y-5">
          <div className="space-y-3.5">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-foreground">
                {t(($) => $.configuration.name)}
              </span>
              <Input
                required
                maxLength={128}
                value={input.name}
                onChange={(e) => setInput({ ...input, name: e.target.value })}
              />
            </label>

            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-foreground">
                {t(($) => $.configuration.group_description)}
              </span>
              <Textarea
                maxLength={2000}
                rows={2}
                value={input.description}
                onChange={(e) =>
                  setInput({ ...input, description: e.target.value })
                }
              />
            </label>
          </div>

          <div className="space-y-3.5 rounded-xl border bg-muted/15 p-3.5">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-foreground">
                {t(($) => $.configuration.provider)}
              </span>
              <NativeSelect
                className="w-full bg-background"
                aria-label={t(($) => $.configuration.provider)}
                value={input.provider}
                disabled={!!initial}
                onChange={(e) => {
                  setInput({
                    ...input,
                    provider: e.target.value,
                    endpoint_id: null,
                    runtime_ids: [],
                    model_policy: {},
                  });
                  setModels("");
                  setLegacyConnection(false);
                }}
              >
                {[
                  ...new Set([
                    "codex",
                    "claude",
                    "antigravity",
                    ...(initial ? [initial.provider] : []),
                  ]),
                ].map((provider) => (
                  <NativeSelectOption key={provider} value={provider}>
                    {formatEngineLabel(provider)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>

            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-foreground">
                {t(($) => $.configuration.endpoint)}
              </span>
              <NativeSelect
                className="w-full bg-background"
                aria-label={t(($) => $.configuration.endpoint)}
                value={
                  legacyConnection ? "legacy" : (input.endpoint_id ?? "native")
                }
                onChange={(e) => {
                  setLegacyConnection(false);
                  setModels("");
                  setInput({
                    ...input,
                    endpoint_id:
                      e.target.value === "native" ? null : e.target.value,
                    model_policy: {},
                  });
                }}
              >
                {legacyConnection && (
                  <NativeSelectOption value="legacy" disabled>
                    {t(($) => $.configuration.legacy)}
                  </NativeSelectOption>
                )}
                <NativeSelectOption value="native">
                  {t(($) => $.configuration.native)}
                </NativeSelectOption>
                {compatibleEndpoints.map((ep) => (
                  <NativeSelectOption key={ep.id} value={ep.id}>
                    {ep.name}
                  </NativeSelectOption>
                ))}
                {invalid && (
                  <NativeSelectOption value={input.endpoint_id!} disabled>
                    {t(($) => $.configuration.unavailable_connection)}
                  </NativeSelectOption>
                )}
              </NativeSelect>
            </label>

            {legacyConnection ? (
              <div className="flex items-start gap-2 rounded-lg border bg-background px-3 py-2 text-xs text-muted-foreground">
                <History className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{t(($) => $.configuration.legacy)}</span>
              </div>
            ) : endpoint ? (
              <div className="flex items-center justify-between gap-2 rounded-lg border bg-background px-3 py-2 text-xs">
                <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
                  <Globe className="h-3.5 w-3.5 shrink-0 text-foreground/70" aria-hidden="true" />
                  <span className="truncate font-mono text-foreground/85">
                    {endpoint.connection.base_url}
                  </span>
                </span>
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  v{endpoint.revision}
                </span>
              </div>
            ) : (
              <div className="flex items-start gap-2 rounded-lg border bg-background px-3 py-2 text-xs text-muted-foreground">
                <Terminal className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{t(($) => $.configuration.native_models)}</span>
              </div>
            )}
          </div>

          <details
            className="group rounded-xl border bg-muted/10"
            open={
              !!initial?.model_policy?.model ||
              !!initial?.model_policy?.models?.length
            }
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3.5 py-2.5 text-xs font-medium text-foreground select-none [&::-webkit-details-marker]:hidden">
              <span>{t(($) => $.configuration.model_policy)}</span>
              <ChevronRight
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
                aria-hidden="true"
              />
            </summary>
            <div className="space-y-3 border-t px-3.5 py-3">
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-foreground">
                  {t(($) => $.codex_profile.model)}
                </span>
                <Input
                  className="bg-background font-mono text-xs"
                  value={input.model_policy?.model ?? ""}
                  placeholder={t(($) => $.configuration.automatic_models)}
                  onChange={(e) =>
                    setInput({
                      ...input,
                      model_policy: {
                        ...input.model_policy,
                        model: e.target.value,
                      },
                    })
                  }
                />
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-foreground">
                  {t(($) => $.configuration.model_allowlist)}
                </span>
                <Textarea
                  rows={3}
                  className="bg-background font-mono text-xs"
                  value={models}
                  onChange={(e) => setModels(e.target.value)}
                />
              </label>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {t(($) => $.configuration.model_selection_hint)}
              </p>
            </div>
          </details>

          <fieldset className="min-w-0 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <legend className="text-xs font-medium text-foreground">
                {t(($) => $.configuration.members)}
              </legend>
              {compatibleRuntimes.length > 0 && (
                <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                  {t(($) => $.configuration.selected_machines, {
                    selected: selectedCompatibleCount,
                    total: compatibleRuntimes.length,
                  })}
                </span>
              )}
            </div>

            {compatibleRuntimes.length === 0 && missingMembers.length === 0 && (
              <div className="rounded-lg border border-dashed px-3.5 py-4 text-center text-xs text-muted-foreground">
                {t(($) => $.configuration.no_compatible_runtimes)}
              </div>
            )}

            <div className="space-y-2">
              {compatibleRuntimes.map((runtime) => (
                <label
                  className="flex min-w-0 cursor-pointer items-start gap-3 rounded-lg border bg-background p-3 text-sm transition-colors hover:bg-muted/30 has-[:checked]:border-brand/50 has-[:checked]:bg-brand/[0.04]"
                  key={runtime.id}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 shrink-0 rounded accent-primary"
                    checked={input.runtime_ids.includes(runtime.id)}
                    onChange={(e) =>
                      setInput({
                        ...input,
                        runtime_ids: e.target.checked
                          ? [...input.runtime_ids, runtime.id]
                          : input.runtime_ids.filter((id) => id !== runtime.id),
                      })
                    }
                  />
                  <RuntimeMemberIdentity
                    runtime={runtime}
                    runtimeId={runtime.id}
                  />
                </label>
              ))}

              {missingMembers.map((id) => (
                <label
                  className="flex min-w-0 cursor-pointer items-start gap-3 rounded-lg border border-dashed bg-muted/20 p-3 text-sm transition-colors hover:bg-muted/40"
                  key={id}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 shrink-0 rounded accent-primary"
                    checked
                    onChange={() =>
                      setInput({
                        ...input,
                        runtime_ids: input.runtime_ids.filter(
                          (member) => member !== id,
                        ),
                      })
                    }
                  />
                  <RuntimeMemberIdentity runtimeId={id} />
                </label>
              ))}
            </div>

            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t(($) => $.configuration.members_hint)}
            </p>
          </fieldset>
        </fieldset>
      </div>

      {errorMessage && (
        <div className="shrink-0 px-5 pb-2">
          <p
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {errorMessage}
          </p>
        </div>
      )}

      <FooterTag className="mt-0 shrink-0 flex-row items-center justify-end gap-2 border-t bg-muted/20 px-5 py-3.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={onCancel}
        >
          {t(($) => $.configuration.cancel)}
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={
            pending || legacyConnection || invalid
          }
        >
          {t(($) => $.configuration.save_group)}
        </Button>
      </FooterTag>
    </form>
  );
}
