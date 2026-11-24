import { createHash } from 'node:crypto';
import { assertUnrevokedAncestry } from './authority-provenance.js';
import { readCurrentMaterialBinding, type MaterialIdentity } from './credential-version-bindings.js';
import type { SqlDatabase } from './db/postgres.js';
import type { CredentialOrigin, CredentialProof } from './root-authority-contract.js';
import { SecurityAbort, withSecurityTarget, withSecurityWrite, type SecurityTx } from './security-write.js';

interface Evidence {
  identity: MaterialIdentity;
  nodeId: string;
  attemptId: string | null;
}

export interface CurrentMaterial extends CredentialOrigin {
  readonly subject: MaterialIdentity['subject'];
  readonly type: 'task' | 'pat';
  readonly purpose: string;
  readonly attemptId: string | null;
  readonly expiresAtMs: number;
}

export class RegisteredCredentialProofs {
  private readonly proofs = new WeakMap<CredentialProof, Evidence>();

  constructor(private readonly db: SqlDatabase) {}

  verify(raw: string | null): CredentialProof {
    if (raw === null) return {kind:'absent'};
    if (!raw) return {kind:'invalid'};
    const materialDigest = createHash('sha256').update(raw).digest('hex');
    try {
      const row = this.db.query(`SELECT b.*,t.task_id FROM multiremi_access_tokens t JOIN multiremi_credential_version_bindings b
        ON b.credential_id=t.id AND b.material_digest=t.token_hash WHERE t.token_hash=? AND t.revoked_at IS NULL
        ORDER BY b.material_version DESC LIMIT 1`).get(materialDigest);
      if (!row) return {kind:'invalid'};
      const evidence: Evidence = {nodeId:row.authority_node_id, attemptId:row.task_id,
        identity:{credentialId:row.credential_id, materialVersion:Number(row.material_version), materialDigest, credentialType:row.credential_type,
          purpose:row.purpose, subject:{type:row.subject_type,id:row.subject_id}}};
      const proof = Object.freeze({kind:'dependent',proofVersion:Object.freeze({id:row.credential_id,version:Number(row.material_version)})}) as CredentialProof;
      this.proofs.set(proof,evidence);
      withSecurityWrite(this.db,undefined,this.plan(proof),tx=>this.requireCurrent(tx,proof));
      return proof;
    } catch (error) {
      if (error instanceof SecurityAbort && ['root_authority_revoked','credential_version_conflict','authority_depth_exceeded'].includes(error.code)) return {kind:'invalid'};
      if (error instanceof SecurityAbort) throw error;
      throw new SecurityAbort('security_state_unavailable');
    }
  }

  plan(proof: CredentialProof) {
    const evidence = this.proofs.get(proof);
    if (!evidence) throw new SecurityAbort('root_authority_revoked');
    const row = this.db.query('SELECT security_revision FROM multiremi_security_state WHERE singleton=1').get();
    if (!row) throw new SecurityAbort('security_state_unavailable');
    return {expectedRevision:Number(row.security_revision),workspaceIds:[],numberKeys:[],domainTargets:
      [`authority:${evidence.nodeId}`,`credential:${evidence.identity.credentialId}`,`grant:${evidence.identity.subject.type}:${evidence.identity.subject.id}`].sort()};
  }

  requireCurrent(tx: SecurityTx, proof: CredentialProof): CurrentMaterial {
    const evidence = this.proofs.get(proof);
    if (!evidence) throw new SecurityAbort('root_authority_revoked');
    const identity = evidence.identity;
    return withSecurityTarget(this.db,tx,`credential:${identity.credentialId}`,()=>{
      let binding: ReturnType<typeof readCurrentMaterialBinding>;
      try { binding = readCurrentMaterialBinding(this.db,tx,identity); } catch (error) {
        if (error instanceof Error && error.message==='credential_version_conflict') throw new SecurityAbort('credential_version_conflict');
        if (error instanceof SecurityAbort) throw error;
        throw new SecurityAbort('security_state_unavailable');
      }
      if (binding.node.nodeId!==evidence.nodeId) throw new SecurityAbort('credential_version_conflict');
      assertUnrevokedAncestry(this.db,tx,binding.node);
      if (identity.credentialType==='task' && identity.subject.type==='agent' && identity.purpose==='task') {
        const active = this.db.query(`SELECT a.id FROM multiremi_turn_attempts a JOIN multiremi_turns t ON t.id=a.turn_id AND t.current_attempt_id=a.id
          JOIN multiremi_access_tokens c ON c.task_id=a.id AND c.agent_id=t.agent_id AND c.workspace_id=t.workspace_id
          JOIN multiremi_turn_execution_records execution ON execution.id=a.id
          WHERE a.id=? AND c.id=? AND t.agent_id=? AND a.status IN ('accepted','running')
          AND execution.status IN ('dispatched','running','awaiting_human')`).get(evidence.attemptId,identity.credentialId,identity.subject.id);
        if (!active) throw new SecurityAbort('root_authority_revoked');
      } else if (identity.credentialType==='pat' && identity.subject.type==='user' && identity.subject.id.startsWith('usr_') && evidence.attemptId===null) {
        const human = this.db.query(`SELECT u.id FROM multiremi_users u JOIN multiremi_access_tokens t ON t.user_id=u.id
          WHERE u.id=? AND t.id=? AND t.type='pat' AND t.purpose IN ('personal','session','cli')
          AND t.task_id IS NULL AND t.agent_id IS NULL AND t.daemon_id IS NULL`).get(identity.subject.id,identity.credentialId);
        if (!human) throw new SecurityAbort('root_authority_revoked');
        const origin = this.db.query(`WITH RECURSIVE sources(id) AS (SELECT node_id FROM multiremi_authority_nodes WHERE node_id=?
          UNION SELECT e.parent_id FROM multiremi_authority_edges e JOIN sources s ON s.id=e.child_id WHERE e.dependency='continuous')
          SELECT n.subject_type,n.subject_id,n.kind FROM sources s JOIN multiremi_authority_nodes n ON n.node_id=s.id`).all(binding.node.nodeId);
        if (origin.some(node=>node.subject_type==='agent') || !origin.some(node=>node.subject_type==='user' && node.subject_id===identity.subject.id
          && node.kind==='independent_identity')) throw new SecurityAbort('root_authority_revoked');
      } else throw new SecurityAbort('root_authority_revoked');
      return {subject:{...identity.subject},type:identity.credentialType,purpose:identity.purpose,attemptId:evidence.attemptId,
        credential:{id:identity.credentialId,version:identity.materialVersion},...binding};
    });
  }
}
