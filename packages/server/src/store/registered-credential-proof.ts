import { createHash } from 'node:crypto';
import { serializeRootDeliveryTuple } from '../worker/root-delivery-envelope.js';
import { assertUnrevokedAncestry } from './authority-provenance.js';
import { JwtMaterials, type JwtSigningDomain } from './jwt-materials.js';
import { approvedAttemptSources } from './task-authority.js';
import { readCurrentMaterialBinding, type MaterialIdentity } from './credential-version-bindings.js';
import type { SqlDatabase } from './db/postgres.js';
import type { CredentialOrigin, CredentialProof } from './root-authority-contract.js';
import { abortSecurityWrite, SecurityAbort, withSecurityTarget, withSecurityWrite, type SecurityTx } from './security-write.js';

interface Evidence {
  identity: MaterialIdentity;
  nodeId: string;
  attemptId: string | null;
  receipt?: { binding: string; lease: string; fence: string };
}

export interface CurrentMaterial extends CredentialOrigin {
  readonly subject: MaterialIdentity['subject'];
  readonly type: 'task' | 'pat' | 'jwt';
  readonly purpose: string;
  readonly attemptId: string | null;
  readonly expiresAtMs: number;
}

export class RegisteredCredentialProofs {
  private readonly proofs = new WeakMap<CredentialProof, Evidence>();
  private readonly jwtProofs = new WeakMap<CredentialProof, { digest: string; signing: JwtSigningDomain; subjectId: string;
    locator: { credential_id: string; authority_node_id: string } }>();

  constructor(private readonly db: SqlDatabase) {}

