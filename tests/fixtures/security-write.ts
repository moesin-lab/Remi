import type { SecurityLockPlan } from '../../packages/server/src/store/security-write.js';

export const securityWritePlan = {
  expectedRevision: 0,
  workspaceIds: ['workspace-a'],
  numberKeys: ['multiremi:number:workspace-a'],
  domainTargets: ['issue:example'],
} as const satisfies SecurityLockPlan;
