import type { SqlDatabase } from './db/postgres.js';
import { SecurityAbort, withSecurityTarget, type SecurityTx } from './security-write.js';

export interface GrantSubject {
  readonly type: 'user' | 'agent';
  readonly id: string;
}

export interface RecordedGrant {
  readonly grantId: string;
  readonly generation: number;
  readonly authorityNodeId: string;
}

export function readRecordedGrant(db: SqlDatabase, tx: SecurityTx, subject: GrantSubject): RecordedGrant | null {
  return withSecurityTarget(db, tx, `grant:${subject.type}:${subject.id}`, () => {
    try {
      const row = db.query(`SELECT grants.grant_id, grants.generation, grants.authority_node_id
        FROM multiremi_root_subject_state state JOIN multiremi_root_grants grants
        ON grants.grant_id = state.active_grant_id AND grants.generation = state.generation_counter
        AND grants.subject_type = state.subject_type AND grants.subject_id = state.subject_id
        WHERE state.subject_type = ? AND state.subject_id = ? AND grants.revoked_at_ms IS NULL
        AND (grants.expires_at_ms IS NULL OR grants.expires_at_ms > ?)`)
        .get(subject.type, subject.id, Date.now());
      return row ? { grantId: row.grant_id, generation: Number(row.generation), authorityNodeId: row.authority_node_id } : null;
    } catch {
      throw new SecurityAbort('security_state_unavailable');
    }
  });
}
