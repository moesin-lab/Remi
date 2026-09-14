import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { SaveBotInput } from "./types";
import { botKeys } from "./queries";

// Only server responses enter the query cache: mutation inputs can carry secrets.
export function useCreateBot(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [...botKeys.all(workspaceId), "create"],
    mutationFn: (input: SaveBotInput) => api.createBot({ ...input, workspace_id: workspaceId }),
    onSuccess: (bot) => {
      queryClient.setQueryData(botKeys.detail(workspaceId, bot.id), bot);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: botKeys.list(workspaceId) }),
  });
}

export function useUpdateBot(workspaceId: string, botId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // A different route scope detaches the observer from an in-flight save;
    // its completion must retain the original workspace and Bot callbacks.
    mutationKey: [...botKeys.bot(workspaceId, botId), "update"],
    mutationFn: (input: SaveBotInput) => api.updateBot(botId, { ...input, workspace_id: workspaceId }),
    onSuccess: (bot) => {
      queryClient.setQueryData(botKeys.detail(workspaceId, botId), bot);
    },
    onSettled: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: botKeys.list(workspaceId) }),
      queryClient.invalidateQueries({ queryKey: botKeys.bot(workspaceId, botId) }),
    ]),
  });
}

export function useDeleteBot(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [...botKeys.all(workspaceId), "delete"],
    mutationFn: (botId: string) => api.deleteBot(workspaceId, botId),
    onSuccess: async (_result, botId) => {
      await queryClient.cancelQueries({ queryKey: botKeys.bot(workspaceId, botId) });
      queryClient.removeQueries({ queryKey: botKeys.bot(workspaceId, botId) });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: botKeys.list(workspaceId) }),
  });
}

export function useUpdateBotSender(workspaceId: string, botId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [...botKeys.bot(workspaceId, botId), "update-sender"],
    mutationFn: ({ senderId, allowed }: { senderId: string; allowed: boolean }) =>
      api.updateBotSender(workspaceId, botId, senderId, allowed),
    onSettled: () => queryClient.invalidateQueries({ queryKey: botKeys.senders(workspaceId, botId) }),
  });
}
