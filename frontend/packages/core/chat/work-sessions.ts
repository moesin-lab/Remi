import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { getCurrentWsId } from "../platform/workspace-storage";
import { issueKeys } from "../issues/queries";
import type { CreateSessionRequest, CreateSessionTaskRequest, Session, SessionTask } from "../types";

export const chatWorkSessionKeys = {
  all: (wsId: string) => ["chat-work-sessions", wsId] as const,
  list: (wsId: string, chatId: string) => [...chatWorkSessionKeys.all(wsId), chatId, "sessions"] as const,
  tasks: (wsId: string, chatId: string, sessionId: string) => [...chatWorkSessionKeys.all(wsId), chatId, "tasks", sessionId] as const,
};

export function chatWorkSessionsOptions(wsId: string, chatId: string, enabled = true) {
  return queryOptions({
    queryKey: chatWorkSessionKeys.list(wsId, chatId),
    queryFn: () => api.listChatWorkSessions(chatId),
    enabled: Boolean(wsId && chatId && enabled),
  });
}

export function chatWorkSessionTasksOptions(wsId: string, chatId: string, sessionId: string) {
  return queryOptions({
    queryKey: chatWorkSessionKeys.tasks(wsId, chatId, sessionId),
    queryFn: () => api.listChatWorkSessionTasks(chatId, sessionId),
    enabled: Boolean(wsId && chatId && sessionId),
  });
}

export function useCreateChatWorkSession(chatId: string, wsId = getCurrentWsId() ?? "") {
  const qc = useQueryClient();
  return useMutation({
    onMutate: () => ({ wsId, chatId }),
    mutationFn: (input: CreateSessionRequest) => api.createChatWorkSession(chatId, input),
    onSuccess: (session, _input, { wsId, chatId }) => {
      qc.setQueryData<Session[]>(chatWorkSessionKeys.list(wsId, chatId), (old = []) =>
        old.some(item => item.id === session.id) ? old : [...old, session]);
      if (session.issue_id) {
        qc.setQueryData<Session[]>(issueKeys.sessions(session.issue_id), (old = []) =>
          old.some(item => item.id === session.id) ? old : [...old, session]);
        void qc.invalidateQueries({ queryKey: issueKeys.sessions(session.issue_id) });
      }
    },
    onSettled: (_session, _error, _input, context) => qc.invalidateQueries({
      queryKey: chatWorkSessionKeys.list(context?.wsId ?? wsId, context?.chatId ?? chatId),
    }),
  });
}

export function useCreateChatWorkSessionTask(wsId: string, chatId: string, sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    onMutate: () => ({ wsId, chatId, sessionId }),
    mutationFn: (input: CreateSessionTaskRequest) => api.createChatWorkSessionTask(chatId, sessionId, input),
    onSuccess: (task, _input, { wsId, chatId, sessionId }) => {
      qc.setQueryData<SessionTask[]>(chatWorkSessionKeys.tasks(wsId, chatId, sessionId), (old = []) =>
        old.some(item => item.id === task.id) ? old : [...old, task]);
    },
    onSettled: (_task, _error, _input, context) => qc.invalidateQueries({
      queryKey: chatWorkSessionKeys.tasks(context?.wsId ?? wsId, context?.chatId ?? chatId, context?.sessionId ?? sessionId),
    }),
  });
}
