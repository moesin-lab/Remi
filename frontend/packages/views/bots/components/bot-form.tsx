"use client";

import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { Bot, BotPlatformBindingInput, BotRoute, BotTarget, SaveBotInput } from "@multiremi/core/bots";
import { agentListOptions } from "@multiremi/core/workspace/queries";
import { createSafeId } from "@multiremi/core/utils";
import { runtimeListOptions } from "@multiremi/core/runtimes/queries";
import { Button } from "@multiremi/ui/components/ui/button";
import { Input } from "@multiremi/ui/components/ui/input";
import { Label } from "@multiremi/ui/components/ui/label";
import { Switch } from "@multiremi/ui/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@multiremi/ui/components/ui/select";
import { WorkLocationPicker } from "../../runtimes/components/runtime-workspace-picker";
import { useT } from "../../i18n";

export function botInput(bot: Bot): SaveBotInput {
  return {
    workspace_id: bot.workspace_id,
    name: bot.name,
    enabled: bot.enabled,
    allowlist_enabled: bot.allowlist_enabled,
    issue_notifications: bot.issue_notifications,
    default_target: { ...bot.default_target },
    routes: bot.routes.map(route => ({ ...route, match: { ...route.match }, target: { ...route.target } })),
    platform_bindings: bot.platform_bindings.map(binding => ({
      id: binding.id, platform: binding.platform, app_id: binding.app_id, domain: binding.domain,
      host_runtime_id: binding.host_runtime_id, enabled: binding.enabled, app_secret_op: "keep",
    })),
  };
}

function emptyBinding(): BotPlatformBindingInput {
  return { id: createSafeId(), platform: "feishu", app_id: "", domain: "feishu", host_runtime_id: "", enabled: true, app_secret_op: "set", app_secret: "" };
}

