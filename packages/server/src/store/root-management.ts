import { createHash, randomUUID } from 'node:crypto';
import { ROOT_SECURITY_REVOKE_REASONS, type RevokeCredentialFamilyRequest, type RevokeCredentialFamilyResponse,
  type RevokeRootGrantRequest, type RevokeRootGrantResponse, type CreateRootGrantRequest, type CreateRootGrantResponse } from '@multiremi/contracts/root-authority.js';
import type { SqlDatabase } from './db/postgres.js';
import type { GrantRootRuntimeTrustRequest, GrantRootRuntimeTrustResponse, RevokeRootRuntimeTrustRequest, RevokeRootRuntimeTrustResponse, RootRuntimeTrustRecord } from '@multiremi/contracts/root-authority.js';
import { readVerifiedTrustChallenge, recordedMachineBindingIsCurrent } from './machine-proof.js';
import { assertUnrevokedAncestry, grantAncestryIsCurrent } from './authority-provenance.js';
import type { AuthorityKernel, AuthorityUse, CredentialProof, CurrentAuthority } from './root-authority-contract.js';
import { readRecordedGrant } from './root-grants.js';
import { RegisteredCredentialProofs } from './registered-credential-proof.js';
import { abortSecurityWrite, SecurityAbort, withSecurityTarget, withSecurityWrite, type SecurityTx } from './security-write.js';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const grantAction = 'root.grant.revoke';
const familyAction = 'root.credential-family.revoke';
const createAction = 'root.grant.create';
const trustAction = 'root.runtime-trust.grant';
const untrustAction = 'root.runtime-trust.revoke';
type Actor = ReturnType<AuthorityKernel['authorizeWrite']>;
type Invocation = Parameters<AuthorityKernel['admitAttempt']>[2];
interface RetryTarget { turnId: string; previousAttemptId: string; attemptId: string }
interface RetryOrigin extends RetryTarget {
  action: 'turn.retry';
  workspaceId: string; sessionId: string; sessionOwnerType: 'chat' | 'issue'; sessionOwnerId: string; executionScope: string; agentId: string;
  actorId: string; passwordNodeId: string; passwordVersion: number; grantId: string; grantGeneration: number;
}
type Response = RevokeRootGrantResponse | RevokeCredentialFamilyResponse;
interface PasswordEvidence { userId: string; verifier: string; version: number; node: string; deadline: number }

interface HumanBootstrapInput {
  deploymentId: string;
  authorization: string;
  userId: string;
  reason: string;
  expectedRevision: number;
  dashboardSigningDomain?: Readonly<{ domainId: string; keyEpoch: string; keyDigest: string }>;
}

export function bootstrapAuthorizationDigest(input: HumanBootstrapInput): string {
  const signing = input.dashboardSigningDomain;
  if (!signing) return digest(input.authorization);
  if (![signing.domainId, signing.keyEpoch].every(value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value))
    || typeof signing.keyDigest !== 'string' || !/^[0-9a-f]{64}$/.test(signing.keyDigest)) {
    throw new RootManagementRequestError(400, 'Invalid signing domain commitment');
  }
  return 'dashboard-v1:' + digest(JSON.stringify([input.deploymentId,input.userId,input.reason,input.expectedRevision,
    signing.domainId,signing.keyEpoch,signing.keyDigest,input.authorization]));
}

export interface IndependentDashboardIssuance {
  readonly subjectType: 'user'; readonly subjectId: string; readonly purpose: 'dashboard';
  readonly credentialId: string; readonly materialVersion: 1; readonly expectedVersion: 0;
  readonly familyId: string; readonly nodeId: string; readonly generation: 1;
}

export class RootManagementRequestError extends Error {
  constructor(readonly status: 400 | 404, message: string) { super(message); }
}

function onPrimary<T>(readOrWrite: () => T): T {
  try { return readOrWrite(); } catch (error) {
    if (error instanceof SecurityAbort || error instanceof RootManagementRequestError) throw error;
    throw new SecurityAbort('security_state_unavailable');
  }
}

export class RootManagement {
  private readonly proofs = new WeakMap<CredentialProof, PasswordEvidence>();
  private readonly actors = new WeakMap<Actor, { tx: SecurityTx; proof: CredentialProof; action: string; target: string }>();
  private readonly dashboardCandidates = new WeakMap<CredentialProof, IndependentDashboardIssuance>();
  private readonly directRetries = new WeakMap<Invocation,{tx:SecurityTx;proof:CredentialProof;origin:Readonly<RetryOrigin>}>();

  readonly registeredCredentials: RegisteredCredentialProofs;

  constructor(private readonly db: SqlDatabase) {
    this.registeredCredentials = new RegisteredCredentialProofs(db);
  }

  private passwordRow(userId: string, writing = false) {
    const lock = writing && this.db.dialect === 'postgres' ? ' FOR SHARE OF p,u' : '';
    return this.db.query(`SELECT p.password_hash FROM multiremi_password_credentials p
      JOIN multiremi_users u ON u.id=p.user_id WHERE p.user_id=?${lock}`).get(userId);
  }

  private versionRow(userId: string, verifier: string) {
    return this.db.query(`SELECT v.version,v.password_node_id,v.identity_node_id FROM multiremi_password_authority_versions v
      JOIN multiremi_authority_nodes p ON p.node_id=v.password_node_id AND p.kind='password' AND p.subject_type='user'
        AND p.subject_id=v.user_id AND p.generation=v.version AND p.continuous_parent_count=1
      JOIN multiremi_authority_edges e ON e.child_id=p.node_id AND e.parent_id=v.identity_node_id AND e.dependency='continuous'
      JOIN multiremi_authority_nodes i ON i.node_id=e.parent_id AND i.kind='independent_identity' AND i.subject_type='user'
        AND i.subject_id=v.user_id AND i.continuous_parent_count=0
      WHERE v.user_id=? AND v.verifier_digest=? AND v.version=(SELECT MAX(newest.version)
        FROM multiremi_password_authority_versions newest WHERE newest.user_id=v.user_id)`).get(userId, verifier);
  }

