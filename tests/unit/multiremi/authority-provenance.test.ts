import { afterEach, beforeEach, expect, it } from 'bun:test';
import type { SqlDatabase } from '@multiremi/store/db/postgres.js';
import { openSqliteDatabase } from '@multiremi/store/db/sqlite.js';
import { assertUnrevokedAncestry } from '@multiremi/store/authority-provenance.js';
import { expandAuthorityProvenance } from '@multiremi/store/authority-provenance-schema.js';
import { expandSecurityState } from '@multiremi/store/security-state-schema.js';
import { withSecurityWrite } from '@multiremi/store/security-write.js';
import { provenanceReadPlan, recordedAuthority } from '../../fixtures/authority-provenance.js';

let sqlite: ReturnType<typeof openSqliteDatabase>;
let db: SqlDatabase;
beforeEach(() => {
  sqlite = openSqliteDatabase();
  db = sqlite as unknown as SqlDatabase;
  db.exec('PRAGMA foreign_keys=ON');
  expandSecurityState(db);
  expandAuthorityProvenance(db);
});
afterEach(() => sqlite.close());

function node(id: string, sequence: number, parentCount: number, generation = 1): void {
  db.query(`INSERT INTO multiremi_authority_nodes(node_id,issued_seq,generation,kind,subject_type,subject_id,
    scope,revision,expires_at_ms,continuous_parent_count) VALUES(?,?,?,'fixture','agent','subject','fixture',0,?,?)`)
    .run(id, sequence, generation, Date.now() + 60_000, parentCount);
}
function edge(child: string, parent: string, dependency = 'continuous'): void {
  db.query(`INSERT INTO multiremi_authority_edges SELECT c.node_id,c.generation,c.issued_seq,p.node_id,p.generation,p.issued_seq,?
    FROM multiremi_authority_nodes c CROSS JOIN multiremi_authority_nodes p WHERE c.node_id=? AND p.node_id=?`).run(dependency, child, parent);
}
function check(): void {
  withSecurityWrite(db, undefined, provenanceReadPlan, tx => assertUnrevokedAncestry(db, tx, recordedAuthority));
}

it('checks both branches of a diamond and never replaces a revoked generation with a fresh node', () => {
  node('origin', 1, 0); node('left', 2, 1); node('right', 3, 1); node(recordedAuthority.nodeId, 4, 2);
  edge('left', 'origin'); edge('right', 'origin'); edge(recordedAuthority.nodeId, 'left'); edge(recordedAuthority.nodeId, 'right');
  expect(check).not.toThrow();
  db.run("UPDATE multiremi_authority_nodes SET revoked_at_ms=1 WHERE node_id='right'");
  node('replacement', 5, 0, 2);
  expect(check).toThrow('root_authority_revoked');
});

it('rejects missing, expired and mismatched records and missing continuous edges', () => {
  expect(check).toThrow('root_authority_revoked');
  node('parent', 1, 0); node(recordedAuthority.nodeId, 2, 1);
  expect(check).toThrow('root_authority_revoked');
  edge(recordedAuthority.nodeId, 'parent');
  expect(() => withSecurityWrite(db, undefined, provenanceReadPlan, tx =>
    assertUnrevokedAncestry(db, tx, {...recordedAuthority, generation: 2}))).toThrow('root_authority_revoked');
  db.run("UPDATE multiremi_authority_nodes SET expires_at_ms=1 WHERE node_id='parent'");
  expect(check).toThrow('root_authority_revoked');
});

it('keeps issuance evidence separate from continuous dependencies and rejects backward edges', () => {
  node('evidence', 1, 0); node(recordedAuthority.nodeId, 2, 0);
  edge(recordedAuthority.nodeId, 'evidence', 'evidence');
  db.run("UPDATE multiremi_authority_nodes SET revoked_at_ms=1 WHERE node_id='evidence'");
  expect(check).not.toThrow();
  expect(() => edge('evidence', recordedAuthority.nodeId)).toThrow();
});

it('rejects a long second path to an already visited ancestor', () => {
  for (let index = 1; index <= 32; index++) {
    const id = `node-${index}`;
    node(id, index, index === 1 ? 0 : 1);
    if (index > 1) edge(id, `node-${index - 1}`);
  }
  node(recordedAuthority.nodeId, 33, 2);
  edge(recordedAuthority.nodeId, 'node-2'); edge(recordedAuthority.nodeId, 'node-32');
  expect(check).toThrow('authority_depth_exceeded');
});

it('turns database failure into a typed abort and rolls back even when caught', () => {
  db.exec('DROP TABLE multiremi_authority_edges');
  expect(() => withSecurityWrite(db, undefined, provenanceReadPlan, tx => {
    db.run('UPDATE multiremi_security_state SET security_revision=5');
    try { assertUnrevokedAncestry(db, tx, recordedAuthority); } catch { return; }
  })).toThrow('security_state_unavailable');
  expect(db.query('SELECT security_revision FROM multiremi_security_state').get()?.security_revision).toBe(0);
});
