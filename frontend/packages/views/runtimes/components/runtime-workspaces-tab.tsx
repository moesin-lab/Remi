"use client";

import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FolderOpen, Archive } from "lucide-react";
import type { AgentRuntime } from "@multiremi/core/types";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { runtimeWorkspacesOptions, useCreateRuntimeWorkspace, useArchiveRuntimeWorkspace } from "@multiremi/core/runtimes/workspaces";
import { Button } from "@multiremi/ui/components/ui/button";
import { Input } from "@multiremi/ui/components/ui/input";
import { Textarea } from "@multiremi/ui/components/ui/textarea";
import { ProjectPicker } from "../../projects/components/project-picker";
import { useT } from "../../i18n";

export function RuntimeWorkspacesTab({ runtime, canManage }: { runtime: AgentRuntime; canManage: boolean }) {
  const { t } = useT("runtimes");
  const wsId = useWorkspaceId();
  const prefix = useId();
  const query = useQuery(runtimeWorkspacesOptions(wsId));
  const create = useCreateRuntimeWorkspace(wsId);
  const archive = useArchiveRuntimeWorkspace(wsId);
  const [name, setName] = useState("");
  const [root, setRoot] = useState("");
  const [cwd, setCwd] = useState(".");
  const [context, setContext] = useState("");
  const [envFile, setEnvFile] = useState("");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const workspaces = (query.data ?? []).filter(w => w.daemon_id === runtime.daemon_id);
  const error = create.error ?? archive.error;

  return <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
    <div className="space-y-2">
      <h2 className="flex items-center gap-2 text-base font-semibold"><FolderOpen className="size-4" />{t($ => $.workspaces.title)}</h2>
      <p className="text-sm text-muted-foreground">{t($ => $.workspaces.description)}</p>
    </div>
    {canManage && runtime.daemon_id && <form className="space-y-4 rounded-lg border p-4" onSubmit={async e => {
      e.preventDefault();
      setMessage("");
      try {
        await create.mutateAsync({ runtimeId: runtime.id, input: {
          name: name.trim(), root_path: root.trim(), cwd: cwd.trim() || ".",
          context_paths: context.split(/\r?\n/).map(p => p.trim()).filter(Boolean),
          env_file: envFile.trim() || null, project_id: projectId,
        } });
        setName(""); setRoot(""); setCwd("."); setContext(""); setEnvFile(""); setProjectId(null);
        setMessage(t($ => $.workspaces.registered));
      } catch { /* Keep the form and display the server error for correction. */ }
    }}>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1 text-sm" htmlFor={`${prefix}-name`}>{t($ => $.workspaces.name)}
          <Input id={`${prefix}-name`} value={name} onChange={e => setName(e.target.value)} required maxLength={120} placeholder={t($ => $.workspaces.name_placeholder)} />
        </label>
        <label className="space-y-1 text-sm" htmlFor={`${prefix}-root`}>{t($ => $.workspaces.root)}
          <Input id={`${prefix}-root`} value={root} onChange={e => setRoot(e.target.value)} required placeholder={t($ => $.workspaces.root_placeholder)} />
        </label>
        <label className="space-y-1 text-sm" htmlFor={`${prefix}-cwd`}>{t($ => $.workspaces.cwd)}
          <Input id={`${prefix}-cwd`} value={cwd} onChange={e => setCwd(e.target.value)} placeholder="." />
        </label>
        <div className="space-y-1 text-sm"><span>{t($ => $.workspaces.project)}</span>
          <ProjectPicker projectId={projectId} onUpdate={update => setProjectId(update.project_id ?? null)} />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t($ => $.workspaces.root_hint)}</p>
      <details className="space-y-3 text-sm">
        <summary className="cursor-pointer">{t($ => $.workspaces.context_options)}</summary>
        <label className="block space-y-1" htmlFor={`${prefix}-context`}>{t($ => $.workspaces.context_paths)}
          <Textarea id={`${prefix}-context`} value={context} onChange={e => setContext(e.target.value)} placeholder={t($ => $.workspaces.context_placeholder)} rows={3} />
        </label>
        <label className="block space-y-1" htmlFor={`${prefix}-env`}>{t($ => $.workspaces.env_file)}
          <Input id={`${prefix}-env`} value={envFile} onChange={e => setEnvFile(e.target.value)} placeholder=".env.local" />
        </label>
        <p className="text-xs text-muted-foreground">{t($ => $.workspaces.context_hint)}</p>
      </details>
      <Button type="submit" disabled={create.isPending || !name.trim() || !root.trim()}>{t($ => $.workspaces.register)}</Button>
    </form>}
    {error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}
    {message && <p role="status" className="text-sm text-success">{message}</p>}
    {query.isError ? <p role="alert" className="text-sm text-destructive">{t($ => $.workspaces.load_failed)}</p>
      : query.isPending ? <p className="text-sm text-muted-foreground">{t($ => $.workspaces.loading)}</p>
      : workspaces.length === 0 ? <p className="text-sm text-muted-foreground">{t($ => $.workspaces.empty)}</p>
      : <div className="space-y-3">{workspaces.map(w => <div key={w.id} className="space-y-2 rounded-lg border p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0"><p className="truncate font-medium">{w.name}</p>
            <p className="break-all font-mono text-xs text-muted-foreground">{w.root_path} / {w.cwd}</p>
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">{w.status === "available" ? t($ => $.workspaces.available) : t($ => $.workspaces.unavailable)}</span>
        </div>
        <p className="break-all text-xs text-muted-foreground">{w.id}</p>
        {canManage && <Button type="button" size="sm" variant="ghost" disabled={archive.isPending}
          onClick={() => { setMessage(""); archive.mutate(w.id, { onSuccess: () => setMessage(t($ => $.workspaces.archived)) }); }}>
          <Archive className="size-3" />{t($ => $.workspaces.archive)}
        </Button>}
      </div>)}</div>}
    <p className="text-xs text-muted-foreground">{t($ => $.workspaces.lifecycle_hint)}</p>
  </div>;
}
