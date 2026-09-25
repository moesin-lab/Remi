"use client";

import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@multiremi/core/api";
import { useAuthStore } from "@multiremi/core/auth";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useWorkspacePaths } from "@multiremi/core/paths";
import { memberListOptions } from "@multiremi/core/workspace/queries";
import { executionProfileListOptions, executionGroupListOptions, runtimeListOptions, useExecutionConfigMutation, type ExecutionProfile, type ExecutionProfileInput, type ExecutionGroupInput, type ExecutionGroupList } from "@multiremi/core/runtimes";
import { Button } from "@multiremi/ui/components/ui/button";
import { Input } from "@multiremi/ui/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@multiremi/ui/components/ui/native-select";
import { BreadcrumbHeader } from "../../layout/breadcrumb-header";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";

type Group = ExecutionGroupList["groups"][number];

export function ExecutionConfigPage() {
  const { t } = useT("runtimes");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const user = useAuthStore(s => s.user);
  const members = useQuery(memberListOptions(wsId));
  const canManage = members.data?.some(m => m.user_id === user?.id && (m.role === "owner" || m.role === "admin")) ?? false;
  const profiles = useQuery({ ...executionProfileListOptions(wsId), enabled: canManage });
  const groups = useQuery({ ...executionGroupListOptions(wsId), refetchInterval: 10_000 });
  const runtimes = useQuery(runtimeListOptions(wsId));
  const mutation = useExecutionConfigMutation(wsId);
  const [editProfile, setEditProfile] = useState<ExecutionProfile | "new" | null>(null);
  const [editGroup, setEditGroup] = useState<Group | "new" | null>(null);
  const run = (command: () => Promise<unknown>, done?: () => void) => mutation.mutate(command, { onSuccess: done });

  return <div className="flex h-full min-h-0 flex-col">
    <BreadcrumbHeader segments={[{ href: paths.runtimes(), label: t($ => $.page.title) }]} leaf={t($ => $.configuration.title)} />
    <div className="flex-1 space-y-6 overflow-y-auto p-4 sm:p-6">
      <p className="text-sm text-muted-foreground">{t($ => $.configuration.description)}</p>
      {!canManage && <p role="status">{t($ => $.detail.read_only)}</p>}
      {mutation.isError && <p role="alert" className="text-destructive">{mutation.error.message}</p>}
      {(profiles.isError || groups.isError || runtimes.isError) && <p role="alert" className="text-destructive">{t($ => $.configuration.load_error)}</p>}
      {(groups.isPending || runtimes.isPending || (canManage && profiles.isPending)) && <p role="status">{t($ => $.codex_profile.loading)}</p>}
      {canManage && <section className="space-y-3">
        <div className="flex items-center justify-between"><h2 className="font-semibold">{t($ => $.configuration.profiles)}</h2><Button disabled={mutation.isPending} onClick={() => setEditProfile("new")}>{t($ => $.configuration.add_profile)}</Button></div>
        {profiles.data?.profiles.length === 0 && <p className="text-sm text-muted-foreground">{t($ => $.configuration.no_profiles)}</p>}
        {profiles.data?.profiles.map(profile => <div key={profile.id} className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
          <div className="min-w-0 flex-1"><p className="truncate font-medium">{profile.name}</p><p className="truncate text-xs text-muted-foreground">{profile.provider} · {profile.profile.model} · v{profile.revision}</p></div>
          <Button variant="outline" disabled={mutation.isPending} onClick={() => setEditProfile(profile)}>{t($ => $.configuration.edit)}</Button>
          <Button variant="outline" disabled={mutation.isPending || groups.data?.groups.some(g => g.profile_id === profile.id)} onClick={() => run(() => api.deleteExecutionProfile(wsId, profile.id))}>{t($ => $.configuration.delete)}</Button>
        </div>)}
        {editProfile && <ProfileForm key={editProfile === "new" ? "new" : `${editProfile.id}:${editProfile.revision}`} initial={editProfile === "new" ? undefined : editProfile} pending={mutation.isPending} onCancel={() => setEditProfile(null)} onSave={input => run(() => api.saveExecutionProfile(wsId, editProfile === "new" ? undefined : editProfile.id, input), () => setEditProfile(null))} />}
      </section>}
      <section className="space-y-3">
        <div className="flex items-center justify-between"><h2 className="font-semibold">{t($ => $.configuration.groups)}</h2>{canManage && <Button disabled={mutation.isPending} onClick={() => setEditGroup("new")}>{t($ => $.configuration.add_group)}</Button>}</div>
        {groups.data?.groups.length === 0 && <p className="text-sm text-muted-foreground">{t($ => $.configuration.no_groups)}</p>}
        {groups.data?.groups.map(group => <div className="space-y-2 rounded-lg border p-3" key={group.id}>
          <div className="flex flex-wrap items-center gap-3"><div className="min-w-0 flex-1"><p className="truncate font-medium">{group.name}</p><p className="text-xs text-muted-foreground">{group.provider} · {profiles.data?.profiles.find(p => p.id === group.profile_id)?.name ?? (group.profile_id || t($ => group.managed === false ? $.configuration.legacy : $.configuration.native))}</p></div>{canManage && <><Button variant="outline" disabled={mutation.isPending} onClick={() => setEditGroup(group)}>{t($ => $.configuration.edit)}</Button><Button variant="outline" disabled={mutation.isPending} onClick={() => run(() => api.deleteExecutionGroup(wsId, group.id))}>{t($ => $.configuration.delete)}</Button></>}</div>
          {group.runtime_ids.map(id => <div className="flex items-center justify-between gap-3 text-sm" key={id}><span className="truncate">{runtimes.data?.find(r => r.id === id)?.name ?? id}</span><BindingState group={group} runtimeId={id} /></div>)}
        </div>)}
        {editGroup && <GroupForm key={editGroup === "new" ? "new" : editGroup.id} initial={editGroup === "new" ? undefined : editGroup} profiles={profiles.data?.profiles ?? []} runtimes={runtimes.data ?? []} pending={mutation.isPending} onCancel={() => setEditGroup(null)} onSave={input => run(() => api.saveExecutionGroup(wsId, editGroup === "new" ? undefined : editGroup.id, input), () => setEditGroup(null))} />}
      </section>
    </div>
  </div>;
}