  verifyJwt(raw: string, signing: JwtSigningDomain): CredentialProof {
    const identity = new JwtMaterials(this.db).validate(raw, signing);
    if (!identity) return {kind:'invalid'};
    const material = this.db.query('SELECT credential_id,material_version,authority_node_id FROM multiremi_jwt_materials WHERE compact_digest=?').get(identity.digest);
    if (!material) return {kind:'invalid'};
    const proof = Object.freeze({kind:'dependent', proofVersion:Object.freeze({id:material.credential_id,version:Number(material.material_version)})}) as CredentialProof;
    this.jwtProofs.set(proof, {digest:identity.digest, signing:{...signing}, subjectId:identity.userId,
      locator:{credential_id:material.credential_id,authority_node_id:material.authority_node_id}});
    return proof;
  }

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
    const jwt = this.jwtProofs.get(proof);
    if (!jwt && !evidence) throw new SecurityAbort('root_authority_revoked');
    const row = this.db.query('SELECT security_revision FROM multiremi_security_state WHERE singleton=1').get();
    if (!row) throw new SecurityAbort('security_state_unavailable');
    const subject = jwt ? {type:'user',id:jwt.subjectId} : evidence!.identity.subject;
    const targets = jwt ? [`authority:${jwt.locator.authority_node_id}`, `jwt:${jwt.locator.credential_id}`]
      : [`authority:${evidence!.nodeId}`,`credential:${evidence!.identity.credentialId}`];
    targets.push(`grant:${subject.type}:${subject.id}`);
    const grant = this.db.query(`SELECT g.authority_node_id FROM multiremi_root_subject_state s JOIN multiremi_root_grants g
      ON g.grant_id=s.active_grant_id WHERE s.subject_type=? AND s.subject_id=?`).get(subject.type, subject.id);
    if (grant) targets.push(`authority:${grant.authority_node_id}`);
    let fenceTerm: string|undefined;
    if (evidence?.attemptId) {
      targets.push(`attempt:${evidence.attemptId}`);
      const entry = this.db.query('SELECT runtime_id,manifest_json FROM multiremi_attempt_eligibility WHERE attempt_id=?').get(evidence.attemptId);
      if (entry?.runtime_id) targets.push(`management:runtime:${entry.runtime_id}`);
      if (entry?.manifest_json) {
        const approval = approvedAttemptSources(this.db,JSON.parse(entry.manifest_json));
        for (const source of approval?.sources ?? []) targets.push(`authority:${source.id}`);
        const lease = this.db.query('SELECT fence_term FROM multiremi_current_task_leases WHERE attempt_id=?').get(evidence.attemptId);
        if (lease) fenceTerm=String(lease.fence_term);
      }
    }
    return {fenceTerm,expectedRevision:Number(row.security_revision),workspaceIds:[],numberKeys:[],domainTargets:[...new Set(targets)].sort()};
  }

  requireCurrent(tx: SecurityTx, proof: CredentialProof): CurrentMaterial {
    const jwt = this.jwtProofs.get(proof);
    if (jwt) {
      const current = new JwtMaterials(this.db).currentInTransaction(tx,jwt.digest,jwt.signing,jwt.locator);
      if (!current || current.userId!==jwt.subjectId) return abortSecurityWrite(this.db,tx,'root_authority_revoked');
      return {subject:{type:'user',id:jwt.subjectId}, type:'jwt', purpose:'dashboard', attemptId:null,
        credential:current.credential,familyId:current.familyId,node:current.node, expiresAtMs:current.expiresAtMs};
    }
    const evidence = this.proofs.get(proof);
    if (!evidence) return abortSecurityWrite(this.db,tx,'root_authority_revoked');
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
        const active = this.db.query(`SELECT receipt.binding_json,receipt.lease_id,receipt.fence_term,receipt.receipt_id,receipt.receipt_version,
          receipt.handoff_id,receipt.consumer_id,receipt.delivery_version,receipt.run_generation,receipt.run_state,receipt.start_deadline,a.runtime_id
          FROM multiremi_turn_attempts a JOIN multiremi_turns t ON t.id=a.turn_id AND t.current_attempt_id=a.id
          JOIN multiremi_access_tokens c ON c.task_id=a.id AND c.agent_id=t.agent_id AND c.workspace_id=t.workspace_id
          JOIN multiremi_turn_execution_records execution ON execution.id=a.id
          JOIN multiremi_credential_version_bindings version ON version.credential_id=c.id AND version.material_version=?
          JOIN multiremi_credential_materials material ON material.credential_id=c.id AND material.material_version=version.material_version
            AND material.authority_node_id=version.authority_node_id AND material.authority_generation=version.authority_generation
            AND material.authority_seq=version.authority_seq AND material.family_id=version.family_id AND material.expires_at_ms=version.expires_at_ms
          JOIN multiremi_delivery_receipts receipt ON receipt.attempt_id=a.id AND receipt.credential_id=c.id AND receipt.material_version=material.material_version
          JOIN multiremi_usage_task_scopes scope ON scope.task_id=a.id AND scope.workspace_id=t.workspace_id AND scope.agent_id=t.agent_id
            AND scope.runtime_id=a.runtime_id AND scope.active_run_id=receipt.consumer_id
          JOIN multiremi_usage_runs run ON run.task_id=a.id AND run.run_id=scope.active_run_id AND run.complete=0
          WHERE a.id=? AND c.id=? AND t.agent_id=? AND receipt.lease_id<>'' AND receipt.fence_term<>''
            AND ((a.status='accepted' AND execution.status='dispatched' AND receipt.run_state='pending_start')
              OR (a.status='running' AND execution.status='running' AND receipt.run_state='running' AND receipt.ack_state='confirmed'))
            AND NOT EXISTS(SELECT 1 FROM multiremi_delivery_receipts newer WHERE newer.attempt_id=a.id AND newer.run_generation>receipt.run_generation)`)
          .get(identity.materialVersion,evidence.attemptId,identity.credentialId,identity.subject.id);
        if (!active) throw new SecurityAbort('root_authority_revoked');
        try {
          const tuple = JSON.parse(active.binding_json);
          if (serializeRootDeliveryTuple(tuple)!==active.binding_json || tuple.attempt_id!==evidence.attemptId || tuple.runtime_id!==active.runtime_id ||
              tuple.handoff_id!==active.handoff_id || tuple.receipt_id!==active.receipt_id || tuple.consumer_id!==active.consumer_id ||
              tuple.run_generation!==Number(active.run_generation) || tuple.delivery_version!==Number(active.delivery_version) ||
              tuple.receipt_version!==Number(active.receipt_version) || tuple.material_version!==identity.materialVersion ||
              Date.parse(tuple.material_expires_at)!==binding.expiresAtMs ||
              (active.run_state==='pending_start' && !(Date.parse(active.start_deadline)>Date.now()))) throw new Error();
        } catch { throw new SecurityAbort('root_authority_revoked'); }
        if (evidence.receipt && (evidence.receipt.binding!==active.binding_json || evidence.receipt.lease!==active.lease_id ||
            evidence.receipt.fence!==active.fence_term)) throw new SecurityAbort('root_authority_revoked');
        evidence.receipt ??= {binding:active.binding_json,lease:active.lease_id,fence:active.fence_term};
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
