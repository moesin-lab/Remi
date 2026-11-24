import { expect, test } from 'bun:test';
import type { SqlDatabase } from '@multiremi/store/db/postgres.js';
import { openSqliteDatabase } from '@multiremi/store/db/sqlite.js';
import { expandSecurityState } from '@multiremi/store/security-state-schema.js';
import { expandAuthorityProvenance } from '@multiremi/store/authority-provenance-schema.js';
import { expandRootGrants } from '@multiremi/store/root-grant-schema.js';
import { readRecordedGrant } from '@multiremi/store/root-grants.js';
import { withSecurityWrite } from '@multiremi/store/security-write.js';

test('reads only the recorded subject generation and filters expired or revoked records', () => {
  const sqlite = openSqliteDatabase();
  try {
    const db = sqlite as unknown as SqlDatabase;
    db.exec('PRAGMA foreign_keys=ON');
    expandSecurityState(db);
    expandAuthorityProvenance(db);
    expandRootGrants(db);
    const subject = { type: 'user', id: 'fixture' } as const;
    const plan = { expectedRevision: 0, workspaceIds: [], numberKeys: [], domainTargets: ['grant:user:fixture'] };
    const read = () => withSecurityWrite(db, undefined, plan, tx => readRecordedGrant(db, tx, subject));
    expect(read()).toBeNull();
    db.run(`INSERT INTO multiremi_authority_nodes VALUES ('node',1,1,'grant','user','fixture','system',1,9999999999999,NULL,0)`);
    db.run(`INSERT INTO multiremi_root_grants(grant_id,subject_type,subject_id,generation,scope,authority_node_id,
      issuer_type,issuer_id,revision,reason,created_at_ms) VALUES('grant','user','fixture',1,'system','node','deployment','fixture-host',1,'test',1)`);
    expect(read()).toBeNull();
    const activate = db.query('INSERT INTO multiremi_root_subject_state VALUES(?,?,?,?)');
    expect(() => activate.run('agent', 'fixture', 1, 'grant')).toThrow();
    expect(() => activate.run('user', 'fixture', 2, 'grant')).toThrow();
    activate.run('user', 'fixture', 1, 'grant');
    expect(read()).toEqual({ grantId: 'grant', generation: 1, authorityNodeId: 'node' });
    db.run('UPDATE multiremi_root_grants SET expires_at_ms=2');
    expect(read()).toBeNull();
    db.run("UPDATE multiremi_root_grants SET expires_at_ms=NULL, revoked_at_ms=2, revoke_reason='test'");
    expect(read()).toBeNull();
  } finally {
    sqlite.close();
  }
});
