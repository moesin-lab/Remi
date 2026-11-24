"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@multiremi/core/api";
import {
  chatWorkSessionKeys,
  chatWorkSessionsOptions,
  chatWorkSessionTasksOptions,
  useCreateChatWorkSessionTask,
} from "@multiremi/core/chat/work-sessions";
import { useIssueLog } from "@multiremi/core/session-log/use-issue-log";
import type { SessionLogRow } from "@multiremi/core/api/schemas/session-log";
import type { Agent, Session, SessionTask } from "@multiremi/core/types";
import { Button } from "@multiremi/ui/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@multiremi/ui/components/ui/dialog";
import { Label } from "@multiremi/ui/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@multiremi/ui/components/ui/native-select";
import { Textarea } from "@multiremi/ui/components/ui/textarea";
import { MessageHeader } from "../../common/message-header";
import { EntryHtml } from "../../common/session-log/entry-html";
import { SessionLogList } from "../../common/session-log/session-log-list";
import { TaskTraceDialog } from "../../common/task-transcript/task-trace-dialog";
import { HumanRequestDock } from "../../common/human-request-dock";
import { Markdown } from "../../common/markdown";
import { NewSessionDialog } from "../../issues/components/issue-session-bar";
import { useT } from "../../i18n";

const ACTIVE_STATUSES = new Set(["queued", "dispatched", "waiting_local_directory", "running", "awaiting_human"]);