function ProfileForm({ initial, pending, onSave, onCancel }: { initial?: ExecutionProfile; pending: boolean; onSave: (input: ExecutionProfileInput) => void; onCancel: () => void }) {
  const { t } = useT("runtimes");
  const [input, setInput] = useState<ExecutionProfileInput>(initial ?? { name: "", provider: "codex", profile: { name: "custom", base_url: "", model: "", env_key: "", auth_mode: "api_key" } });
  const [apiKey, setApiKey] = useState("");
  const profile = input.profile;
  const change = (patch: Partial<typeof profile>) => setInput(current => ({ ...current, profile: { ...current.profile, ...patch } }));
  return <form className="space-y-3 rounded-lg border bg-card p-4" onSubmit={event => { event.preventDefault(); onSave({ name: input.name, provider: input.provider, profile, ...(apiKey && profile.auth_mode === "api_key" ? { api_key: apiKey } : {}) }); }}>
    <label className="block text-sm">{t($ => $.configuration.name)}<Input required value={input.name} onChange={e => setInput({ ...input, name: e.target.value })} /></label>
    <label className="block text-sm">{t($ => $.configuration.provider)}<NativeSelect value={input.provider} disabled={!!initial} onChange={e => setInput({ ...input, provider: e.target.value as "claude" | "codex" })}><NativeSelectOption value="codex">Codex</NativeSelectOption><NativeSelectOption value="claude">Claude Code</NativeSelectOption></NativeSelect></label>
    {(["name", "base_url", "model"] as const).map(key => <label className="block text-sm" key={key}>{t($ => $.codex_profile[key])}<Input required value={profile[key]} onChange={e => change({ [key]: e.target.value })} /></label>)}
    <label className="block text-sm">{t($ => $.codex_profile.auth)}<NativeSelect value={profile.auth_mode ?? "env"} onChange={e => { setApiKey(""); change({ auth_mode: e.target.value as "api_key" | "env" }); }}><NativeSelectOption value="api_key">{t($ => $.codex_profile.api_key)}</NativeSelectOption><NativeSelectOption value="env">{t($ => $.codex_profile.environment)}</NativeSelectOption></NativeSelect></label>
    {profile.auth_mode === "api_key" ? <label className="block text-sm">{t($ => $.codex_profile.api_key)}<Input type="password" autoComplete="new-password" required={!initial?.profile.credential_id} value={apiKey} placeholder={initial?.profile.credential_id ? t($ => $.codex_profile.key_saved) : ""} onChange={e => setApiKey(e.target.value)} /></label> : <label className="block text-sm">{t($ => $.codex_profile.env_key)}<Input required value={profile.env_key} onChange={e => change({ env_key: e.target.value })} /></label>}
    {input.provider === "claude" && <label className="block text-sm">{t($ => $.claude_profile.auth_header)}<NativeSelect value={profile.auth_header ?? "bearer"} onChange={e => change({ auth_header: e.target.value as "bearer" | "x-api-key" })}><NativeSelectOption value="bearer">Bearer Token</NativeSelectOption><NativeSelectOption value="x-api-key">API Key (x-api-key)</NativeSelectOption></NativeSelect></label>}
    <p className="text-xs text-muted-foreground">{t($ => $.codex_profile.sessions_hint)}</p>
    <Button type="submit" disabled={pending}>{t($ => $.codex_profile.save)}</Button> <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>{t($ => $.configuration.cancel)}</Button>
  </form>;
}