  async verifyIndependentPassword(userId: string, password: string): Promise<CredentialProof> {
    if (!userId.startsWith('usr_') || !password || password.length > 1024) return { kind: 'invalid' };
    const row = onPrimary(() => this.passwordRow(userId));
    if (!row) return { kind: 'invalid' };
    let matches: boolean;
    try { matches = await Bun.password.verify(password, row.password_hash); } catch { return { kind: 'invalid' }; }
    if (!matches) return { kind: 'invalid' };
    const verifier = digest(row.password_hash);
    const source = onPrimary(() => this.versionRow(userId, verifier));
    if (!source || onPrimary(() => this.passwordRow(userId))?.password_hash !== row.password_hash) return { kind: 'invalid' };
    const proof = Object.freeze({ kind: 'independent', proofVersion: Object.freeze({ id: source.password_node_id,
      version: Number(source.version) }) }) as CredentialProof;
    const evidence = { userId, verifier, version: Number(source.version), node: source.password_node_id, deadline: Date.now() + 60_000 };
    const state = onPrimary(() => this.db.query('SELECT security_revision FROM multiremi_security_state WHERE singleton=1').get());
    if (!state) throw new SecurityAbort('security_state_unavailable');
    try {
      onPrimary(() => withSecurityWrite(this.db, undefined, { expectedRevision: Number(state.security_revision), workspaceIds: [],
        numberKeys: [], domainTargets: [`authority:${evidence.node}`] }, tx => this.checkPassword(tx, evidence)));
    } catch (error) {
      if (error instanceof SecurityAbort && error.code === 'root_authority_revoked') return { kind: 'invalid' };
      throw error;
    }
    this.proofs.set(proof, evidence);
    return proof;
  }

  private evidence(proof: CredentialProof) {
    const evidence = this.proofs.get(proof);
    if (!evidence || Date.now() >= evidence.deadline) throw new SecurityAbort('root_authority_revoked');
    return evidence;
  }

  plan(proof: CredentialProof, request: AuthorityUse) {
    if (proof.kind==='dependent') {
      const plan = onPrimary(() => this.registeredCredentials.plan(proof));
      return {...plan,domainTargets:[...plan.domainTargets,`management:${request.actualTarget.type}:${request.actualTarget.id}`].sort()};
    }
    const evidence = this.evidence(proof);
    const state = onPrimary(() => this.db.query('SELECT security_revision FROM multiremi_security_state WHERE singleton=1').get());
    if (!state) throw new SecurityAbort('security_state_unavailable');
    const grant = onPrimary(() => this.db.query(`SELECT g.authority_node_id FROM multiremi_root_subject_state s JOIN multiremi_root_grants g
      ON g.grant_id=s.active_grant_id WHERE s.subject_type='user' AND s.subject_id=?`).get(evidence.userId));
    const targets = [`authority:${evidence.node}`, `grant:user:${evidence.userId}`, `management:${request.actualTarget.type}:${request.actualTarget.id}`];
    if (grant) targets.push(`authority:${grant.authority_node_id}`);
    if (request.action === trustAction) {
      const machine = this.db.query('SELECT authority_node_id FROM multiremi_machine_enrollments WHERE runtime_id=? AND retired_at_ms IS NULL').get(request.actualTarget.id);
      if (machine) targets.push(`authority:${machine.authority_node_id}`);
    }
    return { expectedRevision: Number(state.security_revision), workspaceIds: [], numberKeys: [], domainTargets: [...new Set(targets)].sort() };
  }

  private checkPassword(tx: SecurityTx, evidence: PasswordEvidence): void {
    const row = this.passwordRow(evidence.userId, true);
    if (!row || digest(row.password_hash) !== evidence.verifier) throw new SecurityAbort('credential_version_conflict');
    const source = this.versionRow(evidence.userId, evidence.verifier);
    if (!source || source.password_node_id !== evidence.node || Number(source.version) !== evidence.version) throw new SecurityAbort('credential_version_conflict');
    assertUnrevokedAncestry(this.db, tx, { nodeId: evidence.node, generation: evidence.version });
  }

  private check(tx: SecurityTx, proof: CredentialProof, request: AuthorityUse, directRetry = false): CurrentAuthority {
    const target = request.actualTarget;
    const retry = directRetry && request.action === 'turn.retry' && request.use === 'invocation' && target.type === 'turn';
    if (!target.id || !(retry || request.use === 'management' && (request.action === grantAction && target.type === 'grant'
      || request.action === createAction && target.type === 'user'
      || request.action === trustAction && target.type === 'runtime' || request.action === untrustAction && target.type === 'runtime_trust'
      || request.action === familyAction && target.type === 'credential_family'))) throw new SecurityAbort('root_required');
    const state = this.db.query('SELECT feature_activation,security_revision FROM multiremi_security_state WHERE singleton=1').get();
    if (!state) throw new SecurityAbort('security_state_unavailable');
    const active = Number(state.feature_activation) === 1;
    if (proof.kind==='dependent') {
      const material = this.registeredCredentials.requireCurrent(tx,proof);
      const recordedGrant = readRecordedGrant(this.db,tx,material.subject);
      return {transport:material.type==='task'?'task':'human',subject:material.subject,attemptId:material.attemptId,recordedGrant,
        credentialOrigin:{credential:material.credential,familyId:material.familyId,node:material.node},effectiveRoot:false,scope:null,
        reason:!active?'feature_disabled':!recordedGrant?'no_grant':material.type==='task'?'attempt_not_eligible':'unverified_human_auth',
        checkedRevision:Number(state.security_revision)};
    }
    const evidence = this.evidence(proof);
    this.checkPassword(tx, evidence);
    const subject = { type: 'user', id: evidence.userId } as const;
    const grant = readRecordedGrant(this.db, tx, subject);
    if (active && grant) {
      const node = this.db.query(`SELECT node_id FROM multiremi_authority_nodes WHERE node_id=? AND generation=? AND kind='grant'
        AND scope='system' AND subject_type='user' AND subject_id=?`).get(grant.authorityNodeId, grant.generation, subject.id);
      if (!node) throw new SecurityAbort('root_authority_revoked');
      assertUnrevokedAncestry(this.db, tx, { nodeId: grant.authorityNodeId, generation: grant.generation });
      const exists = retry ? this.db.query('SELECT id FROM multiremi_turns WHERE id=?').get(target.id)
        : request.action === trustAction ? this.db.query('SELECT id FROM multiremi_runtimes WHERE id=?').get(target.id)
        : request.action === untrustAction ? this.db.query('SELECT trust_id FROM multiremi_runtime_trusts WHERE trust_id=?').get(target.id)
        : request.action === createAction ? this.db.query('SELECT id FROM multiremi_users WHERE id=?').get(target.id) : request.action === grantAction
        ? this.db.query('SELECT grant_id FROM multiremi_root_grants WHERE grant_id=?').get(target.id)
        : this.db.query('SELECT family_id FROM multiremi_credential_families WHERE family_id=?').get(target.id);
      if (!exists) throw new RootManagementRequestError(404, 'Management target not found');
    }
    return { transport: 'human', subject, credentialOrigin: null, attemptId: null, recordedGrant: grant,
      scope: active && grant ? 'system' : null, effectiveRoot: active && !!grant,
      reason: !active ? 'feature_disabled' : grant ? 'active' : 'no_grant', checkedRevision: Number(state.security_revision) };
  }