export function BotForm({ wsId, bot, busy, readOnly = false, onSave, onDirtyChange }: {
  wsId: string;
  bot: Bot | null;
  busy: boolean;
  readOnly?: boolean;
  onSave: (input: SaveBotInput) => Promise<Bot>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { t } = useT("bots");
  const [draft, setDraft] = useState<SaveBotInput>(() => bot ? botInput(bot) : {
    workspace_id: wsId, name: "", enabled: false, allowlist_enabled: false, issue_notifications: null,
    default_target: { kind: "agent", agent_id: "", runtime_id: null, project_id: null, runtime_workspace_id: null },
    platform_bindings: [emptyBinding()], routes: [],
  });
  const [dirty, setDirty] = useState(false);
  const agents = useQuery(agentListOptions(wsId));
  const runtimes = useQuery(runtimeListOptions(wsId));

  useEffect(() => {
    if (bot && !dirty) setDraft(botInput(bot));
  }, [bot, dirty]);

  function edit(patch: Partial<SaveBotInput>) {
    setDraft(current => ({ ...current, ...patch }));
    setDirty(true);
    onDirtyChange(true);
  }
  const rules = draft.routes ?? [];
  function editBinding(index: number, patch: Partial<BotPlatformBindingInput>) {
    edit({ platform_bindings: draft.platform_bindings.map((binding, i) => i === index ? { ...binding, ...patch } : binding) });
  }
  function editRule(index: number, patch: Partial<BotRoute>) {
    edit({ routes: rules.map((route, i) => i === index ? { ...route, ...patch } : route) });
  }
  function moveRule(index: number, offset: number) {
    const next = [...rules];
    [next[index], next[index + offset]] = [next[index + offset]!, next[index]!];
    edit({ routes: next });
  }
  function removeBinding(index: number) {
    const id = draft.platform_bindings[index]?.id;
    // Remove rules scoped solely to this account rather than silently widening them to all accounts.
    edit({
      platform_bindings: draft.platform_bindings.filter((_, i) => i !== index),
      issue_notifications: draft.issue_notifications?.platform_binding_id === id ? null : draft.issue_notifications,
      routes: rules.filter(rule => !(rule.match.platform_binding_ids?.length === 1 && rule.match.platform_binding_ids[0] === id))
        .map(rule => ({ ...rule, match: { ...rule.match, ...(rule.match.platform_binding_ids ? { platform_binding_ids: rule.match.platform_binding_ids.filter(value => value !== id) } : {}) } })),
    });
  }
  const agentChoices = (agents.data ?? []).filter(agent => !agent.archived_at).map(agent => ({ value: agent.id, label: agent.name, provider: agent.provider }));
  const runtimeChoices = (runtimes.data ?? []).map(runtime => ({ value: runtime.id, provider: runtime.provider, label: `${runtime.name} · ${runtime.provider}${runtime.status === "offline" ? ` · ${t($ => $.offline)}` : ""}` }));
  const unsupported = draft.default_target.kind !== "agent" || draft.platform_bindings.some(binding => binding.platform !== "feishu" || !["feishu", "lark", "bytedance"].includes(binding.domain ?? "feishu")) || rules.some(rule => rule.target.kind !== "agent") || Boolean(draft.issue_notifications?.target && draft.issue_notifications.target.kind !== "agent");
  const hasIncompatibleRuntime = incompatibleRuntime(draft.default_target, agentChoices, runtimeChoices)
    || rules.some(rule => incompatibleRuntime(rule.target, agentChoices, runtimeChoices, draft.default_target.runtime_id))
    || (draft.issue_notifications?.target && incompatibleRuntime(draft.issue_notifications.target, agentChoices, runtimeChoices, draft.default_target.runtime_id));
  const valid = !unsupported && !hasIncompatibleRuntime && (!draft.issue_notifications || (draft.issue_notifications.platform_binding_id && draft.issue_notifications.chat_id.trim() && (!draft.issue_notifications.target || draft.issue_notifications.target.agent_id))) && draft.name.trim() && draft.default_target.agent_id && draft.platform_bindings.length > 0
    && draft.platform_bindings.every(binding => binding.app_id.trim() && binding.host_runtime_id && (binding.app_secret?.trim() || bot?.platform_bindings.some(saved => saved.id === binding.id && (saved.app_secret_configured || !draft.enabled || binding.enabled === false))))
    && rules.every(rule => rule.name.trim() && rule.target.agent_id);

  async function submit() {
    if (!valid || busy || readOnly) return;
    const saved = await onSave({ ...draft, name: draft.name.trim(), platform_bindings: draft.platform_bindings.map(binding => ({ ...binding, app_id: binding.app_id.trim(), app_secret_op: binding.app_secret?.trim() ? "set" : "keep", ...(binding.app_secret?.trim() ? { app_secret: binding.app_secret.trim() } : { app_secret: undefined }) })) });
    setDraft(botInput(saved));
    setDirty(false);
    onDirtyChange(false);
  }

  return <form id="bot-form" onSubmit={event => { event.preventDefault(); void submit().catch(() => {}); }} className="space-y-6">
    {readOnly && <p className="text-sm text-muted-foreground">{t($ => $.read_only)}</p>}
    {unsupported && <p role="alert" className="text-sm text-destructive">{t($ => $.unsupported)}</p>}
    <fieldset disabled={busy || unsupported || readOnly} className="space-y-6 disabled:opacity-70">
      <Field label={t($ => $.name)} id="bot-name"><Input id="bot-name" value={draft.name} onChange={event => edit({ name: event.target.value })} required /></Field>

      <section className="space-y-3 rounded-lg border p-4" aria-labelledby="bot-platforms-title">
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 id="bot-platforms-title" className="text-sm font-semibold">{t($ => $.platforms)}</h2><Button type="button" size="sm" variant="outline" onClick={() => edit({ platform_bindings: [...draft.platform_bindings, emptyBinding()] })}><Plus className="size-4" />{t($ => $.add_platform)}</Button></div>
        <p className="text-xs text-muted-foreground">{t($ => $.platforms_hint)}</p>
        {draft.platform_bindings.map((binding, index) => {
          const existing = bot?.platform_bindings.find(saved => saved.id === binding.id);
          const prefix = `binding-${binding.id}`;
          return <div key={binding.id} className="space-y-3 rounded-md border bg-muted/10 p-3" role="group" aria-label={t($ => $.platform_number, { number: index + 1 })}>
            <div className="flex items-center justify-between"><span className="text-xs font-medium">{t($ => $.platform_number, { number: index + 1 })}</span><div className="flex items-center gap-3"><Switch checked={binding.enabled !== false} onCheckedChange={enabled => editBinding(index, { enabled })} aria-label={t($ => $.binding_enabled)} /><Button variant="ghost" size="icon" type="button" aria-label={t($ => $.remove_platform)} onClick={() => removeBinding(index)}><Trash2 className="size-4" /></Button></div></div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Choice label={t($ => $.platform)} value={binding.domain ?? "feishu"} disabled={Boolean(existing)} options={[{ value: "feishu", label: t($ => $.feishu) }, { value: "lark", label: t($ => $.lark) }, { value: "bytedance", label: t($ => $.bytedance) }]} onChange={domain => editBinding(index, { domain: domain as BotPlatformBindingInput["domain"] })} />
              <Field label={t($ => $.app_id)} id={`${prefix}-app`}><Input id={`${prefix}-app`} value={binding.app_id} disabled={Boolean(existing)} onChange={event => editBinding(index, { app_id: event.target.value })} autoComplete="off" required /></Field>
              <Field label={t($ => $.app_secret)} id={`${prefix}-secret`}><Input id={`${prefix}-secret`} type="password" autoComplete="new-password" value={binding.app_secret ?? ""} placeholder={existing?.app_secret_configured ? t($ => $.keep_secret) : ""} onChange={event => editBinding(index, { app_secret: event.target.value })} /></Field>
              <Choice label={t($ => $.host_runtime)} value={binding.host_runtime_id} options={runtimeChoices} onChange={host_runtime_id => editBinding(index, { host_runtime_id })} />
            </div>
            {existing && <p className="text-xs text-muted-foreground">{t($ => $.identity_hint)}</p>}
          </div>;
        })}
      </section>

      <section className="space-y-3 rounded-lg border p-4" aria-labelledby="bot-target-title">
        <h2 id="bot-target-title" className="text-sm font-semibold">{t($ => $.default_target)}</h2>
        <TargetFields wsId={wsId} target={draft.default_target} agents={agentChoices} runtimes={runtimeChoices} onChange={default_target => edit({ default_target })} />
      </section>

      <section className="space-y-3 rounded-lg border p-4" aria-labelledby="bot-routes-title">
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 id="bot-routes-title" className="text-sm font-semibold">{t($ => $.routes)}</h2><Button type="button" size="sm" variant="outline" onClick={() => edit({ routes: [...rules, { id: createSafeId(), name: t($ => $.route_number, { number: rules.length + 1 }), match: {}, target: { kind: "agent", agent_id: draft.default_target.agent_id } }] })}><Plus className="size-4" />{t($ => $.add_route)}</Button></div>
        <p className="text-xs text-muted-foreground">{t($ => $.routes_hint)}</p>
        {rules.length === 0 && <p className="py-2 text-sm text-muted-foreground">{t($ => $.routes_empty)}</p>}
        {rules.map((route, index) => <div key={route.id} className="space-y-3 rounded-md border bg-muted/10 p-3" role="group" aria-label={t($ => $.route_number, { number: index + 1 })}>
          <div className="flex items-center gap-2"><Input aria-label={t($ => $.route_name)} className="flex-1" value={route.name} onChange={event => editRule(index, { name: event.target.value })} /><Button variant="ghost" size="icon" type="button" disabled={index === 0} aria-label={t($ => $.move_up)} onClick={() => moveRule(index, -1)}><ArrowUp className="size-4" /></Button><Button variant="ghost" size="icon" type="button" disabled={index === rules.length - 1} aria-label={t($ => $.move_down)} onClick={() => moveRule(index, 1)}><ArrowDown className="size-4" /></Button><Button variant="ghost" size="icon" type="button" aria-label={t($ => $.remove_route)} onClick={() => edit({ routes: rules.filter((_, i) => i !== index) })}><Trash2 className="size-4" /></Button></div>
          <div className="space-y-2"><span className="text-xs font-medium">{t($ => $.matching_accounts)}</span><p className="text-xs text-muted-foreground">{t($ => $.matching_accounts_hint)}</p><div className="flex flex-wrap gap-3">{draft.platform_bindings.map((binding, bindingIndex) => <label key={binding.id} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={route.match.platform_binding_ids?.includes(binding.id!) ?? false} onChange={event => {
            const ids = route.match.platform_binding_ids ?? [];
            const next = event.target.checked ? [...ids, binding.id!] : ids.filter(id => id !== binding.id);
            editRule(index, { match: { ...route.match, platform_binding_ids: next.length ? next : undefined } });
          }} />{binding.app_id || t($ => $.platform_number, { number: bindingIndex + 1 })}</label>)}</div></div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Choice label={t($ => $.chat_type)} value={route.match.chat_types?.length === 1 ? route.match.chat_types[0]! : "all"} options={[{ value: "all", label: t($ => $.all) }, { value: "p2p", label: t($ => $.direct_message) }, { value: "group", label: t($ => $.group_chat) }]} onChange={value => editRule(index, { match: { ...route.match, chat_types: value === "all" ? undefined : [value as "p2p" | "group"] } })} />
            <Field label={t($ => $.chat_ids)} id={`route-${route.id}-chats`}><ListInput id={`route-${route.id}-chats`} values={route.match.chat_ids} onChange={chat_ids => editRule(index, { match: { ...route.match, chat_ids } })} /></Field>
            <Field label={t($ => $.commands)} id={`route-${route.id}-commands`}><ListInput id={`route-${route.id}-commands`} values={route.match.commands} onChange={commands => editRule(index, { match: { ...route.match, commands } })} /></Field>
          </div>
          <TargetFields wsId={wsId} target={route.target} inherited defaultTarget={draft.default_target} agents={agentChoices} runtimes={runtimeChoices} onChange={target => editRule(index, { target })} />
        </div>)}
      </section>

      <section className="space-y-3 rounded-lg border p-4">
        <div className="flex items-center justify-between gap-3"><Label htmlFor="bot-notifications">{t($ => $.notifications)}</Label><Switch id="bot-notifications" checked={Boolean(draft.issue_notifications)} onCheckedChange={enabled => edit({ issue_notifications: enabled ? { platform_binding_id: draft.platform_bindings[0]?.id ?? "", chat_id: "" } : null })} /></div>
        <p className="text-xs text-muted-foreground">{t($ => $.notifications_hint)}</p>
        {draft.issue_notifications && <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Choice label={t($ => $.notification_account)} value={draft.issue_notifications.platform_binding_id} options={draft.platform_bindings.map((binding, index) => ({ value: binding.id!, label: binding.app_id || t($ => $.platform_number, { number: index + 1 }) }))} onChange={platform_binding_id => edit({ issue_notifications: { ...draft.issue_notifications!, platform_binding_id } })} />
            <Field label={t($ => $.notification_chat)} id="bot-notification-chat"><Input id="bot-notification-chat" value={draft.issue_notifications.chat_id} onChange={event => edit({ issue_notifications: { ...draft.issue_notifications!, chat_id: event.target.value } })} /></Field>
            <Field label={t($ => $.notification_projects)} id="bot-notification-projects"><ListInput id="bot-notification-projects" values={draft.issue_notifications.project_ids} onChange={project_ids => edit({ issue_notifications: { ...draft.issue_notifications!, project_ids } })} /></Field>
          </div>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={!draft.issue_notifications.target} onChange={event => edit({ issue_notifications: { ...draft.issue_notifications!, target: event.target.checked ? undefined : { kind: "agent", agent_id: draft.default_target.agent_id } } })} />{t($ => $.notification_default)}</label>
          {draft.issue_notifications.target && <TargetFields wsId={wsId} target={draft.issue_notifications.target} inherited defaultTarget={draft.default_target} agents={agentChoices} runtimes={runtimeChoices} onChange={target => edit({ issue_notifications: { ...draft.issue_notifications!, target } })} />}
        </div>}
      </section>

      <section className="space-y-2 rounded-lg border p-4">
        <div className="flex items-center justify-between gap-3"><Label htmlFor="bot-allowlist">{t($ => $.allowlist)}</Label><Switch id="bot-allowlist" checked={draft.allowlist_enabled ?? false} onCheckedChange={allowlist_enabled => edit({ allowlist_enabled })} /></div>
        <p className="text-xs leading-5 text-muted-foreground">{t($ => $.allowlist_hint)}</p>
      </section>
      {(agents.isError || runtimes.isError) && <p role="alert" className="text-sm text-destructive">{t($ => $.candidates_failed)}</p>}
      <Button type="submit" disabled={!valid || busy || readOnly || agents.isPending || runtimes.isPending}>{busy ? t($ => $.saving) : bot ? t($ => $.save) : t($ => $.create)}</Button>
    </fieldset>
  </form>;
}

function Field({ label, id, children }: { label: string; id: string; children: React.ReactNode }) {
  return <div className="min-w-0 space-y-1.5"><Label htmlFor={id}>{label}</Label>{children}</div>;
}

type Option = { value: string; label: string; provider?: string };

function incompatibleRuntime(target: BotTarget, agents: Option[], runtimes: Option[], defaultRuntimeId?: string | null) {
  const provider = agents.find(agent => agent.value === target.agent_id)?.provider;
  const runtimeId = target.runtime_id === undefined ? defaultRuntimeId : target.runtime_id;
  const runtime = runtimes.find(candidate => candidate.value === runtimeId);
  return Boolean(provider && runtime?.provider && runtime.provider !== "any" && runtime.provider !== provider);
}
function Choice({ label, value, options, onChange, disabled }: { label: string; value: string; options: Option[]; onChange: (value: string) => void; disabled?: boolean }) {
  const { t } = useT("bots");
  const selected = options.find(option => option.value === value);
  return <div className="min-w-0 space-y-1.5"><Label>{label}</Label><Select value={value} disabled={disabled} onValueChange={next => { if (next !== null) onChange(next); }}><SelectTrigger aria-label={label} className="w-full min-w-0"><SelectValue>{() => selected?.label ?? (value || t($ => $.select))}</SelectValue></SelectTrigger><SelectContent>{options.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></div>;
}

function TargetFields({ wsId, target, agents, runtimes, inherited = false, defaultTarget, onChange }: {
  wsId: string; target: BotTarget; agents: Option[]; runtimes: Option[]; inherited?: boolean; defaultTarget?: BotTarget; onChange: (target: BotTarget) => void;
}) {
  const { t } = useT("bots");
  const provider = agents.find(agent => agent.value === target.agent_id)?.provider;
  const compatibleRuntimes = runtimes.filter(runtime => !provider || runtime.provider === "any" || runtime.provider === provider || runtime.value === target.runtime_id);
  const locationInherited = inherited && target.project_id === undefined && target.runtime_workspace_id === undefined;
  // Display the resolved location while preserving each original omission/null in the draft.
  const projectId = target.runtime_workspace_id ? null : target.project_id === undefined ? defaultTarget?.project_id ?? null : target.project_id;
  const runtimeWorkspaceId = target.project_id ? null : target.runtime_workspace_id === undefined ? defaultTarget?.runtime_workspace_id ?? null : target.runtime_workspace_id;
  const partialLocationInherited = inherited && !locationInherited && ((target.project_id === undefined && !target.runtime_workspace_id) || (target.runtime_workspace_id === undefined && !target.project_id));
  return <div className="grid gap-3 sm:grid-cols-2">
    <Choice label={t($ => $.agent)} value={target.agent_id} options={agents} onChange={agent_id => onChange({ ...target, agent_id })} />
    <Choice label={t($ => $.execution_runtime)} value={target.runtime_id === undefined && inherited ? "inherit" : target.runtime_id ?? "auto"} options={[...(inherited ? [{ value: "inherit", label: t($ => $.inherit) }] : []), { value: "auto", label: t($ => $.automatic) }, ...compatibleRuntimes]} onChange={value => onChange({ ...target, runtime_id: value === "inherit" ? undefined : value === "auto" ? null : value })} />
    {incompatibleRuntime(target, agents, runtimes, defaultTarget?.runtime_id) && <p role="alert" className="text-xs text-destructive sm:col-span-2">{t($ => $.runtime_incompatible)}</p>}
    <div className="space-y-2 sm:col-span-2"><div className="flex flex-wrap items-center gap-3"><span className="text-xs font-medium">{t($ => $.work_location)}</span>{inherited && <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={locationInherited} onChange={event => onChange({ ...target, project_id: event.target.checked ? undefined : null, runtime_workspace_id: event.target.checked ? undefined : null })} />{t($ => $.inherit)}</label>}</div>{!locationInherited && <WorkLocationPicker wsId={wsId} projectId={projectId} value={runtimeWorkspaceId} onChange={location => onChange({ ...target, ...location })} />}{partialLocationInherited && <p className="text-xs text-muted-foreground">{t($ => $.partial_location_inheritance)}</p>}</div>
  </div>;
}

/** Keep separators while typing, and commit parsed values before an Enter submission. */
function ListInput({ id, values, onChange }: { id: string; values?: string[]; onChange: (values: string[] | undefined) => void }) {
  const { t } = useT("bots");
  const serialized = values?.join(", ") ?? "";
  const [text, setText] = useState(serialized);
  function parse(value: string) { return [...new Set(value.split(/[,，\n]/).map(part => part.trim()).filter(Boolean))]; }
  useEffect(() => { setText(current => parse(current).join(", ") === serialized ? current : serialized); }, [serialized]);
  return <Input id={id} value={text} placeholder={t($ => $.list_hint)} onChange={event => {
    const value = event.target.value;
    setText(value);
    const next = parse(value);
    onChange(next.length ? next : undefined);
  }} />;
}
