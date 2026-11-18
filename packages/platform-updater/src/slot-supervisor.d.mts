import type { Edge } from '../../edge/src/index.js';
export interface SlotTransition {
  revision: string | null; target: string | null; previous: string | null;
  hasPrevious?: boolean; recovery?: 'rollback-on-restart';
  phase: string; error?: string; updatedAt: number; phases: Array<{ phase: string; updatedAt: number }>;
}
export interface SlotCommand { mode: 'run' | 'stop'; releaseId: string | null; revision: string; strategy?: 'switch' }
export class SlotSupervisor {
  constructor(edge: Edge, launch: (id: string | null) => Promise<{ cwd: string; executable: string; args: string[]; version: string; env: NodeJS.ProcessEnv }>,
    options?: { port?: number; ports?: number[]; standbyWait?: number; releaseWait?: number; activateWait?: number; confirmWait?: number; persist?: (selection: { revision: string | null; releaseId: string | null; transition: SlotTransition }) => Promise<unknown> });
  closing: boolean;
  transition: SlotTransition | null;
  snapshot(): { childPid: number | null; releaseId: string | null; version?: string; revision: string | null; stopped: boolean; slotSwitch: boolean; transition: SlotTransition | null };
  restore(selection: { revision: string | null; releaseId: string | null; transition: SlotTransition } | null): Promise<void>;
  reconcile(desired: SlotCommand | null): Promise<void>;
  cancel(): void;
  stop(): Promise<void>;
}