export function ChatWorkSessionsDialog({ wsId, chatId, agentId, agents, chatArchived, open, onOpenChange }: {
  wsId: string;
  chatId: string;
  agentId: string;
  agents: Agent[];
  chatArchived: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useT("chat");
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="flex h-[85vh] max-h-[900px] flex-col sm:max-w-4xl">
      <DialogHeader>
        <DialogTitle>{t($ => $.work_sessions.title)}</DialogTitle>
        <DialogDescription>{t($ => $.work_sessions.description)}</DialogDescription>
      </DialogHeader>
      {open && <WorkSessionsContent key={chatId} wsId={wsId} chatId={chatId} agentId={agentId} agents={agents} chatArchived={chatArchived} />}
    </DialogContent>
  </Dialog>;
}

function WorkSessionsContent({ wsId, chatId, agentId, agents, chatArchived }: {
  wsId: string; chatId: string; agentId: string; agents: Agent[]; chatArchived: boolean;
}) {
  const { t } = useT("chat");
  const { t: issueT } = useT("issues");
  const sessionsQuery = useQuery(chatWorkSessionsOptions(wsId, chatId));
  const sessions = sessionsQuery.data ?? [];
  const [selectedId, setSelectedId] = useState("");
  const selected = sessions.find(session => session.id === selectedId)
    ?? sessions.find(session => session.is_default) ?? sessions[0];
  const [createOpen, setCreateOpen] = useState(false);
  const [parentId, setParentId] = useState<string | undefined>();
  const sessionName = (session: Session) => session.is_default ? issueT($ => $.detail.main_session) : session.title;

  return <>
    <div className="flex min-h-0 flex-1 flex-col gap-3 sm:flex-row">
      <div className="max-h-40 shrink-0 overflow-y-auto sm:max-h-none sm:w-44">
        <Button size="sm" variant="outline" className="mb-2 w-full" disabled={chatArchived}
          onClick={() => { setParentId(undefined); setCreateOpen(true); }}>
          {issueT($ => $.detail.new_session)}
        </Button>
        {sessionsQuery.isPending ? <p role="status" className="text-xs text-muted-foreground">{t($ => $.page.loading)}</p>
          : sessionsQuery.isError ? <div role="alert" className="text-xs text-destructive">
            <p>{t($ => $.work_sessions.load_failed)}</p>
            <Button size="sm" variant="ghost" onClick={() => void sessionsQuery.refetch()}>{t($ => $.page.retry)}</Button>
          </div>
            : sessions.length === 0 ? <p className="text-xs text-muted-foreground">{t($ => $.work_sessions.empty)}</p>
              : sessions.map(session => <Button key={session.id} variant={selected?.id === session.id ? "secondary" : "ghost"}
                className="mb-1 w-full justify-start truncate" onClick={() => setSelectedId(session.id)}
                aria-pressed={selected?.id === session.id}>
                <span className="truncate">{sessionName(session)}</span>
                {session.status === "archived" && <span className="ml-1 text-xs text-muted-foreground">{t($ => $.work_sessions.archived)}</span>}
              </Button>)}
        {selected?.parent_session_id == null && selected?.status === "active" && <Button size="sm" variant="ghost"
          className="w-full" disabled={chatArchived} onClick={() => { setParentId(selected.id); setCreateOpen(true); }}>
          {issueT($ => $.detail.session_side_chat)}
        </Button>}
      </div>
      {selected && <WorkSessionView key={selected.id} wsId={wsId} chatId={chatId} session={selected}
        agentId={agentId} agents={agents} disabled={chatArchived || selected.status === "archived"} />}
    </div>
    <NewSessionDialog chatId={chatId} wsId={wsId} sessions={sessions} open={createOpen}
      onOpenChange={setCreateOpen} parentSessionId={parentId} onCreated={setSelectedId} />
  </>;
}

function WorkSessionView({ wsId, chatId, session, agentId, agents, disabled }: {
  wsId: string; chatId: string; session: Session; agentId: string; agents: Agent[]; disabled: boolean;
}) {
  const { t } = useT("chat");
  const { t: issueT } = useT("issues");
  const qc = useQueryClient();
  const tasksQuery = useQuery(chatWorkSessionTasksOptions(wsId, chatId, session.id));
  const tasks = tasksQuery.data ?? [];
  const log = useIssueLog(session.id);
  const createTask = useCreateChatWorkSessionTask(wsId, chatId, session.id);
  const [prompt, setPrompt] = useState("");
  const [selectedAgentId, setSelectedAgentId] = useState(agentId);
  const selectedAgent = agents.find(agent => agent.id === selectedAgentId) ?? agents[0];
  const [taskError, setTaskError] = useState<string | null>(null);
  const [traceTask, setTraceTask] = useState<SessionTask | null>(null);
  const cancelTask = useMutation({
    mutationFn: (taskId: string) => api.cancelTaskById(taskId),
    onSettled: () => qc.invalidateQueries({ queryKey: chatWorkSessionKeys.tasks(wsId, chatId, session.id) }),
  });
  const submit = async () => {
    if (!prompt.trim() || !selectedAgent || createTask.isPending || disabled) return;
    setTaskError(null);
    try {
      await createTask.mutateAsync({ agent_id: selectedAgent.id, prompt: prompt.trim() });
      setPrompt("");
      void log.replica.refreshTailPreservingWindow().catch(() => setTaskError(t($ => $.work_sessions.log_failed)));
    } catch (error) {
      setTaskError(error instanceof Error ? error.message : t($ => $.work_sessions.task_failed));
    }
  };
  const statusLabel = (status: string) => {
    switch (status) {
      case "completed": return issueT($ => $.execution_log.status_completed);
      case "failed": return issueT($ => $.execution_log.status_failed);
      case "cancelled": return issueT($ => $.execution_log.status_cancelled);
      case "queued": return issueT($ => $.execution_log.status_queued);
      case "dispatched": return issueT($ => $.execution_log.status_dispatched);
      case "waiting_local_directory": return issueT($ => $.execution_log.status_waiting_local_directory);
      case "awaiting_human": return issueT($ => $.execution_log.status_awaiting_human);
      case "running": return issueT($ => $.execution_log.status_running);
      default: return t($ => $.work_sessions.unknown_status);
    }
  };

  return <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
    {log.error && !log.snapshot.ready ? <div role="alert">
      <p className="text-sm text-destructive">{t($ => $.work_sessions.log_failed)}</p>
      <Button size="sm" variant="outline" onClick={() => void log.replica.refreshTailPreservingWindow()}>{t($ => $.page.retry)}</Button>
    </div> : <SessionLogList sessionId={session.id} replica={log.replica} className="min-h-28 flex-1"
      transformEntries={entries => entries.filter(entry => {
        const row = entry as SessionLogRow;
        return row.visibility !== "hidden" && !row.deleted_at
          && (!row.metadata?.envelope || typeof row.message_kind === "string")
          && (row.kind === "message" || row.kind === "turn" || row.seq === 0);
      })}
      header={log.replica.window?.has_more_before && <Button size="sm" variant="ghost" onClick={() => void log.replica.earlier()}>
        {t($ => $.message_list.expand_older)}
      </Button>}
      renderEntry={({ entry }) => {
        const row = entry as SessionLogRow;
        const task = tasks.find(task => task.id === row.task_id || task.turn_id === row.task_id || task.turn_id === row.id);
        const hasReplyMessage = typeof row.metadata.final_entry_id === "string" && Boolean(row.metadata.final_entry_id);
        const finalReply = !hasReplyMessage && typeof row.metadata.final_reply_md === "string" ? row.metadata.final_reply_md : undefined;
        return <div className="space-y-1 text-sm">
          {row.kind === "message" && <MessageHeader message={row} getActorName={(type, id) => type === "agent" ? agents.find(agent => agent.id === id)?.name ?? id : id} />}
          {row.kind === "turn" && task && <Button size="sm" variant="ghost" onClick={() => setTraceTask(task)}>
            {agents.find(agent => agent.id === task.agent_id)?.name ?? task.agent_id} · {statusLabel(task.status)} · {t($ => $.work_sessions.trace)}
          </Button>}
          <EntryHtml html={finalReply !== undefined ? null : row.body_html} markdown={finalReply ?? row.body_md}
            fallback={<Markdown>{finalReply ?? row.body_md}</Markdown>} />
        </div>;
      }} />}
    <div className="max-h-36 shrink-0 space-y-1 overflow-y-auto">
      {tasksQuery.isError && <div role="alert" className="text-xs text-destructive">
        {t($ => $.work_sessions.tasks_failed)}
        <Button size="sm" variant="ghost" onClick={() => void tasksQuery.refetch()}>{t($ => $.page.retry)}</Button>
      </div>}
      {tasks.map(task => <div key={task.id} className="flex items-start gap-2 rounded-md bg-muted/40 px-2 py-1 text-xs">
        <div className="min-w-0 flex-1">
          <p className="truncate">{agents.find(agent => agent.id === task.agent_id)?.name ?? task.agent_id} · {statusLabel(task.status)}</p>
          {task.progress_summary && <p className="truncate text-muted-foreground">{task.progress_summary}</p>}
          {task.error && <p className="break-words text-destructive">{task.error}</p>}
        </div>
        <Button size="sm" variant="ghost" onClick={() => setTraceTask(task)}>{t($ => $.work_sessions.trace)}</Button>
        {ACTIVE_STATUSES.has(task.status) && <Button size="sm" variant="ghost" disabled={cancelTask.isPending}
          onClick={() => cancelTask.mutate(task.turn_id ?? task.id, { onError: error => setTaskError(error.message) })}>{t($ => $.input.stop_tooltip)}</Button>}
      </div>)}
    </div>
    {tasks.filter(task => task.status === "awaiting_human").map(task => <HumanRequestDock key={task.id} taskId={task.id} sessionId={session.id} turnId={task.turn_id} />)}
    <div className="shrink-0 space-y-2 border-t pt-2">
      {disabled && <p className="text-xs text-muted-foreground">{t($ => $.work_sessions.archived_hint)}</p>}
      <Label htmlFor={`work-prompt-${session.id}`}>{t($ => $.work_sessions.prompt)}</Label>
      <Textarea id={`work-prompt-${session.id}`} value={prompt} onChange={event => setPrompt(event.target.value)}
        disabled={disabled || createTask.isPending} className="max-h-32 min-h-16" />
      <div className="flex items-center justify-between gap-2">
        <NativeSelect aria-label={t($ => $.work_sessions.agent)} value={selectedAgent?.id ?? ""}
          disabled={disabled || createTask.isPending || agents.length === 0} onChange={event => setSelectedAgentId(event.target.value)}>
          {agents.map(agent => <NativeSelectOption key={agent.id} value={agent.id}>{agent.name}</NativeSelectOption>)}
        </NativeSelect>
        <Button size="sm" disabled={disabled || createTask.isPending || !prompt.trim() || !selectedAgent} onClick={() => void submit()}>
          {t($ => $.work_sessions.run)}
        </Button>
      </div>
      {taskError && <p role="alert" className="text-xs text-destructive">{taskError}</p>}
    </div>
    {traceTask && <TaskTraceDialog task={traceTask} agentName={agents.find(agent => agent.id === traceTask.agent_id)?.name ?? traceTask.agent_id}
      onOpenChange={open => { if (!open) setTraceTask(null); }} />}
  </div>;
}