  resolveCurrent(proof: CredentialProof, request: AuthorityUse): CurrentAuthority {
    return onPrimary(() => withSecurityWrite(this.db, undefined, this.plan(proof, request), tx => this.check(tx, proof, request)));
  }

  authorizeWrite(tx: SecurityTx, proof: CredentialProof, request: AuthorityUse): Actor {
    return withSecurityTarget(this.db, tx, `management:${request.actualTarget.type}:${request.actualTarget.id}`, () => {
      const authority = onPrimary(() => this.check(tx, proof, request));
      if (!authority.effectiveRoot) throw new SecurityAbort('root_required');
      const actor = Object.freeze(authority) as Actor;
      this.actors.set(actor, { tx, proof, action: request.action, target: request.actualTarget.id });
      return actor;
    });
  }

  private retryOrigin(tx: SecurityTx, proof: CredentialProof, target: RetryTarget): Readonly<RetryOrigin> {
    return withSecurityTarget(this.db,tx,`management:turn:${target.turnId}`,()=>onPrimary(()=>{
      const actor = this.check(tx,proof,{action:'turn.retry',use:'invocation',actualTarget:{type:'turn',id:target.turnId}},true);
      if (!actor.effectiveRoot || !actor.subject || !actor.recordedGrant) throw new SecurityAbort('root_required');
      const source = this.evidence(proof);
      if (!this.db.query(`UPDATE multiremi_turns SET current_attempt_id=current_attempt_id WHERE id=? AND current_attempt_id=? RETURNING id`)
        .get(target.turnId,target.previousAttemptId)) throw new SecurityAbort('authority_revision_conflict');
      const row = this.db.query(`SELECT t.workspace_id,t.session_id,t.execution_scope,t.agent_id,s.issue_id,s.chat_id
        FROM multiremi_turns t JOIN multiremi_turn_attempts a ON a.id=t.current_attempt_id AND a.turn_id=t.id
        JOIN multiremi_agents g ON g.id=t.agent_id AND g.workspace_id=t.workspace_id AND g.archived_at IS NULL
        JOIN multiremi_issue_sessions s ON s.id=t.session_id AND s.workspace_id=t.workspace_id AND s.status='active'
        LEFT JOIN multiremi_issues issue ON issue.id=s.issue_id AND issue.workspace_id=t.workspace_id AND issue.archived_at IS NULL
        LEFT JOIN multiremi_chat_sessions chat ON chat.id=s.chat_id AND chat.workspace_id=t.workspace_id
        WHERE t.id=? AND a.id=? AND a.status IN ('lost','failed') AND t.status NOT IN ('completed','cancelled')
          AND ((s.chat_id IS NULL AND issue.id IS NOT NULL) OR (s.chat_id IS NOT NULL AND chat.id IS NOT NULL))
          AND NOT EXISTS(SELECT 1 FROM multiremi_turn_attempts WHERE id=?)`).get(target.turnId,target.previousAttemptId,target.attemptId);
      if (!row || !target.attemptId) throw new SecurityAbort('authority_revision_conflict');
      return Object.freeze({action:'turn.retry',turnId:target.turnId,previousAttemptId:target.previousAttemptId,attemptId:target.attemptId,
        workspaceId:String(row.workspace_id),sessionId:String(row.session_id),sessionOwnerType:row.chat_id?'chat':'issue',sessionOwnerId:String(row.chat_id??row.issue_id),
        executionScope:String(row.execution_scope),agentId:String(row.agent_id),actorId:actor.subject.id,passwordNodeId:source.node,
        passwordVersion:source.version,grantId:actor.recordedGrant.grantId,grantGeneration:actor.recordedGrant.generation});
    }));
  }

  planDirectRetry(proof: CredentialProof, target: RetryTarget) {
    const plan = this.plan(proof,{action:'turn.retry',use:'invocation',actualTarget:{type:'turn',id:target.turnId}});
    const turn = onPrimary(()=>this.db.query('SELECT workspace_id FROM multiremi_turns WHERE id=?').get(target.turnId));
    if (!turn) throw new RootManagementRequestError(404,'Turn not found');
    return {...plan,workspaceIds:[String(turn.workspace_id)],domainTargets:[...plan.domainTargets,`attempt:${target.attemptId}`].sort()};
  }

  verifyDirectRetryInvocation(tx: SecurityTx, proof: CredentialProof, target: RetryTarget): Invocation {
    return withSecurityTarget(this.db,tx,`attempt:${target.attemptId}`,()=>{
      const origin = this.retryOrigin(tx,proof,target);
      const invocation = Object.freeze({}) as Invocation;
      this.directRetries.set(invocation,{tx,proof,origin});
      return invocation;
    });
  }

  requireDirectRetryInvocation(tx: SecurityTx, invocation: Invocation, target: RetryTarget): Readonly<RetryOrigin> {
    return withSecurityTarget(this.db,tx,`attempt:${target.attemptId}`,()=>{
      const verified = this.directRetries.get(invocation);
      if (!verified || verified.tx!==tx) throw new SecurityAbort('root_authority_revoked');
      const current = this.retryOrigin(tx,verified.proof,target);
      if (JSON.stringify(current)!==JSON.stringify(verified.origin)) throw new SecurityAbort('authority_revision_conflict');
      return current;
    });
  }

  revokeGrant(tx: SecurityTx, actor: Parameters<AuthorityKernel['revokeGrant']>[1], targetId: string, input: RevokeRootGrantRequest): RevokeRootGrantResponse {
    return onPrimary(() => this.revoke(tx, actor, targetId, grantAction, input)) as RevokeRootGrantResponse;
  }

