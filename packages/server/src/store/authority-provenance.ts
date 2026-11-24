import type { SqlDatabase, SqlStatement } from './db/postgres.js';
import { SecurityAbort, withSecurityTarget, type SecurityTx } from './security-write.js';

export interface AuthorityNodeRef {
  readonly nodeId: string;
  readonly generation: number;
}

interface Ancestor {
  sequence: number;
  generation: number;
  height: number;
}

const maxDepth = 32;
const maxNodes = 1024;

export function assertUnrevokedAncestry(db: SqlDatabase, tx: SecurityTx, ref: AuthorityNodeRef): void {
  withSecurityTarget(db, tx, `authority:${ref.nodeId}`, () => checkAncestry(db, ref));
}

export function grantAncestryIsCurrent(db: SqlDatabase, tx: SecurityTx, targetId: string, ref: AuthorityNodeRef, type: 'user' | 'runtime' = 'user'): boolean {
  return withSecurityTarget(db, tx, `management:${type}:${targetId}`, () => {
    try { checkAncestry(db, ref); return true; } catch (error) {
      if (error instanceof SecurityAbort && error.code === 'root_authority_revoked') return false;
      throw error;
    }
  });
}

function checkAncestry(db: SqlDatabase, ref: AuthorityNodeRef): void {
    const completed = new Map<string, Ancestor>();
    let remaining = maxNodes;
    let earliestExpiry = Infinity;
    let node: SqlStatement;
    let edges: SqlStatement;

    function visit(id: string, generation: number, depth: number, expectedSeq?: number): number {
      if (depth > maxDepth) throw new SecurityAbort('authority_depth_exceeded');
      const cached = completed.get(id);
      if (cached) {
        if (cached.generation !== generation || cached.sequence !== expectedSeq) throw new SecurityAbort('root_authority_revoked');
        if (depth + cached.height - 1 > maxDepth) throw new SecurityAbort('authority_depth_exceeded');
        return cached.height;
      }
      if (--remaining < 0) throw new SecurityAbort('authority_depth_exceeded');
      const row = node.get(id);
      if (!row || row.revoked_at_ms !== null || Number(row.generation) !== generation) throw new SecurityAbort('root_authority_revoked');
      const sequence = Number(row.issued_seq);
      const expiry = Number(row.expires_at_ms);
      if (!Number.isSafeInteger(sequence) || sequence < 1 || (expectedSeq !== undefined && sequence !== expectedSeq)
        || !Number.isSafeInteger(expiry) || expiry <= 0) throw new SecurityAbort('root_authority_revoked');
      earliestExpiry = Math.min(earliestExpiry, expiry);
      const parents = edges.all(id, generation, sequence);
      if (parents.length > maxNodes) throw new SecurityAbort('authority_depth_exceeded');
      if (parents.length !== Number(row.continuous_parent_count)) throw new SecurityAbort('root_authority_revoked');
      let height = 1;
      for (const parent of parents) {
        const parentSeq = Number(parent.parent_seq);
        if (!Number.isSafeInteger(parentSeq) || parentSeq >= sequence) throw new SecurityAbort('root_authority_revoked');
        height = Math.max(height, 1 + visit(parent.parent_id, Number(parent.parent_generation), depth + 1, parentSeq));
      }
      completed.set(id, { sequence, generation, height });
      return height;
    }

    try {
      node = db.query(`SELECT issued_seq, generation, expires_at_ms, revoked_at_ms, continuous_parent_count
        FROM multiremi_authority_nodes WHERE node_id = ?`);
      edges = db.query(`SELECT parent_id, parent_generation, parent_seq FROM multiremi_authority_edges
        WHERE child_id = ? AND child_generation = ? AND child_seq = ? AND dependency = 'continuous' LIMIT ${maxNodes + 1}`);
      visit(ref.nodeId, ref.generation, 1);
    } catch (error) {
      if (error instanceof SecurityAbort) throw error;
      throw new SecurityAbort('security_state_unavailable');
    }
    if (earliestExpiry <= Date.now()) throw new SecurityAbort('root_authority_revoked');
}
