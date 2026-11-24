import { expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { readCurrentMaterialBinding, type MaterialIdentity } from '@multiremi/store/credential-version-bindings.js';
import { expandCredentialVersionBindings } from '@multiremi/store/root-receipt-schema.js';
import { withSecurityWrite } from '@multiremi/store/security-write.js';
import { pendingTurnBackendTests } from './pending-turn-test-backends.js';

pendingTurnBackendTests('immutable credential version binding', fixture => {
  it('requires the original material, subject, purpose, version and continuous family edge', async () => {
    const { store, db } = fixture();
    db.exec(`CREATE TABLE IF NOT EXISTS multiremi_credential_families(family_id TEXT PRIMARY KEY, authority_node_id TEXT UNIQUE NOT NULL,
      max_expires_at_ms BIGINT NOT NULL, revoked_at_ms BIGINT, revision INTEGER NOT NULL)`);
    expandCredentialVersionBindings(db);
    const token = await store.createAccessToken({ name: 'binding fixture', userId: 'local', type: 'pat', purpose: 'personal', expiresInDays: 1 });
    const expiry = Date.parse(token.expiresAt!);
    const identity: MaterialIdentity = { credentialId: token.id, materialVersion: 1, materialDigest: createHash('sha256').update(token.token).digest('hex'),
      credentialType: 'pat', purpose: 'personal', subject: { type: 'user', id: 'local' } };
    for (const [index, name] of ['family-one','family-two','material'].entries()) {
      db.run(`INSERT INTO multiremi_authority_nodes(node_id,issued_seq,generation,kind,subject_type,subject_id,scope,revision,expires_at_ms,continuous_parent_count)
        VALUES(?,?,1,?,'user','local','fixture',0,?,?)`, [name,index+1,index===2?'credential':'credential_family',expiry,index===2?1:0]);
      if (index < 2) db.run(`INSERT INTO multiremi_credential_families(family_id,authority_node_id,max_expires_at_ms,revision) VALUES(?,?,?,0)`, [name,name,expiry]);
    }
    db.run(`INSERT INTO multiremi_authority_edges(child_id,child_generation,child_seq,parent_id,parent_generation,parent_seq,dependency)
      VALUES('material',1,3,'family-one',1,1,'continuous')`);
    db.run(`INSERT INTO multiremi_credential_version_bindings(credential_id,material_version,material_digest,credential_type,purpose,subject_type,
      subject_id,family_id,authority_node_id,authority_generation,authority_seq,expires_at_ms) VALUES(?,1,?,'pat','personal','user','local','family-one','material',1,3,?)`,
      [token.id, identity.materialDigest, expiry]);
    const read = (input: MaterialIdentity) => withSecurityWrite(db, undefined, { expectedRevision: 0, workspaceIds: ['local'], numberKeys: [],
      domainTargets: [`credential:${token.id}`] }, tx => readCurrentMaterialBinding(db, tx, input));
    expect(read(identity).familyId).toBe('family-one');
    for (const other of [{ ...identity, materialVersion: 2 }, { ...identity, purpose: 'session' }, { ...identity, materialDigest: '0'.repeat(64) },
      { ...identity, subject: { type: 'user' as const, id: 'another' } }]) expect(() => read(other)).toThrow('credential_version_conflict');
    db.run("UPDATE multiremi_credential_version_bindings SET family_id='family-two' WHERE credential_id=?", [token.id]);
    expect(() => read(identity)).toThrow('credential_version_conflict');
    db.run("UPDATE multiremi_credential_version_bindings SET family_id='family-one' WHERE credential_id=?", [token.id]);
    db.run('UPDATE multiremi_access_tokens SET token_hash=? WHERE id=?', ['0'.repeat(64), token.id]);
    expect(() => read(identity)).toThrow('credential_version_conflict');
    expect(() => read({ ...identity, materialDigest: '0'.repeat(64) })).toThrow('credential_version_conflict');
  });
});