  bootstrapHuman(proof: CredentialProof, input: HumanBootstrapInput): CreateRootGrantResponse {
    const { deploymentId, authorization, userId, reason, expectedRevision } = input;
    const evidence = this.evidence(proof);
    if (userId !== evidence.userId || !reason.trim() || !deploymentId || !authorization) throw new SecurityAbort('root_required');
    const use = { action: createAction, actualTarget: { type: 'user', id: userId }, use: 'management' };
    return onPrimary(() => withSecurityWrite(this.db, undefined, { ...this.plan(proof, use), expectedRevision }, tx => {
      this.checkPassword(tx, this.evidence(proof));
      const now = Date.now();
      const ticket = bootstrapAuthorizationDigest(input);
      if (!this.db.query(`UPDATE multiremi_root_bootstrap_authorizations SET consumed_at_ms=? WHERE authorization_digest=?
        AND deployment_id=? AND user_id=? AND reason=? AND expires_at_ms>? AND consumed_at_ms IS NULL RETURNING deployment_id`)
        .get(now, ticket, deploymentId, userId, reason, now)) throw new SecurityAbort('root_required');
      if (!this.db.query(`UPDATE multiremi_security_state SET bootstrap_completed=1 WHERE singleton=1 AND bootstrap_completed=0
        AND feature_activation=0 AND NOT EXISTS (SELECT 1 FROM multiremi_root_grants) RETURNING singleton`).get()) throw new SecurityAbort('authority_revision_conflict');
      const origin = this.newNode('deployment_origin', 'deployment', deploymentId, 1, expectedRevision+1, null, []);
      const result = this.insertHumanGrant(tx, userId, reason, null, expectedRevision, { type: 'deployment', id: deploymentId }, [origin]);
      const signing = input.dashboardSigningDomain;
      if (signing) {
        if (!this.db.query(`INSERT INTO multiremi_jwt_signing_domains(domain_id,key_epoch,key_digest) VALUES(?,?,?)
          ON CONFLICT(domain_id) DO NOTHING RETURNING domain_id`).get(signing.domainId,signing.keyEpoch,signing.keyDigest)) {
          throw new SecurityAbort('credential_version_conflict');
        }
        this.db.query(`INSERT INTO multiremi_root_management_events(actor_user_id,proof_node_id,actor_grant_id,actor_generation,
          action,target_id,idempotency_key,payload_digest,reason,revision_before,revision_after,created_at_ms,result_json)
          VALUES(?,?,?,?,'bootstrap.jwt-domain.register',?,?,?,?,?,?,?,?)`).run(userId,evidence.node,result.grant.id,result.grant.generation,
          signing.domainId,signing.keyEpoch,digest(JSON.stringify([signing.domainId,signing.keyEpoch,signing.keyDigest])),reason,
          expectedRevision,result.security_revision,now,JSON.stringify({domainId:signing.domainId,keyEpoch:signing.keyEpoch}));
      }
      this.db.query(`UPDATE multiremi_root_bootstrap_authorizations SET grant_id=?,proof_node_id=?,revision_before=?,revision_after=?
        WHERE authorization_digest=?`).run(result.grant.id, evidence.node, expectedRevision, result.security_revision, ticket);
      return { ...result, grant: { ...result.grant, effective: false, effective_reason_code: 'feature_disabled' } };
    }));
  }

  private newNode(kind: string, subjectType: string, subjectId: string, generation: number, revision: number, expiry: number | null,
    parents: string[], id: string = randomUUID(), scope = 'system') {
    this.db.query(`INSERT INTO multiremi_authority_nodes(node_id,issued_seq,generation,kind,subject_type,subject_id,scope,revision,expires_at_ms,continuous_parent_count)
      SELECT ?,COALESCE(MAX(issued_seq),0)+1,?,?,?,?,?,?,?,? FROM multiremi_authority_nodes`)
      .run(id, generation, kind, subjectType, subjectId, scope, revision, expiry ?? Number.MAX_SAFE_INTEGER, parents.length);
    for (const parent of parents) {
      if (!this.db.query(`INSERT INTO multiremi_authority_edges SELECT c.node_id,c.generation,c.issued_seq,p.node_id,p.generation,p.issued_seq,'continuous'
        FROM multiremi_authority_nodes c CROSS JOIN multiremi_authority_nodes p WHERE c.node_id=? AND p.node_id=? RETURNING child_id`).get(id, parent)) {
        throw new SecurityAbort('root_authority_revoked');
      }
    }
    return id;
  }

  issueIndependentDashboardSession(proof: CredentialProof, expiresAtMs: number,
    signAndRegister: (tx: SecurityTx, source: IndependentDashboardIssuance, claims: { exp: number }) => string): string {
    const evidence = this.evidence(proof);
    let candidate = this.dashboardCandidates.get(proof);
    if (!candidate) {
      candidate = Object.freeze({ subjectType: 'user', subjectId: evidence.userId, purpose: 'dashboard', credentialId: randomUUID(),
        materialVersion: 1, expectedVersion: 0, familyId: randomUUID(), nodeId: randomUUID(), generation: 1 });
      this.dashboardCandidates.set(proof,candidate);
    }
    const source = candidate;
    const state = onPrimary(() => this.db.query('SELECT security_revision FROM multiremi_security_state WHERE singleton=1').get());
    if (!state) throw new SecurityAbort('security_state_unavailable');
    const before = Number(state.security_revision);
    const targets = [`authority:${evidence.node}`,`authority:${source.nodeId}`,`jwt:${source.credentialId}`,`family:${source.familyId}`].sort();
    return onPrimary(() => withSecurityWrite(this.db,undefined,{ expectedRevision:before,workspaceIds:[],numberKeys:[],domainTargets:targets },tx => {
      this.checkPassword(tx,this.evidence(proof));
      const active = this.db.query('SELECT feature_activation FROM multiremi_security_state WHERE singleton=1').get();
      if (Number(active?.feature_activation)!==1) throw new SecurityAbort('root_required');
      const now = Date.now();
      const ceiling = this.db.query(`SELECT MIN(n.expires_at_ms) AS ceiling FROM multiremi_authority_nodes n JOIN multiremi_password_authority_versions p
        ON n.node_id IN (p.identity_node_id,p.password_node_id) WHERE p.user_id=? AND p.version=?`).get(evidence.userId,evidence.version);
      if (!Number.isSafeInteger(expiresAtMs/1000) || expiresAtMs<=now || expiresAtMs>Math.min(Number(ceiling?.ceiling),now+30*24*60*60_000)) {
        throw new RootManagementRequestError(400,'Invalid dashboard session lifetime');
      }
      if (this.db.query('SELECT credential_id FROM multiremi_jwt_current WHERE credential_id=?').get(source.credentialId)) throw new SecurityAbort('credential_version_conflict');
      const revision = before+1;
      const familyNode = this.newNode('credential_family','user',source.subjectId,1,revision,expiresAtMs,[evidence.node],randomUUID(),'dashboard');
      this.db.query(`INSERT INTO multiremi_credential_families(family_id,authority_node_id,max_expires_at_ms,revision) VALUES(?,?,?,?)`)
        .run(source.familyId,familyNode,expiresAtMs,revision);
      this.newNode('jwt_material','user',source.subjectId,1,revision,expiresAtMs,[familyNode],source.nodeId,'dashboard');
      const compact = signAndRegister(tx,source,{exp:expiresAtMs/1000});
      const registered = this.db.query(`SELECT m.claims_json,m.key_epoch,m.domain_id FROM multiremi_jwt_materials m JOIN multiremi_jwt_current c
        ON c.credential_id=m.credential_id AND c.current_material_version=m.material_version WHERE m.compact_digest=? AND m.credential_id=?
        AND m.material_version=1 AND m.revoked_at_ms IS NULL AND m.subject_type='user' AND m.subject_id=? AND m.purpose='dashboard'
        AND m.authority_node_id=? AND m.authority_generation=1 AND m.family_id=? AND m.expires_at_ms=?`)
        .get(digest(compact),source.credentialId,source.subjectId,source.nodeId,source.familyId,expiresAtMs);
      if (!registered) throw new SecurityAbort('credential_version_conflict');
      const claims = JSON.parse(registered.claims_json);
      const allowedClaims = ['sub','jti','exp','purpose','material_version','key_epoch','signing_domain'];
      if (Object.keys(claims).some(key => !allowedClaims.includes(key)) || claims.jti!==source.credentialId || claims.sub!==source.subjectId
        || claims.exp!==expiresAtMs/1000 || claims.purpose!=='dashboard' || claims.material_version!==source.materialVersion
        || claims.key_epoch!==registered.key_epoch || claims.signing_domain!==registered.domain_id) {
        throw new SecurityAbort('credential_version_conflict');
      }
      this.checkPassword(tx,this.evidence(proof));
      if (!this.db.query('UPDATE multiremi_security_state SET security_revision=? WHERE singleton=1 AND security_revision=? RETURNING singleton')
        .get(revision,before)) throw new SecurityAbort('authority_revision_conflict');
      return compact;
    }));
  }

