import type { MultiremiStore } from '@multiremi/store.js';
import type { ClaimTaskOptions } from '@multiremi/store/repos/tasks-repo.js';

export function claimWithCurrentRuntime(store: Pick<MultiremiStore, 'claimTask'>, runtimeId: string, options?: Omit<ClaimTaskOptions, 'supportsPromptPolicy'>) {
  return store.claimTask(runtimeId, { ...options, supportsPromptPolicy: true });
}
