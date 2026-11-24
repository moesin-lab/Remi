import type { SqlDatabase } from './db/postgres.js';
import { withSecurityTarget, type SecurityTx } from './security-write.js';
import type { IssuedCredential } from './root-authority-contract.js';
import type { GrantSubject } from './root-grants.js';

export interface MaterialIdentity {
  credentialId: string;
  materialVersion: number;
  materialDigest: string;
  credentialType: string;
  purpose: string;
  subject: GrantSubject;
}

export function persistIssuedMaterialBinding(db: SqlDatabase, tx: SecurityTx, issued: IssuedCredential, identity: MaterialIdentity): void {
  withSecurityTarget(db, tx, `credential:${identity.credentialId}`, () => {
    if (identity.credentialId !== issued.credential.id || identity.materialVersion !== issued.credential.version ||
        identity.subject.type !== issued.subject.type || identity.subject.id !== issued.subject.id || !/^[0-9a-f]{64}$/.test(identity.materialDigest) ||
        !Number.isSafeInteger(issued.expiresAtMs) || issued.expiresAtMs <= Date.now()) throw new Error('credential_version_conflict');
    const actualSubject = identity.credentialType === 'task' ? 'agent' : 'user';
    if (actualSubject !== identity.subject.type || !['task','pat'].includes(identity.credentialType)) throw new Error('credential_version_conflict');
    const result = db.query(`INSERT INTO multiremi_credential_version_bindings(credential_id,material_version,material_digest,credential_type,purpose,
      subject_type,subject_id,family_id,authority_node_id,authority_generation,authority_seq,expires_at_ms)
      SELECT t.id,?,t.token_hash,t.type,t.purpose,n.subject_type,n.subject_id,f.family_id,n.node_id,n.generation,n.issued_seq,?
      FROM multiremi_access_tokens t JOIN multiremi_credential_families f ON f.family_id=? AND f.revoked_at_ms IS NULL AND f.max_expires_at_ms>=?
      JOIN multiremi_authority_nodes n ON n.node_id=? AND n.generation=? AND n.revoked_at_ms IS NULL AND n.expires_at_ms>=?
      JOIN multiremi_authority_edges e ON e.child_id=n.node_id AND e.child_generation=n.generation AND e.child_seq=n.issued_seq
        AND e.parent_id=f.authority_node_id AND e.dependency='continuous'
      WHERE t.id=? AND t.token_hash=? AND t.type=? AND t.purpose=? AND t.revoked_at IS NULL AND t.expires_at=?
        AND n.subject_type=? AND n.subject_id=? AND (CASE WHEN t.type='task' THEN t.agent_id ELSE t.user_id END)=n.subject_id
        AND NOT EXISTS(SELECT 1 FROM multiremi_credential_version_bindings newer WHERE newer.credential_id=t.id AND newer.material_version>=?)
      RETURNING credential_id`).get(identity.materialVersion, issued.expiresAtMs, issued.familyId, issued.expiresAtMs, issued.node.nodeId,
      issued.node.generation, issued.expiresAtMs, identity.credentialId, identity.materialDigest, identity.credentialType, identity.purpose,
      new Date(issued.expiresAtMs).toISOString(), identity.subject.type, identity.subject.id, identity.materialVersion);
    if (!result) throw new Error('credential_version_conflict');
  });
}

export function readCurrentMaterialBinding(db: SqlDatabase, tx: SecurityTx, identity: MaterialIdentity) {
  return withSecurityTarget(db, tx, `credential:${identity.credentialId}`, () => {
    const row = db.query(`SELECT b.family_id,b.authority_node_id,b.authority_generation,b.expires_at_ms,t.expires_at FROM multiremi_credential_version_bindings b
      JOIN multiremi_access_tokens t ON t.id=b.credential_id AND t.token_hash=b.material_digest AND t.type=b.credential_type AND t.purpose=b.purpose
        AND t.revoked_at IS NULL AND (CASE WHEN t.type='task' THEN t.agent_id ELSE t.user_id END)=b.subject_id
      JOIN multiremi_credential_families f ON f.family_id=b.family_id AND f.revoked_at_ms IS NULL AND f.max_expires_at_ms>=b.expires_at_ms
      JOIN multiremi_authority_nodes n ON n.node_id=b.authority_node_id AND n.generation=b.authority_generation AND n.issued_seq=b.authority_seq
        AND n.subject_type=b.subject_type AND n.subject_id=b.subject_id AND n.expires_at_ms>=b.expires_at_ms AND n.revoked_at_ms IS NULL
      JOIN multiremi_authority_edges e ON e.child_id=n.node_id AND e.child_generation=n.generation AND e.child_seq=n.issued_seq
        AND e.parent_id=f.authority_node_id AND e.dependency='continuous'
      WHERE b.credential_id=? AND b.material_version=? AND b.material_digest=? AND b.credential_type=? AND b.purpose=?
        AND b.subject_type=? AND b.subject_id=? AND b.expires_at_ms>? AND NOT EXISTS(SELECT 1 FROM multiremi_credential_version_bindings next
          WHERE next.credential_id=b.credential_id AND next.material_version>b.material_version)`)
      .get(identity.credentialId, identity.materialVersion, identity.materialDigest, identity.credentialType, identity.purpose,
        identity.subject.type, identity.subject.id, Date.now());
    if (!row || Date.parse(row.expires_at) !== Number(row.expires_at_ms)) throw new Error('credential_version_conflict');
    return { familyId: String(row.family_id), node: { nodeId: String(row.authority_node_id), generation: Number(row.authority_generation) },
      expiresAtMs: Number(row.expires_at_ms) };
  });
}