  private insertHumanGrant(tx: SecurityTx, userId: string, reason: string, expiry: number | null, before: number,
    issuer: { type: 'deployment' | 'user'; id: string }, parents: string[]): CreateRootGrantResponse {
    const state = this.db.query("SELECT generation_counter,active_grant_id FROM multiremi_root_subject_state WHERE subject_type='user' AND subject_id=?").get(userId);
    const generation = Number(state?.generation_counter ?? 0)+1;
    const revision = before+1;
    const now = Date.now();
    if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(revision)) throw new SecurityAbort('authority_revision_conflict');
    const previousId = state?.active_grant_id ?? null;
    if (previousId !== null) {
      const prior = this.db.query(`SELECT g.authority_node_id,g.revoked_at_ms,g.expires_at_ms FROM multiremi_root_grants g
        JOIN multiremi_authority_nodes n ON n.node_id=g.authority_node_id AND n.generation=g.generation AND n.kind='grant'
          AND n.subject_type=g.subject_type AND n.subject_id=g.subject_id AND n.scope=g.scope
        WHERE g.grant_id=? AND g.subject_type='user' AND g.subject_id=? AND g.generation=?`).get(previousId,userId,generation-1);
      if (!prior) throw new SecurityAbort('security_state_unavailable');
      if (prior.revoked_at_ms===null && (prior.expires_at_ms===null || Number(prior.expires_at_ms)>now)
        && grantAncestryIsCurrent(this.db,tx,userId,{nodeId:prior.authority_node_id,generation:generation-1})) {
        throw new SecurityAbort('authority_revision_conflict');
      }
      this.db.query(`UPDATE multiremi_authority_nodes SET revoked_at_ms=?,revision=? WHERE node_id=? AND generation=? AND revoked_at_ms IS NULL`)
        .run(now,revision,prior.authority_node_id,generation-1);
    }
    const node = this.newNode('grant', 'user', userId, generation, revision, expiry, parents);
    if (!grantAncestryIsCurrent(this.db, tx, userId, { nodeId: node, generation })) throw new SecurityAbort('root_authority_revoked');
    const id = randomUUID();
    this.db.query(`INSERT INTO multiremi_root_grants(grant_id,subject_type,subject_id,generation,scope,authority_node_id,issuer_type,issuer_id,revision,reason,created_at_ms,expires_at_ms)
      VALUES(?,'user',?,?,'system',?,?,?,?,?,?,?)`).run(id,userId,generation,node,issuer.type,issuer.id,revision,reason,now,expiry);
    if (!this.db.query(`INSERT INTO multiremi_root_subject_state(subject_type,subject_id,generation_counter,active_grant_id) VALUES('user',?,?,?)
      ON CONFLICT(subject_type,subject_id) DO UPDATE SET generation_counter=excluded.generation_counter,active_grant_id=excluded.active_grant_id
      WHERE multiremi_root_subject_state.active_grant_id IS NOT DISTINCT FROM ? AND multiremi_root_subject_state.generation_counter=? RETURNING generation_counter`)
      .get(userId,generation,id,previousId,generation-1)) throw new SecurityAbort('authority_revision_conflict');
    if (!this.db.query('UPDATE multiremi_security_state SET security_revision=? WHERE singleton=1 AND security_revision=? RETURNING singleton')
      .get(revision,before)) throw new SecurityAbort('authority_revision_conflict');
    return { security_revision: revision, grant: { id, subject: { type: 'user', id: userId }, scope: 'system', generation, status: 'active', effective: true,
      effective_reason_code: 'active', authority_node_id: node, issuer, origin_attempt_id: null, origin_family_id: null, reason, revocation_reason: null,
      created_at: new Date(now).toISOString(), expires_at: expiry === null ? null : new Date(expiry).toISOString(), revoked_at: null, revision } };
  }

  grant(tx: SecurityTx, actor: Parameters<AuthorityKernel['grant']>[1], input: CreateRootGrantRequest): CreateRootGrantResponse {
    const target = input.subject;
    if (target.type !== 'user' || !target.id.startsWith('usr_')) return abortSecurityWrite(this.db,tx,'root_required');
    return withSecurityTarget(this.db, tx, `management:user:${target.id}`, () => onPrimary(() => {
      const bound = this.actors.get(actor as Actor);
      if (!bound || bound.tx !== tx || bound.target !== target.id || bound.action !== createAction) throw new SecurityAbort('root_required');
      const current = this.check(tx, bound.proof, { action: createAction, actualTarget: target, use: 'management' });
      if (!current.effectiveRoot || !current.recordedGrant || !current.subject) throw new SecurityAbort('root_required');
      const previous = actor as Actor;
      if (previous.checkedRevision !== current.checkedRevision || previous.recordedGrant?.grantId !== current.recordedGrant.grantId) throw new SecurityAbort('authority_revision_conflict');
      if (!input.reason?.trim() || !input.idempotency_key?.trim() || !Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0
        || input.runtime_trust_ids?.length || input.accepted_dependency_digest != null) throw new RootManagementRequestError(400, 'Invalid human grant request');
      const expiry = input.expires_at == null ? null : Date.parse(input.expires_at);
      if (expiry !== null && !Number.isSafeInteger(expiry)) throw new RootManagementRequestError(400, 'Invalid expiry');
      const key = [current.subject.id,createAction,target.id,input.idempotency_key];
      const payload = digest(JSON.stringify([input.expected_revision,input.reason,expiry]));
      const prior = this.db.query(`SELECT result_json,payload_digest FROM multiremi_root_management_events
        WHERE actor_user_id=? AND action=? AND target_id=? AND idempotency_key=?`).get(...key);
      if (prior) {
        if (prior.payload_digest !== payload) throw new SecurityAbort('authority_revision_conflict');
        const result: CreateRootGrantResponse = JSON.parse(prior.result_json);
        const record = this.db.query(`SELECT g.revoked_at_ms,g.revoke_reason,g.revision,s.active_grant_id FROM multiremi_root_grants g
          JOIN multiremi_root_subject_state s ON s.subject_type=g.subject_type AND s.subject_id=g.subject_id WHERE g.grant_id=?`).get(result.grant.id);
        if (!record) throw new SecurityAbort('security_state_unavailable');
        const revoked = record.revoked_at_ms !== null;
        const expired = expiry !== null && expiry <= Date.now();
        const effective = !revoked && !expired && record.active_grant_id === result.grant.id && grantAncestryIsCurrent(this.db,tx,target.id,
          { nodeId: result.grant.authority_node_id, generation: result.grant.generation });
        return { security_revision: current.checkedRevision, replayed: true, grant: { ...result.grant, effective, revision: Number(record.revision),
          revoked_at: revoked ? new Date(Number(record.revoked_at_ms)).toISOString() : null, revocation_reason: record.revoke_reason,
          status: revoked ? 'revoked' : expired ? 'expired' : 'active', effective_reason_code: revoked ? 'grant_revoked' : expired ? 'grant_expired' : effective ? 'active' : 'ancestor_revoked' } };
      }
      if (current.checkedRevision !== input.expected_revision) throw new SecurityAbort('authority_revision_conflict');
      if (expiry !== null && expiry <= Date.now()) throw new RootManagementRequestError(400, 'Invalid expiry');
      const targetPassword = this.passwordRow(target.id, true);
      const targetProof = targetPassword && this.versionRow(target.id, digest(targetPassword.password_hash));
      if (!targetProof || !grantAncestryIsCurrent(this.db, tx, target.id, { nodeId: targetProof.password_node_id,
        generation: Number(targetProof.version) })) throw new SecurityAbort('root_required');
      const evidence = this.evidence(bound.proof);
      const result = this.insertHumanGrant(tx,target.id,input.reason,expiry,current.checkedRevision,{ type: 'user', id: current.subject.id },
        [current.recordedGrant.authorityNodeId,evidence.node]);
      this.db.query(`INSERT INTO multiremi_root_management_events(actor_user_id,action,target_id,idempotency_key,payload_digest,proof_node_id,actor_grant_id,
        actor_generation,reason,revision_before,revision_after,created_at_ms,result_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(...key,payload,evidence.node,current.recordedGrant.grantId,current.recordedGrant.generation,input.reason,current.checkedRevision,result.security_revision,Date.now(),JSON.stringify(result));
      return result;
    }));
  }

  revokeFamily(tx: SecurityTx, actor: Parameters<AuthorityKernel['revokeFamily']>[1], targetId: string, input: RevokeCredentialFamilyRequest): RevokeCredentialFamilyResponse {
    return onPrimary(() => this.revoke(tx, actor, targetId, familyAction, input)) as RevokeCredentialFamilyResponse;
  }

  grantRuntimeTrust(tx: SecurityTx, actor: Parameters<AuthorityKernel['grantRuntimeTrust']>[1], input: GrantRootRuntimeTrustRequest): GrantRootRuntimeTrustResponse {
    return this.changeTrust(tx,actor,input.runtime_id,{ grant: input });
  }

  revokeRuntimeTrust(tx: SecurityTx, actor: Parameters<AuthorityKernel['revokeRuntimeTrust']>[1], trustId: string, input: RevokeRootRuntimeTrustRequest): RevokeRootRuntimeTrustResponse {
    return this.changeTrust(tx,actor,trustId,{ revoke: input }) as RevokeRootRuntimeTrustResponse;
  }

  private changeTrust(tx: SecurityTx, actor: Parameters<AuthorityKernel['grantRuntimeTrust']>[1], targetId: string,
    change: { grant: GrantRootRuntimeTrustRequest } | { revoke: RevokeRootRuntimeTrustRequest }): GrantRootRuntimeTrustResponse | RevokeRootRuntimeTrustResponse {
    const creating = 'grant' in change;
    const input = creating ? change.grant : change.revoke;
    const action = creating ? trustAction : untrustAction;
    const type = creating ? 'runtime' : 'runtime_trust';
    return withSecurityTarget(this.db,tx,`management:${type}:${targetId}`,() => onPrimary(() => {
      const bound = this.actors.get(actor as Actor);
      if (!bound || bound.tx !== tx || bound.action !== action || bound.target !== targetId) throw new SecurityAbort('root_required');
      const current = this.check(tx,bound.proof,{ action,actualTarget: { type,id: targetId },use: 'management' });
      if (!current.effectiveRoot || !current.subject || !current.recordedGrant) throw new SecurityAbort('root_required');
      if ((actor as Actor).checkedRevision !== current.checkedRevision || (actor as Actor).recordedGrant?.grantId !== current.recordedGrant.grantId) throw new SecurityAbort('authority_revision_conflict');
      if (!input.reason?.trim() || !input.idempotency_key?.trim() || !Number.isSafeInteger(input.expected_revision) || input.expected_revision<0) throw new RootManagementRequestError(400,'Invalid trust request');
      const key = [current.subject.id,action,targetId,input.idempotency_key];
      const payload = digest(JSON.stringify(Object.entries(input).sort(([left],[right])=>left<right?-1:left>right?1:0)));
      const prior = this.db.query(`SELECT payload_digest,result_json FROM multiremi_root_management_events WHERE actor_user_id=? AND action=? AND target_id=? AND idempotency_key=?`).get(...key);
      if (prior) {
        if (prior.payload_digest !== payload) throw new SecurityAbort('authority_revision_conflict');
        const historical = JSON.parse(prior.result_json) as GrantRootRuntimeTrustResponse;
        const row = this.db.query(`SELECT t.record_json,t.authority_node_id,t.challenge_id,e.incarnation AS current_incarnation FROM multiremi_runtime_trusts t
          LEFT JOIN multiremi_machine_enrollments e ON e.incarnation=t.incarnation AND e.retired_at_ms IS NULL WHERE t.trust_id=?`).get(historical.trust.id);
        if (!row) throw new SecurityAbort('security_state_unavailable');
        const trust = JSON.parse(row.record_json) as RootRuntimeTrustRecord;
        const expired = trust.expires_at !== null && Date.parse(trust.expires_at)<=Date.now();
        const active = trust.status==='active' && !expired && row.current_incarnation && creating && recordedMachineBindingIsCurrent(this.db,tx,targetId,row.challenge_id) && grantAncestryIsCurrent(this.db,tx,targetId,
          { nodeId: row.authority_node_id,generation: trust.generation },'runtime');
        return { ...historical,security_revision: current.checkedRevision,replayed: true,trust: { ...trust,status: trust.status==='active' && expired?'expired':trust.status,
          effective: !!active,effective_reason_code: active?'active':trust.status==='revoked'?'trust_revoked':expired?'trust_expired':'runtime_untrusted' } };
      }
      const before = current.checkedRevision;
      const revision = before+1;
      if (before !== input.expected_revision || !Number.isSafeInteger(revision)) throw new SecurityAbort('authority_revision_conflict');
      const now = Date.now();
      const evidence = this.evidence(bound.proof);
      let result: GrantRootRuntimeTrustResponse | RevokeRootRuntimeTrustResponse;
      if (creating) {
        const request = change.grant;
        if (!request.challenge_id || !request.challenge_response) throw new SecurityAbort('root_required');
        const machine = readVerifiedTrustChallenge(this.db,tx,targetId,request.challenge_id,request.challenge_response);
        if (machine.daemonId !== request.daemon_id || machine.incarnation !== request.incarnation || machine.keyId !== request.recipient_key_id
          || machine.fingerprint !== request.recipient_key_fingerprint || request.recipient_key_expires_at != null && Date.parse(request.recipient_key_expires_at)!==machine.expires) throw new SecurityAbort('root_required');
        const ceiling = Math.min(machine.expires,machine.attestationExpiry);
        const expiry = request.expires_at==null ? ceiling : Date.parse(request.expires_at);
        if (!(expiry>now && expiry<=ceiling)) throw new RootManagementRequestError(400,'Invalid trust expiry');
        if (this.db.query(`SELECT trust_id FROM multiremi_runtime_trusts WHERE (runtime_id=? AND revoked_at_ms IS NULL) OR challenge_id=?`).get(targetId,request.challenge_id)) throw new SecurityAbort('authority_revision_conflict');
        const generation = Number(this.db.query('SELECT COALESCE(MAX(generation),0) AS generation FROM multiremi_runtime_trusts WHERE runtime_id=?').get(targetId).generation)+1;
        const node = this.newNode('runtime_trust','runtime',targetId,generation,revision,expiry,[current.recordedGrant.authorityNodeId,evidence.node,machine.authorityNodeId]);
        if (!grantAncestryIsCurrent(this.db,tx,targetId,{ nodeId: node,generation },'runtime')) throw new SecurityAbort('root_authority_revoked');
        const trust: RootRuntimeTrustRecord = { id: randomUUID(),generation,runtime_id: targetId,daemon_id: machine.daemonId,incarnation: machine.incarnation,
          workspace_id: machine.workspaceId,recipient_key_id: machine.keyId,recipient_key_fingerprint: machine.fingerprint,recipient_key_expires_at: new Date(machine.expires).toISOString(),
          immutable_env_carrier_verified: true,isolation_note: request.isolation_note??null,status:'active',effective:true,effective_reason_code:'active',issuer:current.subject,
          reason:request.reason,revocation_reason:null,expires_at:new Date(expiry).toISOString(),created_at:new Date(now).toISOString(),revoked_at:null,revision };
        this.db.query(`INSERT INTO multiremi_runtime_trusts(trust_id,runtime_id,generation,incarnation,challenge_id,authority_node_id,record_json) VALUES(?,?,?,?,?,?,?)`)
          .run(trust.id,targetId,generation,machine.incarnation,request.challenge_id,node,JSON.stringify(trust));
        result = {trust,security_revision:revision};
      } else {
        const row = this.db.query('UPDATE multiremi_runtime_trusts SET revoked_at_ms=? WHERE trust_id=? AND revoked_at_ms IS NULL RETURNING *').get(now,targetId);
        if (!row || !this.db.query(`UPDATE multiremi_authority_nodes SET revoked_at_ms=?,revision=? WHERE node_id=? AND kind='runtime_trust'
          AND subject_id=? AND generation=? AND revoked_at_ms IS NULL RETURNING node_id`).get(now,revision,row.authority_node_id,row.runtime_id,row.generation)) throw new SecurityAbort('authority_revision_conflict');
        const trust: RootRuntimeTrustRecord = { ...JSON.parse(row.record_json),status:'revoked',effective:false,effective_reason_code:'trust_revoked',revision,
          revoked_at:new Date(now).toISOString(),revocation_reason:input.reason };
        this.db.query('UPDATE multiremi_runtime_trusts SET record_json=? WHERE trust_id=?').run(JSON.stringify(trust),targetId);
        const count = this.db.query(`WITH RECURSIVE affected(node_id) AS (SELECT node_id FROM multiremi_authority_nodes WHERE node_id=? UNION
          SELECT e.child_id FROM multiremi_authority_edges e JOIN affected a ON a.node_id=e.parent_id WHERE e.dependency='continuous') SELECT COUNT(*) AS total FROM affected`).get(row.authority_node_id);
        result = {trust,security_revision:revision,affected_authority_count:Number(count.total),cleanup_batch_id:null};
      }
      if (!this.db.query('UPDATE multiremi_security_state SET security_revision=? WHERE singleton=1 AND security_revision=? RETURNING singleton').get(revision,before)) throw new SecurityAbort('authority_revision_conflict');
      this.db.query(`INSERT INTO multiremi_root_management_events(actor_user_id,action,target_id,idempotency_key,payload_digest,proof_node_id,actor_grant_id,
        actor_generation,reason,reason_code,revision_before,revision_after,created_at_ms,result_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(...key,payload,evidence.node,current.recordedGrant.grantId,current.recordedGrant.generation,input.reason,creating?null:change.revoke.reason_code??null,before,revision,now,JSON.stringify(result));
      return result;
    }));
  }

  private revoke(tx: SecurityTx, actor: Parameters<AuthorityKernel['revokeGrant']>[1], targetId: string, action: string,
    input: RevokeRootGrantRequest): Response {
    const type = action === grantAction ? 'grant' : 'credential_family';
    return withSecurityTarget(this.db, tx, `management:${type}:${targetId}`, () => {
      const bound = this.actors.get(actor as Actor);
      if (!bound || bound.tx !== tx || bound.target !== targetId || bound.action !== action) throw new SecurityAbort('root_required');
      const current = this.check(tx, bound.proof, { action, actualTarget: { type, id: targetId }, use: 'management' });
      if (!current.effectiveRoot || !current.recordedGrant || !current.subject) throw new SecurityAbort('root_required');
      const previous = actor as Actor;
      if (previous.recordedGrant?.grantId !== current.recordedGrant.grantId || previous.recordedGrant.generation !== current.recordedGrant.generation
        || previous.checkedRevision !== current.checkedRevision) throw new SecurityAbort('authority_revision_conflict');
      if (typeof input.reason !== 'string' || !input.reason.trim() || typeof input.idempotency_key !== 'string'
        || !input.idempotency_key.trim() || !Number.isSafeInteger(input.expected_revision)
        || input.expected_revision < 0 || (action === familyAction || input.reason_code !== undefined)
          && !ROOT_SECURITY_REVOKE_REASONS.some(code => code === input.reason_code)) throw new RootManagementRequestError(400, 'Invalid revocation request');
      const key = [current.subject.id, action, targetId, input.idempotency_key];
      const payload = digest(JSON.stringify([input.expected_revision, input.reason, input.reason_code ?? null]));
      const prior = this.db.query(`SELECT payload_digest,result_json FROM multiremi_root_management_events
        WHERE actor_user_id=? AND action=? AND target_id=? AND idempotency_key=?`).get(...key);
      if (prior) {
        if (prior.payload_digest !== payload) throw new SecurityAbort('authority_revision_conflict');
        return { ...JSON.parse(prior.result_json), replayed: true };
      }
      const before = current.checkedRevision;
      const revision = before + 1;
      if (input.expected_revision !== before || !Number.isSafeInteger(revision)) throw new SecurityAbort('authority_revision_conflict');
      const now = Date.now();
      const target = action === grantAction
        ? this.db.query(`UPDATE multiremi_root_grants SET revoked_at_ms=?,revoke_reason=?,revision=?
          WHERE grant_id=? AND revoked_at_ms IS NULL RETURNING *`).get(now, input.reason, revision, targetId)
        : this.db.query(`UPDATE multiremi_credential_families SET revoked_at_ms=?,revision=? WHERE family_id=? AND revoked_at_ms IS NULL RETURNING *`).get(now, revision, targetId);
      if (!target) throw new SecurityAbort('authority_revision_conflict');
      const changed = this.db.query(`UPDATE multiremi_authority_nodes SET revoked_at_ms=?,revision=? WHERE node_id=?
        AND kind=? AND revoked_at_ms IS NULL RETURNING subject_id,subject_type,generation`).get(now, revision, target.authority_node_id, type);
      if (!changed) throw new SecurityAbort('authority_revision_conflict');
      if (action === grantAction && (changed.subject_id !== target.subject_id || changed.subject_type !== target.subject_type
        || Number(changed.generation) !== Number(target.generation) || !this.db.query(`UPDATE multiremi_root_subject_state SET active_grant_id=NULL
          WHERE subject_type=? AND subject_id=? AND generation_counter=? AND active_grant_id=? RETURNING generation_counter`)
          .get(target.subject_type, target.subject_id, target.generation, targetId))) throw new SecurityAbort('authority_revision_conflict');
      const count = this.db.query(`WITH RECURSIVE affected(node_id) AS (SELECT node_id FROM multiremi_authority_nodes WHERE node_id=?
        UNION SELECT e.child_id FROM multiremi_authority_edges e JOIN affected a ON a.node_id=e.parent_id WHERE e.dependency='continuous')
        SELECT COUNT(*) AS total FROM affected`).get(target.authority_node_id);
      const common = { security_revision: revision, affected_authority_count: Number(count.total), cleanup_batch_id: null };
      const result: Response = action === familyAction ? { ...common, family_id: targetId, status: 'revoked' } : { ...common, grant: {
        id: targetId, subject: { type: target.subject_type, id: target.subject_id }, generation: Number(target.generation), scope: 'system',
        status: 'revoked', effective: false, effective_reason_code: 'grant_revoked', authority_node_id: target.authority_node_id,
        issuer: { type: target.issuer_type, id: target.issuer_id }, origin_attempt_id: target.issuer_attempt_id, origin_family_id: target.origin_family_id,
        reason: target.reason, revocation_reason: input.reason, created_at: new Date(Number(target.created_at_ms)).toISOString(),
        expires_at: target.expires_at_ms === null ? null : new Date(Number(target.expires_at_ms)).toISOString(), revoked_at: new Date(now).toISOString(), revision } };
      if (!this.db.query(`UPDATE multiremi_security_state SET security_revision=? WHERE singleton=1 AND security_revision=? RETURNING singleton`)
        .get(revision, before)) throw new SecurityAbort('authority_revision_conflict');
      this.db.query(`INSERT INTO multiremi_root_management_events(actor_user_id,action,target_id,idempotency_key,payload_digest,proof_node_id,
        actor_grant_id,actor_generation,reason,reason_code,revision_before,revision_after,created_at_ms,result_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(...key, payload, this.evidence(bound.proof).node, current.recordedGrant.grantId, current.recordedGrant.generation,
          input.reason, input.reason_code ?? null, before, revision, now, JSON.stringify(result));
      return result;
    });
  }
}
