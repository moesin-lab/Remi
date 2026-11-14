"use client";
import { useState } from "react";
import type { AgentRuntime } from "@multiremi/core/types";
import type { ExecutionGroupList, ExecutionGroupInput, ExecutionEndpoint } from "@multiremi/core/runtimes";
import { Button } from "@multiremi/ui/components/ui/button";
import { Input } from "@multiremi/ui/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@multiremi/ui/components/ui/native-select";
import { useT } from "../../i18n";
import { RuntimeMemberIdentity } from "./runtime-member-identity";

type Group = ExecutionGroupList["groups"][number];
const protocols: Record<string, string> = { codex: "openai-responses", claude: "anthropic-messages", antigravity: "google-generative" };
export function GroupForm({ initial, endpoints, runtimes, pending, onSave, onCancel }: {
  initial?: Group; endpoints: ExecutionEndpoint[]; runtimes: AgentRuntime[]; pending: boolean;
  onSave(input: ExecutionGroupInput): void; onCancel(): void;
}) {
  const { t } = useT("runtimes");
  const [input, setInput] = useState<ExecutionGroupInput>({
    name: initial?.name ?? "", description: initial?.description ?? "", provider: initial?.provider ?? "codex",
    endpoint_id: initial?.endpoint_id ?? initial?.profile_id ?? null, runtime_ids: initial?.runtime_ids ?? [],
    model_policy: initial?.model_policy ?? {},
  });
  const [models, setModels] = useState(initial?.model_policy?.models?.join("\n") ?? "");
  const [legacyConnection, setLegacyConnection] = useState(initial?.connection_mode === "legacy" && !initial.profile_id);
  const compatibleRuntimes = runtimes.filter(r => r.provider === input.provider || r.provider === "any");
  const missingMembers = input.runtime_ids.filter(id => !compatibleRuntimes.some(r => r.id === id));
  const compatibleEndpoints = endpoints.filter(e => e.connection.protocols.some(p => p === protocols[input.provider]));
  const endpoint = compatibleEndpoints.find(e => e.id === input.endpoint_id);
  const invalid = !!input.endpoint_id && !endpoint;
  return <form aria-label={t($ => $.configuration.groups)} className="rounded-lg border bg-card p-4" onSubmit={event => {
    event.preventDefault();
    const allowed = [...new Set(models.split(/[,\n]/).map(id => id.trim()).filter(Boolean))];
    onSave({ ...input, model_policy: { ...(input.model_policy?.model ? { model: input.model_policy.model.trim() } : {}),
      ...(allowed.length ? { models: allowed } : {}) } });
  }}>
    <fieldset disabled={pending} className="space-y-4">
      <label className="block text-sm">{t($ => $.configuration.name)}
        <Input required maxLength={128} value={input.name} onChange={e => setInput({ ...input, name: e.target.value })} />
      </label>
      <label className="block text-sm">{t($ => $.configuration.group_description)}
        <textarea maxLength={2000} value={input.description} onChange={e => setInput({ ...input, description: e.target.value })}
          className="mt-1 min-h-20 w-full rounded-md border bg-background p-2 text-sm" />
      </label>
      <label className="block text-sm">{t($ => $.configuration.provider)}
        <NativeSelect aria-label={t($ => $.configuration.provider)} value={input.provider} disabled={!!initial} onChange={e => {
          setInput({ ...input, provider: e.target.value, endpoint_id: null, runtime_ids: [], model_policy: {} }); setModels(""); setLegacyConnection(false);
        }}>
          {[...new Set(["codex", "claude", "antigravity", ...(initial ? [initial.provider] : [])])].map(provider =>
            <NativeSelectOption key={provider} value={provider}>{provider === "claude" ? "Claude Code" : provider === "codex" ? "Codex" : provider === "antigravity" ? "Antigravity" : provider}</NativeSelectOption>)}
        </NativeSelect>
      </label>
      <label className="block text-sm">{t($ => $.configuration.endpoint)}
        <NativeSelect aria-label={t($ => $.configuration.endpoint)} value={legacyConnection ? "legacy" : input.endpoint_id ?? "native"}
          onChange={e => { setLegacyConnection(false); setModels(""); setInput({ ...input, endpoint_id: e.target.value === "native" ? null : e.target.value, model_policy: {} }); }}>
          {legacyConnection && <NativeSelectOption value="legacy" disabled>{t($ => $.configuration.legacy)}</NativeSelectOption>}
          <NativeSelectOption value="native">{t($ => $.configuration.native)}</NativeSelectOption>
          {compatibleEndpoints.map(endpoint => <NativeSelectOption key={endpoint.id} value={endpoint.id}>{endpoint.name}</NativeSelectOption>)}
          {invalid && <NativeSelectOption value={input.endpoint_id!} disabled>{t($ => $.configuration.unavailable_connection)}</NativeSelectOption>}
        </NativeSelect>
      </label>
      <p className="text-xs text-muted-foreground">{legacyConnection ? t($ => $.configuration.legacy) : input.endpoint_id ? endpoint?.connection.base_url : t($ => $.configuration.native_models)}</p>
      {!input.endpoint_id && input.provider === "antigravity" && <p role="status" className="text-sm text-warning">{t($ => $.configuration.endpoint_required)}</p>}
      <details className="space-y-3" open={!!initial?.model_policy?.model || !!initial?.model_policy?.models?.length}>
        <summary className="cursor-pointer text-sm">{t($ => $.configuration.model_policy)}</summary>
        <label className="block text-sm">{t($ => $.codex_profile.model)}
          <Input value={input.model_policy?.model ?? ""} placeholder={t($ => $.configuration.automatic_models)}
            onChange={e => setInput({ ...input, model_policy: { ...input.model_policy, model: e.target.value } })} />
        </label>
        <label className="block text-sm">{t($ => $.configuration.model_allowlist)}
          <textarea className="w-full rounded-md border p-2" value={models} onChange={e => setModels(e.target.value)} />
        </label>
      </details>
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium">
            {t(($) => $.configuration.members)}
          </legend>
          {compatibleRuntimes.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {t(($) => $.configuration.no_compatible_runtimes)}
            </p>
          )}
          {compatibleRuntimes.map((runtime) => (
            <label className="flex min-w-0 cursor-pointer items-start gap-3 rounded-md border p-3 text-sm" key={runtime.id}>
              <input
                type="checkbox"
                className="mt-1 shrink-0"
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
              <RuntimeMemberIdentity runtime={runtime} runtimeId={runtime.id} />
            </label>
          ))}
          {missingMembers.map((id) => (
            <label className="flex min-w-0 cursor-pointer items-start gap-3 rounded-md border p-3 text-sm" key={id}>
              <input
                type="checkbox"
                className="mt-1 shrink-0"
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
          <p className="text-xs text-muted-foreground">
            {t(($) => $.configuration.members_hint)}
          </p>
        </fieldset>
      <Button type="submit" disabled={legacyConnection || invalid || (!input.endpoint_id && input.provider === "antigravity")}>{t($ => $.configuration.save_group)}</Button>{" "}
      <Button type="button" variant="outline" onClick={onCancel}>{t($ => $.configuration.cancel)}</Button>
    </fieldset>
  </form>;
}
