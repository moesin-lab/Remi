"use client";

import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import type { AgentRuntime } from "@multiremi/core/types";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { runtimeCodexProfileOptions, useSetRuntimeCodexProfile, type RuntimeCodexProfile } from "@multiremi/core/runtimes/codex-profile";
import { Button } from "@multiremi/ui/components/ui/button";
import { Input } from "@multiremi/ui/components/ui/input";
import { Switch } from "@multiremi/ui/components/ui/switch";
import { NativeSelect, NativeSelectOption } from "@multiremi/ui/components/ui/native-select";
import { useT } from "../../i18n";

export function RuntimeCodexProfileTab({ runtime, canManage }: { runtime: AgentRuntime; canManage: boolean }) {
  const wsId = useWorkspaceId();
  const { t } = useT("runtimes");
  const query = useQuery(runtimeCodexProfileOptions(wsId, runtime.id));
  return <div className="mx-auto w-full max-w-3xl space-y-5 p-4 sm:p-8">
    <header className="space-y-2">
      <h2 className="text-xl font-semibold">{t($ => $.codex_profile.title)}</h2>
      <p className="text-sm leading-6 text-muted-foreground">{t($ => $.codex_profile.description)}</p>
    </header>
    {query.isPending ? <p role="status">{t($ => $.codex_profile.loading)}</p>
      : query.isError ? <div role="alert"><p>{t($ => $.codex_profile.load_error)}</p><Button onClick={() => void query.refetch()}>{t($ => $.codex_profile.retry)}</Button></div>
      : <ProfileForm key={`${wsId}:${runtime.id}:${JSON.stringify(query.data)}`} wsId={wsId} runtime={runtime} canManage={canManage} initial={query.data.profile} />}
  </div>;
}

function ProfileForm({ wsId, runtime, canManage, initial }: { wsId: string; runtime: AgentRuntime; canManage: boolean; initial: RuntimeCodexProfile | null }) {
  const { t } = useT("runtimes");
  const prefix = useId();
  const [enabled, setEnabled] = useState(Boolean(initial));
  const [profile, setProfile] = useState<RuntimeCodexProfile>(initial ?? { name: "custom", base_url: "", model: "", env_key: "", auth_mode: "api_key" });
  const [apiKey, setApiKey] = useState("");
  const save = useSetRuntimeCodexProfile(wsId, runtime.id);
  const supported = runtime.metadata.codex_profiles === 1;
  const editable = canManage && supported && !save.isPending;
  const fields = [
    { key: "name", label: t($ => $.codex_profile.name), placeholder: "custom" },
    { key: "base_url", label: t($ => $.codex_profile.base_url), placeholder: "https://example.com/v1" },
    { key: "model", label: t($ => $.codex_profile.model), placeholder: "my-model" },
  ] as const;
  return <form className="space-y-5 rounded-xl border bg-card p-5" onSubmit={event => {
    event.preventDefault();
    if (editable) save.mutate({ profile: enabled ? profile : null,
      ...(enabled && profile.auth_mode === "api_key" && apiKey ? { api_key: apiKey } : {}),
    }, { onSuccess: () => { setApiKey(""); toast.success(t($ => $.codex_profile.saved)); } });
  }}>
    <div className="flex items-center justify-between gap-4">
      <label htmlFor={`${prefix}-enabled`} className="text-sm font-medium">{t($ => $.codex_profile.enabled)}</label>
      <Switch id={`${prefix}-enabled`} checked={enabled} onCheckedChange={setEnabled} disabled={!editable} />
    </div>
    {!supported && <p role="status" className="text-sm text-muted-foreground">{t($ => $.codex_profile.update_required)}</p>}
    {enabled ? <>
      {fields.map(({ key, label, placeholder }) => <div className="space-y-2" key={key}>
        <label htmlFor={`${prefix}-${key}`} className="text-sm font-medium">{label}</label>
        <Input id={`${prefix}-${key}`} value={profile[key]} placeholder={placeholder} required disabled={!editable} autoComplete="off" spellCheck={false} onChange={event => setProfile(current => ({ ...current, [key]: event.target.value }))} />
      </div>)}
      <div className="space-y-2">
        <label htmlFor={`${prefix}-auth`} className="text-sm font-medium">{t($ => $.codex_profile.auth)}</label>
        <NativeSelect id={`${prefix}-auth`} value={profile.auth_mode ?? "env"} disabled={!editable} onChange={event => {
          const auth_mode = event.target.value as "api_key" | "env";
          setApiKey("");
          setProfile(current => ({ ...current, auth_mode, env_key: auth_mode === "env" ? current.env_key || "REMI_CODEX_API_KEY" : "" }));
        }}>
          <NativeSelectOption value="api_key">{t($ => $.codex_profile.api_key)}</NativeSelectOption>
          <NativeSelectOption value="env">{t($ => $.codex_profile.environment)}</NativeSelectOption>
        </NativeSelect>
      </div>
      {profile.auth_mode === "api_key" ? <div className="space-y-2">
        <label htmlFor={`${prefix}-key`} className="text-sm font-medium">{t($ => $.codex_profile.api_key)}</label>
        <Input id={`${prefix}-key`} type="password" autoComplete="new-password" value={apiKey} disabled={!editable} required={!initial?.credential_id} placeholder={initial?.credential_id ? t($ => $.codex_profile.key_saved) : ""} onChange={event => setApiKey(event.target.value)} />
        <p className="text-sm leading-6 text-muted-foreground">{t($ => $.codex_profile.key_hint)}</p>
      </div> : <div className="space-y-2">
        <label htmlFor={`${prefix}-env`} className="text-sm font-medium">{t($ => $.codex_profile.env_key)}</label>
        <Input id={`${prefix}-env`} value={profile.env_key} required disabled={!editable} autoComplete="off" onChange={event => setProfile(current => ({ ...current, env_key: event.target.value }))} />
        <p className="text-sm leading-6 text-muted-foreground">{t($ => $.codex_profile.credentials_hint)}</p>
      </div>}
    </> : <p className="text-sm text-muted-foreground">{t($ => $.codex_profile.inherit)}</p>}
    <p className="text-sm leading-6 text-muted-foreground">{t($ => $.codex_profile.sessions_hint)}</p>
    {save.isError && <p role="alert" className="text-sm text-destructive">{save.error.message}</p>}
    {canManage && <Button type="submit" disabled={!editable}>{t($ => save.isPending ? $.codex_profile.saving : $.codex_profile.save)}</Button>}
  </form>;
}
