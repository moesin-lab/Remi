import { expect,test } from 'bun:test';
import { createHash } from 'node:crypto';
import { runMigrations } from '@multiremi/store/migrations.js';
import { openSqliteDatabase } from '@multiremi/store/db/sqlite.js';
import type { SqlDatabase } from '@multiremi/store/db/postgres.js';
import { RegisteredCredentialProofs } from '@multiremi/store/registered-credential-proof.js';
import { withSecurityWrite } from '@multiremi/store/security-write.js';

test('registered PAT proves only its current material and true human origin', () => {
  const sqlite = openSqliteDatabase();
  try {
    const db = sqlite as unknown as SqlDatabase;
    runMigrations(db);
    const raw = 'synthetic-fixture-pat';
    const digest = createHash('sha256').update(raw).digest('hex');
    const expiry = Date.now()+600_000;
    db.run("INSERT INTO multiremi_users(id,name,email,created_at,updated_at) VALUES('usr_fixture','fixture','fixture@example.invalid','now','now')");
    db.query(`INSERT INTO multiremi_access_tokens(id,name,user_id,type,purpose,token_prefix,token_hash,expires_at,created_at)
      VALUES('token','fixture','usr_fixture','pat','personal','fixture',?,?,'now')`).run(digest,new Date(expiry).toISOString());
    const proofs = new RegisteredCredentialProofs(db);
    expect(proofs.verify(raw).kind).toBe('invalid');
    expect(proofs.verify(null).kind).toBe('absent');
    for (const [index,kind] of ['independent_identity','credential_family','credential'].entries()) {
      db.query(`INSERT INTO multiremi_authority_nodes VALUES(?,?,1,?,'user','usr_fixture','fixture',0,?,NULL,?)`).run(kind,index+1,kind,expiry,index===0?0:1);
    }
    db.run("INSERT INTO multiremi_authority_edges VALUES('credential_family',1,2,'independent_identity',1,1,'continuous')");
    db.run("INSERT INTO multiremi_authority_edges VALUES('credential',1,3,'credential_family',1,2,'continuous')");
    db.query("INSERT INTO multiremi_credential_families VALUES('family','credential_family',?,NULL,0)").run(expiry);
    db.query(`INSERT INTO multiremi_credential_version_bindings(credential_id,material_version,material_digest,credential_type,purpose,subject_type,subject_id,
      family_id,authority_node_id,authority_generation,authority_seq,expires_at_ms) VALUES('token',1,?,'pat','personal','user','usr_fixture','family','credential',1,3,?)`).run(digest,expiry);
    const proof = proofs.verify(raw);
    expect(proof.kind).toBe('dependent');
    const check = () => withSecurityWrite(db,undefined,proofs.plan(proof),tx=>proofs.requireCurrent(tx,proof));
    expect(check()).toMatchObject({subject:{type:'user',id:'usr_fixture'},type:'pat',purpose:'personal',attemptId:null,credential:{id:'token',version:1},familyId:'family'});
    db.run("UPDATE multiremi_authority_nodes SET subject_type='agent' WHERE kind='independent_identity'");
    expect(proofs.verify(raw).kind).toBe('invalid');
    db.run("UPDATE multiremi_authority_nodes SET subject_type='user',revoked_at_ms=1 WHERE kind='independent_identity'");
    expect(check).toThrow('root_authority_revoked');
    expect(proofs.verify(raw).kind).toBe('invalid');
  } finally { sqlite.close(); }
});