function GroupForm({ initial, profiles, runtimes, pending, onSave, onCancel }: { initial?: Group; profiles: ExecutionProfile[]; runtimes: Array<{ id: string; name: string; provider: string }>; pending: boolean; onSave: (input: ExecutionGroupInput) => void; onCancel: () => void }) {
  const { t } = useT("runtimes");
  const [input, setInput] = useState<ExecutionGroupInput>({ name: initial?.name ?? "", provider: initial?.provider ?? "codex", profile_id: initial?.profile_id ?? null, runtime_ids: initial?.runtime_ids ?? [] });
  const submit = (event: FormEvent) => { event.preventDefault(); onSave(input); };
  return <form className="space-y-3 rounded-lg border bg-card p-4" onSubmit={submit}>
    <label className="block text-sm">{t($ => $.configuration.name)}<Input required value={input.name} onChange={e => setInput({ ...input, name: e.target.value })} /></label>
    <label className="block text-sm">{t($ => $.configuration.provider)}<NativeSelect value={input.provider} disabled={!!initial} onChange={e => setInput({ ...input, provider: e.target.value, profile_id: null, runtime_ids: [] })}>{["codex", "claude", "antigravity"].map(provider => <NativeSelectOption key={provider} value={provider}>{provider}</NativeSelectOption>)}</NativeSelect></label>
    <label className="block text-sm">{t($ => $.configuration.profiles)}<NativeSelect value={input.profile_id ?? ""} onChange={e => setInput({ ...input, profile_id: e.target.value || null })}><NativeSelectOption value="">{t($ => $.configuration.native)}</NativeSelectOption>{profiles.filter(p => p.provider === input.provider).map(p => <NativeSelectOption key={p.id} value={p.id}>{p.name}</NativeSelectOption>)}</NativeSelect></label>
    <fieldset className="space-y-2"><legend className="mb-2 text-sm">{t($ => $.configuration.members)}</legend>{runtimes.filter(r => r.provider === input.provider || r.provider === "any").map(runtime => <label className="flex items-center gap-2 text-sm" key={runtime.id}><input type="checkbox" checked={input.runtime_ids.includes(runtime.id)} onChange={e => setInput({ ...input, runtime_ids: e.target.checked ? [...input.runtime_ids, runtime.id] : input.runtime_ids.filter(id => id !== runtime.id) })} /><span className="truncate">{runtime.name}</span></label>)}</fieldset>
    <Button type="submit" disabled={pending}>{t($ => $.codex_profile.save)}</Button> <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>{t($ => $.configuration.cancel)}</Button>
  </form>;
}

function BindingState({ group, runtimeId }: { group: Group; runtimeId: string }) {
  const { t } = useT("runtimes");
  const member = group.members?.find(m => m.runtime_id === runtimeId);
  const status = member?.status;
  return <span className="shrink-0 text-xs text-muted-foreground" title={member?.error ?? undefined}>{status === "ready" ? t($ => $.configuration.applied) : status === "error" ? t($ => $.configuration.failed) : status === "pending" ? t($ => $.configuration.pending) : t($ => $.configuration.unknown)}</span>;
}

export function RuntimeExecutionBindings({ runtimeId }: { runtimeId: string }) {
  const { t } = useT("runtimes");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const query = useQuery({ ...executionGroupListOptions(wsId), refetchInterval: 10_000 });
  const groups = query.data?.groups.filter(g => g.runtime_ids.includes(runtimeId)) ?? [];
  return <div className="space-y-2 text-sm">
    <AppLink className="text-primary underline" href={`${paths.runtimes()}/configuration`}>{t($ => $.configuration.title)}</AppLink>
    {query.isError ? <p role="alert">{t($ => $.configuration.load_error)}</p> : query.isPending ? <p role="status">{t($ => $.codex_profile.loading)}</p> : groups.length === 0 ? <p className="text-muted-foreground">{t($ => $.configuration.no_groups)}</p> : groups.map(group => <div className="flex justify-between gap-2" key={group.id}><span className="truncate">{group.name}</span><BindingState group={group} runtimeId={runtimeId} /></div>)}
  </div>;
}
