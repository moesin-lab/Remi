import type { AuthorityNodeRef } from '../../packages/server/src/store/authority-provenance.js';
import type { SecurityLockPlan } from '../../packages/server/src/store/security-write.js';

export const recordedAuthority = { nodeId: 'fixture-credential', generation: 1 } as const satisfies AuthorityNodeRef;
export const provenanceReadPlan = {
  expectedRevision: 0, workspaceIds: [], numberKeys: [], domainTargets: [`authority:${recordedAuthority.nodeId}`],
} as const satisfies SecurityLockPlan;
