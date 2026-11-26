import { createHash, randomUUID } from 'node:crypto';
import { ROOT_SECURITY_REVOKE_REASONS, type RevokeCredentialFamilyRequest, type RevokeCredentialFamilyResponse,
  type RevokeRootGrantRequest, type RevokeRootGrantResponse, type CreateRootGrantRequest, type CreateRootGrantResponse } from '@multiremi/contracts/root-authority.js';
import type { SqlDatabase } from './db/postgres.js';
import type { GrantRootRuntimeTrustRequest, GrantRootRuntimeTrustResponse, RevokeRootRuntimeTrustRequest, RevokeRootRuntimeTrustResponse, RootRuntimeTrustRecord,
  RootContextResponse, RootTransportIdentity, RootGrantRecord, ListRootGrantsResponse, GetRootRuntimeTrustResponse,
  ListRootRuntimeTrustResponse, ListRootAuditResponse } from '@multiremi/contracts/root-authority.js';
import { readVerifiedTrustChallenge, recordedMachineBindingIsCurrent } from './machine-proof.js';
import { machineRetirementPayload, requireEnrollmentBinding, requireMachineDeployment, type HostAttestation, type MachinePublicBinding } from './machine-enrollment.js';
import { assertUnrevokedAncestry, grantAncestryIsCurrent } from './authority-provenance.js';
import type { AdmissionTicket, AuthorityKernel, AuthorityUse, CredentialProof, CurrentAuthority, FinalExecution, InputManifest, VersionedRef } from './root-authority-contract.js';
import { requireAgentDependencySnapshot, type ResolveAgentDependencies } from './agent-grant-dependencies.js';
import { executionTrustNodeId, storeAgentConfigurationApproval, type AgentConfigurationApproval } from './agent-source-approvals.js';
import { releasePatAfterCommit, type DelegatedPatInput, type DelegationUse } from './durable-delegation.js';
import { persistIssuedMaterialBinding } from './credential-version-bindings.js';
import type { AuthorityNodeRef } from './authority-provenance.js';
import type { GrantSubject } from './root-grants.js';
import { requireActivatingDelivery, type PreparedRootDelivery } from './root-receipts.js';
import type { IssueCredentialInput, IssuedCredential } from './root-authority-contract.js';
import { isDeepStrictEqual } from 'node:util';
import { readRecordedGrant } from './root-grants.js';
import { approvedAttemptSources, matchesDeliveryLease, readAttemptEligibility, readCurrentTaskLease } from './task-authority.js';
import { RegisteredCredentialProofs } from './registered-credential-proof.js';
import { abortSecurityWrite, SecurityAbort, withSecurityTarget, withSecurityWrite, type SecurityTx } from './security-write.js';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const isoTime = (value: number | string | null) => value === null ? null : new Date(Number(value)).toISOString();
const grantAction = 'root.grant.revoke';
const familyAction = 'root.credential-family.revoke';
const createAction = 'root.grant.create';
const trustAction = 'root.runtime-trust.grant';
const untrustAction = 'root.runtime-trust.revoke';
type Actor = ReturnType<AuthorityKernel['authorizeWrite']>;
type Invocation = Parameters<AuthorityKernel['admitAttempt']>[2];
interface RetryTarget { turnId: string; previousAttemptId: string; attemptId: string }
export interface InitialAttemptTarget {turnId:string;attemptId:string;agentId:string;workspaceId:string;sessionId:string;previousAttemptId:null}
type AttemptTarget = RetryTarget | InitialAttemptTarget;
interface RetryOrigin {
  turnId:string;attemptId:string;previousAttemptId:string|null;
  action: 'turn.retry'|'turn.create';
  workspaceId: string; sessionId: string; sessionOwnerType: 'chat' | 'issue'; sessionOwnerId: string; executionScope: string; agentId: string;
  actorId: string; proofNodeId: string; proofGeneration: number; grantId: string; grantGeneration: number;
}

export interface ApprovedExecutionInputs {
  readonly manifest: VersionedRef;
  readonly sourcePolicy: VersionedRef;
  readonly entries: readonly { readonly source:VersionedRef; readonly snapshot:string; readonly purpose:'instruction'|'business_data'|'tool_result'|'answer'|'checkpoint_context'; readonly author:GrantSubject }[];
  readonly providerState: { readonly sessionId:string|null; readonly securityDomainId:string; readonly checkpointDigest:string|null };
}
export interface AgentGrantRuntimeReview {
  readonly agentId: string;
  readonly workspaceId: string;
  readonly checkedRevision: number;
  readonly runtimeTrusts: readonly (VersionedRef & { runtimeId: string; daemonId: string; incarnation: string })[];
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
  private readonly actors = new WeakMap<Actor, { tx: SecurityTx; proof: CredentialProof; action: string; target: string; targetType:string; use:string }>();
  private readonly dashboardCandidates = new WeakMap<CredentialProof, IndependentDashboardIssuance>();
  private readonly directRetries = new WeakMap<Invocation,{tx:SecurityTx;proof:CredentialProof;origin:Readonly<RetryOrigin>}>();
  private readonly admissions = new WeakMap<AdmissionTicket,{tx:SecurityTx;subject:GrantSubject;proof:CredentialProof;origin:Readonly<RetryOrigin>;snapshot:AdmissionTicket}>();

  readonly registeredCredentials: RegisteredCredentialProofs;

  constructor(private readonly db: SqlDatabase, private readonly resolveAgentDependencies?: ResolveAgentDependencies) {
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
    const machine = request.action === trustAction && this.db.query('SELECT authority_node_id FROM multiremi_machine_enrollments WHERE runtime_id=? AND retired_at_ms IS NULL').get(request.actualTarget.id);
    const machineTargets = machine ? [`authority:${machine.authority_node_id}`] : [];
    if (proof.kind==='dependent') {
      const plan = onPrimary(() => this.registeredCredentials.plan(proof));
      return {...plan,domainTargets:[...new Set([...plan.domainTargets,...machineTargets,`management:${request.actualTarget.type}:${request.actualTarget.id}`])].sort()};
    }
    const evidence = this.evidence(proof);
    const state = onPrimary(() => this.db.query('SELECT security_revision FROM multiremi_security_state WHERE singleton=1').get());
    if (!state) throw new SecurityAbort('security_state_unavailable');
    const grant = onPrimary(() => this.db.query(`SELECT g.authority_node_id FROM multiremi_root_subject_state s JOIN multiremi_root_grants g
      ON g.grant_id=s.active_grant_id WHERE s.subject_type='user' AND s.subject_id=?`).get(evidence.userId));
    const targets = [`authority:${evidence.node}`, `grant:user:${evidence.userId}`, `management:${request.actualTarget.type}:${request.actualTarget.id}`];
    if (grant) targets.push(`authority:${grant.authority_node_id}`);
    targets.push(...machineTargets);
    return { fenceTerm:undefined, expectedRevision: Number(state.security_revision), workspaceIds: [], numberKeys: [], domainTargets: [...new Set(targets)].sort() };
  }

  private checkPassword(tx: SecurityTx, evidence: PasswordEvidence): void {
    const row = this.passwordRow(evidence.userId, true);
    if (!row || digest(row.password_hash) !== evidence.verifier) throw new SecurityAbort('credential_version_conflict');
    const source = this.versionRow(evidence.userId, evidence.verifier);
    if (!source || source.password_node_id !== evidence.node || Number(source.version) !== evidence.version) throw new SecurityAbort('credential_version_conflict');
    assertUnrevokedAncestry(this.db, tx, { nodeId: evidence.node, generation: evidence.version });
  }

  planAgentGrant(proof: CredentialProof, agentId: string, trustIds: readonly string[]) {
    return onPrimary(()=>{
      const base = this.plan(proof,{action:createAction,use:'management',actualTarget:{type:'agent',id:agentId}});
      const agent = this.db.query('SELECT workspace_id FROM multiremi_agents WHERE id=? AND archived_at IS NULL').get(agentId);
      if (!agent) throw new RootManagementRequestError(404,'Agent not found');
      const lookup = this.db.query('SELECT runtime_id FROM multiremi_runtime_trusts WHERE trust_id=?');
      const targets = trustIds.map(id=>{
        const row = lookup.get(id);
        if (!row) throw new SecurityAbort('root_runtime_untrusted');
        return `management:runtime:${row.runtime_id}`;
      });
      return {...base,workspaceIds:[...new Set([...base.workspaceIds,String(agent.workspace_id)])].sort(),domainTargets:[...new Set([...base.domainTargets,...targets])].sort()};
    });
  }

  previewAgentGrant(proof: CredentialProof, agentId: string, trustIds: readonly string[]) {
    return onPrimary(()=>{
      const plan=this.planAgentGrant(proof,agentId,trustIds);
      return withSecurityWrite(this.db,plan.fenceTerm,plan,tx=>{
        if (!this.check(tx,proof,{action:'root.grant.preview',use:'read',actualTarget:{type:'agent',id:agentId}}).effectiveRoot || !this.resolveAgentDependencies) throw new SecurityAbort('root_required');
        return this.resolveAgentDependencies(tx,agentId,trustIds);
      });
    });
  }

  approveAgentConfiguration(tx: SecurityTx, actor: Actor, agentId: string, expectedEpoch: number | null, approval: AgentConfigurationApproval) {
    const use={action:'root.agent-configuration.approve',use:'write',actualTarget:{type:'agent',id:agentId}};
    return withSecurityTarget(this.db,tx,`management:agent:${agentId}`,()=>{
      const current=this.requireMutationActor(tx,actor,use);
      const agent=this.db.query('SELECT workspace_id FROM multiremi_agents WHERE id=? AND archived_at IS NULL').get(agentId);
      if (!agent || !current.recordedGrant || !this.resolveAgentDependencies) throw new SecurityAbort('root_required');
      if (expectedEpoch!==null && (!Number.isSafeInteger(expectedEpoch) || expectedEpoch<0)) throw new SecurityAbort('authority_revision_conflict');
      const epoch=expectedEpoch===null?0:expectedEpoch+1;
      const source=current.credentialOrigin?.node ?? this.passwordOrigin(this.actors.get(actor)!.proof);
      const revision=this.advanceSecurityRevision();
      const node=this.newNode('agent_configuration','agent',agentId,epoch+1,revision,null,[current.recordedGrant.authorityNodeId,source.nodeId]);
      const prior=this.db.query('SELECT approval_node_id FROM multiremi_agent_config_epochs WHERE agent_id=?').get(agentId);
      const changed=expectedEpoch===null ? this.db.query(`INSERT INTO multiremi_agent_config_epochs(agent_id,workspace_id,config_epoch,approval_node_id) VALUES(?,?,?,?)
        ON CONFLICT(agent_id) DO NOTHING RETURNING agent_id`).get(agentId,agent.workspace_id,epoch,node) : this.db.query(`UPDATE multiremi_agent_config_epochs SET config_epoch=?,approval_node_id=?
        WHERE agent_id=? AND workspace_id=? AND config_epoch=? RETURNING agent_id`).get(epoch,node,agentId,agent.workspace_id,expectedEpoch);
      if (!changed) throw new SecurityAbort('authority_revision_conflict');
      if (prior) this.db.query(`UPDATE multiremi_authority_nodes SET revoked_at_ms=COALESCE(revoked_at_ms,?),revision=? WHERE node_id=?`).run(Date.now(),revision,prior.approval_node_id);
      storeAgentConfigurationApproval(this.db,agentId,agent.workspace_id,epoch,approval);
      const resolved=this.resolveAgentDependencies(tx,agentId,approval.executions.map(execution=>execution.trustId));
      if (resolved.configEpoch!==epoch || resolved.agentId!==agentId || !approval.sources.every(({ref})=>resolved.refs.some(live=>
        live.kind===ref.kind && live.id===ref.id && live.use===ref.use && live.version===ref.version && live.digest===ref.digest))) throw new SecurityAbort('authority_revision_conflict');
      return resolved;
    });
  }

  reviewAgentGrantRuntimeTrusts(proof: CredentialProof, agentId: string, runtimeTrustIds: readonly string[]): AgentGrantRuntimeReview {
    const request = { action: 'root.grant.review-runtime-trusts', use: 'read', actualTarget: { type: 'agent', id: agentId } };
    const ids = [...new Set(runtimeTrustIds)].sort();
    if (!agentId || !ids.length || ids.length !== runtimeTrustIds.length || ids.some(id => typeof id !== 'string' || !id.trim())) {
      throw new RootManagementRequestError(400, 'Expected distinct runtime trust IDs');
    }
    return onPrimary(() => {
      const plan = this.plan(proof, request);
      const agent = this.db.query('SELECT workspace_id FROM multiremi_agents WHERE id=? AND archived_at IS NULL').get(agentId);
      const lookup = this.db.query('SELECT runtime_id FROM multiremi_runtime_trusts WHERE trust_id=?');
      const runtimeIds: (string | undefined)[] = ids.map(id => lookup.get(id)?.runtime_id);
      const targets = [...new Set([...plan.domainTargets, ...runtimeIds.filter(Boolean).map(id => `management:runtime:${id}`)])].sort();
      return withSecurityWrite(this.db, plan.fenceTerm, { ...plan, workspaceIds: agent ? [agent.workspace_id] : [], domainTargets: targets }, tx => {
        const actor = this.check(tx, proof, request);
        if (!actor.effectiveRoot) throw new SecurityAbort('root_required');
        if (!agent || !this.db.query('SELECT id FROM multiremi_agents WHERE id=? AND workspace_id=? AND archived_at IS NULL').get(agentId, agent.workspace_id)) {
          throw new RootManagementRequestError(404, 'Agent not found');
        }
        const eligible = this.db.query(`SELECT t.trust_id,t.generation,t.runtime_id,t.incarnation,t.authority_node_id,t.challenge_id,r.daemon_id
          FROM multiremi_agents a JOIN multiremi_runtimes r ON r.workspace_id=a.workspace_id
          JOIN multiremi_runtime_trusts t ON t.runtime_id=r.id AND t.revoked_at_ms IS NULL
          JOIN multiremi_machine_enrollments e ON e.runtime_id=r.id AND e.daemon_id=r.daemon_id AND e.incarnation=t.incarnation AND e.retired_at_ms IS NULL
          WHERE a.id=? AND a.workspace_id=? AND a.archived_at IS NULL AND t.trust_id=? AND r.id=?
            AND ((a.execution_group_id IS NULL AND a.runtime_id=r.id AND r.provider=a.provider) OR EXISTS (
              SELECT 1 FROM multiremi_execution_group_members m WHERE m.workspace_id=a.workspace_id AND m.provider=a.provider
                AND m.group_id=a.execution_group_id AND m.runtime_id=r.id))`);
        const runtimeTrusts = ids.map((id, index) => {
          const runtimeId = runtimeIds[index];
          if (!runtimeId) throw new SecurityAbort('root_runtime_untrusted');
          const row = eligible.get(agentId, agent.workspace_id, id, runtimeId);
          if (!row || !recordedMachineBindingIsCurrent(this.db, tx, runtimeId, row.challenge_id)
            || !grantAncestryIsCurrent(this.db, tx, runtimeId, {nodeId: row.authority_node_id, generation: Number(row.generation)}, 'runtime')) {
            throw new SecurityAbort('root_runtime_untrusted');
          }
          return { id, version: Number(row.generation), runtimeId, daemonId: String(row.daemon_id), incarnation: String(row.incarnation) };
        });
        return {agentId, workspaceId: String(agent.workspace_id), checkedRevision: actor.checkedRevision, runtimeTrusts};
      });
    });
  }

  private check(tx: SecurityTx, proof: CredentialProof, request: AuthorityUse, directRetry = false): CurrentAuthority {
    const target = request.actualTarget;
    const retry = directRetry && request.action === 'turn.retry' && request.use === 'invocation' && target.type === 'turn';
    const knownManagement = [grantAction,createAction,trustAction,untrustAction,familyAction].includes(request.action);
    const generic = !knownManagement && request.action!=='turn.retry' && ['read','write','management','invocation'].includes(request.use);
    if (!target.id || !target.type || !request.action || !(generic || retry || request.use === 'management' && (request.action === grantAction && target.type === 'grant'
      || request.action === createAction && (target.type === 'user' || target.type === 'agent')
      || request.action === trustAction && target.type === 'runtime' || request.action === untrustAction && target.type === 'runtime_trust'
      || request.action === familyAction && target.type === 'credential_family'))) throw new SecurityAbort('root_required');
    const state = this.db.query('SELECT feature_activation,security_revision FROM multiremi_security_state WHERE singleton=1').get();
    if (!state) throw new SecurityAbort('security_state_unavailable');
    const active = Number(state.feature_activation) === 1;
    if (proof.kind==='dependent') {
      const material = this.registeredCredentials.requireCurrent(tx,proof);
      const recordedGrant = readRecordedGrant(this.db,tx,material.subject);
      let reason = !active?'feature_disabled':!recordedGrant?'no_grant':'active';
      if (reason==='active' && material.type==='task' && !this.taskIsEligible(tx, material, recordedGrant!)) reason='attempt_not_eligible';
      if (reason==='active') this.requireMaterialGrant(tx,material,recordedGrant!);
      return {transport:material.type==='task'?'task':material.subject.type==='agent'?'agent_pat':'human',subject:material.subject,attemptId:material.attemptId,recordedGrant,
        credentialOrigin:{credential:material.credential,familyId:material.familyId,node:material.node},effectiveRoot:reason==='active',scope:reason==='active'?'system':null,reason,
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
      if (!this.hasHumanGrantOrigins(grant.authorityNodeId)) throw new SecurityAbort('root_authority_revoked');
      const exists = generic || (retry ? this.db.query('SELECT id FROM multiremi_turns WHERE id=?').get(target.id)
        : request.action === trustAction ? this.db.query('SELECT id FROM multiremi_runtimes WHERE id=?').get(target.id)
        : request.action === untrustAction ? this.db.query('SELECT trust_id FROM multiremi_runtime_trusts WHERE trust_id=?').get(target.id)
        : request.action === createAction ? (target.type==='agent' ? this.db.query('SELECT id FROM multiremi_agents WHERE id=? AND archived_at IS NULL') : this.db.query('SELECT id FROM multiremi_users WHERE id=?')).get(target.id) : request.action === grantAction
        ? this.db.query('SELECT grant_id FROM multiremi_root_grants WHERE grant_id=?').get(target.id)
        : this.db.query('SELECT family_id FROM multiremi_credential_families WHERE family_id=?').get(target.id));
      if (!exists) throw new RootManagementRequestError(404, 'Management target not found');
    }
    return { transport: 'human', subject, credentialOrigin: null, attemptId: null, recordedGrant: grant,
      scope: active && grant ? 'system' : null, effectiveRoot: active && !!grant,
      reason: !active ? 'feature_disabled' : grant ? 'active' : 'no_grant', checkedRevision: Number(state.security_revision) };
  }

  resolveCurrent(proof: CredentialProof, request: AuthorityUse): CurrentAuthority {
    return onPrimary(() => {
      const plan = this.plan(proof,request);
      return withSecurityWrite(this.db, plan.fenceTerm, plan, tx => this.check(tx, proof, request));
    });
  }

  requireReceiptAuthority(tx: SecurityTx, receiptId: string): void {
    const material = this.registeredCredentials.requireReceiptMaterial(tx,receiptId);
    const grant = readRecordedGrant(this.db,tx,material.subject);
    const state = this.db.query('SELECT feature_activation FROM multiremi_security_state WHERE singleton=1').get();
    if (Number(state?.feature_activation)!==1 || !grant || !this.taskIsEligible(tx,material,grant)) {
      return abortSecurityWrite(this.db,tx,'root_authority_revoked');
    }
    this.requireMaterialGrant(tx,material,grant);
  }

  private requireMaterialGrant(tx: SecurityTx, material: ReturnType<RegisteredCredentialProofs['requireCurrent']>, grant: NonNullable<CurrentAuthority['recordedGrant']>): void {
    const node = this.db.query(`SELECT g.node_id FROM multiremi_authority_nodes g JOIN multiremi_authority_nodes m ON m.node_id=?
      WHERE g.node_id=? AND g.generation=? AND g.kind='grant' AND g.scope='system' AND g.subject_type=? AND g.subject_id=?
      AND m.issued_seq>g.issued_seq`).get(material.node.nodeId,grant.authorityNodeId,grant.generation,material.subject.type,material.subject.id);
    if (!node || !this.hasHumanGrantOrigins(grant.authorityNodeId)) throw new SecurityAbort('root_authority_revoked');
    assertUnrevokedAncestry(this.db,tx,{nodeId:grant.authorityNodeId,generation:grant.generation});
  }

  readContext(proof: CredentialProof | null, transport: RootTransportIdentity): RootContextResponse {
    return onPrimary(() => {
      const use: AuthorityUse = { action: 'root.context', actualTarget: { type: 'system', id: 'root' }, use: 'read' };
      const read = (current: CurrentAuthority | null): RootContextResponse => {
        const state = this.db.query('SELECT feature_activation,bootstrap_completed,security_revision FROM multiremi_security_state WHERE singleton=1').get();
        if (!state) throw new SecurityAbort('security_state_unavailable');
        const active = Number(state.feature_activation) === 1;
        const effective = current?.effectiveRoot ?? false;
        const provenance = current?.transport==='agent_pat' && current.credentialOrigin ? this.db.query(`SELECT d.attempt_id,d.beneficiary_type,d.beneficiary_id
          FROM multiremi_delegated_pats p JOIN multiremi_durable_delegations d ON d.node_id=p.origin_node_id WHERE p.credential_id=?`).get(current.credentialOrigin.credential.id) : null;
        return {
          security_revision: Number(state.security_revision), feature_activation: active, bootstrap_completed: Number(state.bootstrap_completed) === 1,
          transport_identity: current?.transport ?? transport, authenticated_subject: current?.subject ?? null,
          beneficiary_user_id: current?.subject?.type === 'user' ? current.subject.id : provenance?.beneficiary_type==='user' ? provenance.beneficiary_id : null,
          is_agent_origin: current?.subject?.type === 'agent', credential_id: current?.credentialOrigin?.credential.id ?? null,
          family_id: current?.credentialOrigin?.familyId ?? null, origin_attempt_id: provenance?.attempt_id ?? current?.attemptId ?? null,
          current_attempt_id: current?.attemptId ?? null, agent_granted_root: current?.subject?.type === 'agent' && !!current.recordedGrant,
          current_attempt_effective_root: current?.transport === 'task' && effective,
          effective_root: effective, effective_reason_code: current?.reason ?? (active ? 'unverified_human_auth' : 'feature_disabled'),
          grant_id: current?.recordedGrant?.grantId ?? null, grant_generation: current?.recordedGrant?.generation ?? null,
          capabilities: { can_manage_root: effective, can_edit_root_execution: false, can_manage_runtime_trust: effective,
            can_revoke_credential_family: effective, can_read_root_audit: effective },
          allowed_operations: [...(effective ? ['root.grant.list', 'root.grant.revoke', 'root.runtime-trust.list',
            'root.runtime-trust.get', 'root.credential-family.revoke', 'root.audit.list'] : []),
            ...(effective ? ['root.grant.create', 'root.runtime-trust.grant', 'root.runtime-trust.revoke'] : [])],
        };
      };
      if (!proof) return read(null);
      const plan = this.plan(proof, use);
      return withSecurityWrite(this.db, plan.fenceTerm, plan, tx => read(this.check(tx, proof, use)));
    });
  }

  private readControl<T, Result>(proof: CredentialProof, action: string, load: () => T[],
    target: (row: T) => string | null, project: (tx: SecurityTx, current: CurrentAuthority, rows: T[]) => Result): Result {
    return onPrimary(() => {
      const use: AuthorityUse = { action, actualTarget: { type: 'system', id: 'root' }, use: 'read' };
      const plan = this.plan(proof, use);
      const domainTargets = new Set(plan.domainTargets);
      for (const row of load()) {
        const key = target(row);
        if (key) domainTargets.add(key);
      }
      return withSecurityWrite(this.db, plan.fenceTerm, { ...plan, domainTargets: [...domainTargets].sort() }, tx => {
        const current = this.check(tx, proof, use);
        if (!current.effectiveRoot) throw new SecurityAbort('root_required');
        return project(tx, current, load());
      });
    });
  }

  listRootGrants(proof: CredentialProof, options: { cursor: string; limit: number; subjectType: string; subjectId: string; status: string }): ListRootGrantsResponse {
    const { cursor, limit, subjectType, subjectId, status } = options;
    const stamp = Date.now();
    const load = () => this.db.query(`SELECT g.*, s.active_grant_id FROM multiremi_root_grants g
      LEFT JOIN multiremi_root_subject_state s ON s.subject_type=g.subject_type AND s.subject_id=g.subject_id
      WHERE g.grant_id>? AND (?='' OR g.subject_type=?) AND (?='' OR g.subject_id=?)
      AND (?='' OR ?=CASE WHEN g.revoked_at_ms IS NOT NULL THEN 'revoked'
        WHEN g.expires_at_ms<=? THEN 'expired' ELSE 'active' END) ORDER BY g.grant_id LIMIT ?`)
      .all(cursor, subjectType, subjectType, subjectId, subjectId, status, status, stamp, limit + 1);
    return this.readControl(proof, 'root.grant.list', load, row => `management:${row.subject_type}:${row.subject_id}`, (tx, current, rows) => ({
      security_revision: current.checkedRevision, next_cursor: rows.length > limit ? rows[limit - 1].grant_id : null,
      grants: rows.slice(0, limit).map((row): RootGrantRecord => {
        const revoked = row.revoked_at_ms !== null;
        const expired = row.expires_at_ms !== null && Number(row.expires_at_ms) <= stamp;
        const effective = !revoked && !expired && row.active_grant_id === row.grant_id
          && this.hasHumanGrantOrigins(row.authority_node_id)
          && grantAncestryIsCurrent(this.db, tx, row.subject_id, { nodeId: row.authority_node_id, generation: Number(row.generation) },row.subject_type);
        return {
          id: row.grant_id, subject: { type: row.subject_type, id: row.subject_id }, generation: Number(row.generation), scope: 'system',
          status: revoked ? 'revoked' : expired ? 'expired' : 'active', effective,
          effective_reason_code: revoked ? 'grant_revoked' : expired ? 'grant_expired' : effective ? 'active' : 'ancestor_revoked',
          authority_node_id: row.authority_node_id, issuer: { type: row.issuer_type, id: row.issuer_id },
          origin_family_id: row.origin_family_id, origin_attempt_id: row.issuer_attempt_id, reason: row.reason, revocation_reason: row.revoke_reason,
          created_at: new Date(Number(row.created_at_ms)).toISOString(), expires_at: isoTime(row.expires_at_ms),
          revoked_at: isoTime(row.revoked_at_ms), revision: Number(row.revision),
        };
      }),
    }));
  }

  listRootRuntimeTrust(proof: CredentialProof, options: { cursor: string; limit: number; runtimeId: string; status: string }): ListRootRuntimeTrustResponse {
    const { cursor, limit, runtimeId, status } = options;
    const stamp = Date.now();
    const load = () => this.db.query(`SELECT t.*, n.expires_at_ms FROM multiremi_runtime_trusts t
      JOIN multiremi_authority_nodes n ON n.node_id=t.authority_node_id WHERE t.trust_id>? AND (?='' OR t.runtime_id=?)
      AND (?='' OR ?=CASE WHEN t.revoked_at_ms IS NOT NULL THEN 'revoked' WHEN n.expires_at_ms<=? THEN 'expired' ELSE 'active' END)
      ORDER BY t.trust_id LIMIT ?`).all(cursor, runtimeId, runtimeId, status, status, stamp, limit + 1);
    return this.readControl(proof, 'root.runtime-trust.list', load, row => `management:runtime:${row.runtime_id}`, (tx, current, rows) => ({
      security_revision: current.checkedRevision, next_cursor: rows.length > limit ? rows[limit - 1].trust_id : null,
      trusts: rows.slice(0, limit).map(row => this.projectRuntimeTrust(tx, row, stamp)),
    }));
  }

  readRootRuntimeTrust(proof: CredentialProof, runtimeId: string): GetRootRuntimeTrustResponse {
    const load = () => this.db.query('SELECT * FROM multiremi_runtime_trusts WHERE runtime_id=? ORDER BY generation DESC').all(runtimeId);
    return this.readControl(proof, 'root.runtime-trust.get', load, () => `management:runtime:${runtimeId}`, (tx, current, rows) => {
      if (!this.db.query('SELECT id FROM multiremi_runtimes WHERE id=?').get(runtimeId)) throw new RootManagementRequestError(404, 'Runtime not found');
      const history = rows.map(row => this.projectRuntimeTrust(tx, row, Date.now()));
      return { runtime_id: runtimeId, security_revision: current.checkedRevision, history, active_trust: history.find(trust => trust.effective) ?? null };
    });
  }

  private projectRuntimeTrust(tx: SecurityTx, row: { record_json: string; challenge_id: string; authority_node_id: string }, stamp: number): RootRuntimeTrustRecord {
    const trust = JSON.parse(row.record_json) as RootRuntimeTrustRecord;
    const expired = trust.expires_at !== null && Date.parse(trust.expires_at) <= stamp;
    const effective = trust.status === 'active' && !expired
      && recordedMachineBindingIsCurrent(this.db, tx, trust.runtime_id, row.challenge_id)
      && grantAncestryIsCurrent(this.db, tx, trust.runtime_id, { nodeId: row.authority_node_id, generation: trust.generation }, 'runtime');
    return { ...trust, effective, status: trust.status === 'active' && expired ? 'expired' : trust.status,
      effective_reason_code: effective ? 'active' : trust.status === 'revoked' ? 'trust_revoked' : expired ? 'trust_expired' : 'runtime_untrusted' };
  }

  listRootAudit(proof: CredentialProof, options: { cursor: number; limit: number; action: string; targetId: string; actorId: string }): ListRootAuditResponse {
    const { cursor, limit, action, targetId, actorId } = options;
    const load = () => this.db.query(`SELECT e.*, n.subject_type, COALESCE(j.credential_id,b.credential_id) AS credential_id,
      COALESCE(j.family_id,b.family_id) AS family_id, COALESCE(t.task_id,d.attempt_id) AS task_id FROM multiremi_root_management_events e
      LEFT JOIN multiremi_authority_nodes n ON n.node_id=e.proof_node_id
      LEFT JOIN multiremi_jwt_materials j ON j.authority_node_id=e.proof_node_id
      LEFT JOIN multiremi_credential_version_bindings b ON b.authority_node_id=e.proof_node_id
      LEFT JOIN multiremi_access_tokens t ON t.id=b.credential_id LEFT JOIN multiremi_delegated_pats p ON p.credential_id=t.id
      LEFT JOIN multiremi_durable_delegations d ON d.node_id=p.origin_node_id WHERE e.revision_after<?
      AND (?='' OR e.action=?) AND (?='' OR e.target_id=?) AND (?='' OR e.actor_user_id=?) ORDER BY e.revision_after DESC LIMIT ?`)
      .all(cursor, action, action, targetId, targetId, actorId, actorId, limit + 1);
    return this.readControl(proof, 'root.audit.list', load, () => null, (_tx, current, rows) => ({
      security_revision: current.checkedRevision, next_cursor: rows.length > limit ? String(rows[limit - 1].revision_after) : null,
      entries: rows.slice(0, limit).map(row => {
        const result = JSON.parse(row.result_json);
        const targetType = row.action === 'bootstrap.jwt-domain.register' ? 'jwt_signing_domain' : row.action === 'root.grant.create' ? (result.grant?.subject?.type ?? 'user')
          : row.action === 'root.grant.revoke' ? 'grant' : row.action === 'root.runtime-trust.grant' ? 'runtime'
          : row.action === 'root.runtime-trust.revoke' ? 'runtime_trust' : row.action==='root.delegation.revoke' ? 'durable_delegation' : 'credential_family';
        return { id: String(row.revision_after), action: row.action, actor: { type: row.subject_type === 'agent' ? 'agent' : 'user', id: row.actor_user_id },
          credential_id: row.credential_id, family_id: row.family_id, origin_attempt_id: row.task_id,
          grant_id: row.actor_grant_id, grant_generation: Number(row.actor_generation), target_type: targetType, target_id: row.target_id,
          scope: 'system', before_revision: Number(row.revision_before), after_revision: Number(row.revision_after), reason_code: row.reason_code,
          reason: row.reason, outcome: 'allowed', cleanup_batch_id: result.cleanup_batch_id ?? null,
          created_at: new Date(Number(row.created_at_ms)).toISOString() };
      }),
    }));
  }

  private taskIsEligible(tx: SecurityTx, material: ReturnType<RegisteredCredentialProofs['requireCurrent']>, grant: NonNullable<CurrentAuthority['recordedGrant']>): boolean {
    if (!material.attemptId) return false;
    if (this.db.query('SELECT revision FROM multiremi_attempt_security_revocations WHERE attempt_id=?').get(material.attemptId)) return false;
    const entry = readAttemptEligibility(this.db,tx,material.attemptId);
    if (entry?.eligibility!=='root' || entry.subject_id!==material.subject.id || entry.grant_id!==grant.grantId || Number(entry.grant_generation)!==grant.generation) return false;
    this.requireFrozenExecution(tx,grant.grantId,grant.generation,entry.subject_id,Number(entry.config_epoch),{id:entry.runtime_trust_id,version:Number(entry.runtime_trust_version)});
    const receipt = this.db.query(`SELECT * FROM multiremi_delivery_receipts WHERE attempt_id=? AND credential_id=? AND material_version=?`)
      .get(material.attemptId,material.credential.id,material.credential.version);
    if (!receipt) return false;
    const tuple = JSON.parse(receipt.binding_json);
    const manifest = JSON.parse(entry.manifest_json);
    const approval = approvedAttemptSources(this.db,manifest);
    if (!approval || approval.row.attempt_id!==material.attemptId || approval.row.grant_id!==grant.grantId
      || Number(approval.row.grant_generation)!==grant.generation || `sha256:${digest(approval.row.manifest_snapshot)}`!==manifest.digest) return false;
    for (const source of approval.sources) assertUnrevokedAncestry(this.db,tx,{nodeId:source.id,generation:source.version});
    if (tuple.grant_id!==grant.grantId || tuple.grant_generation!==grant.generation || tuple.runtime_id!==entry.runtime_id || tuple.daemon_id!==entry.daemon_id
      || tuple.incarnation!==entry.incarnation || tuple.execution_digest!==entry.execution_digest || tuple.execution_config_epoch!==Number(entry.config_epoch)
      || tuple.input_revision!==manifest.version || tuple.input_digest!==manifest.digest
      || tuple.checkpoint_digest!==JSON.parse(approval.row.manifest_snapshot).inputs.providerState.checkpointDigest) return false;
    const trust = this.db.query(`SELECT authority_node_id,challenge_id FROM multiremi_runtime_trusts WHERE trust_id=? AND generation=? AND runtime_id=?
      AND incarnation=? AND revoked_at_ms IS NULL`).get(entry.runtime_trust_id,entry.runtime_trust_version,entry.runtime_id,entry.incarnation);
    if (!trust || !recordedMachineBindingIsCurrent(this.db,tx,entry.runtime_id,trust.challenge_id,tuple)
      || !grantAncestryIsCurrent(this.db,tx,entry.runtime_id,{nodeId:trust.authority_node_id,generation:Number(entry.runtime_trust_version)},'runtime')) return false;
    const lease = readCurrentTaskLease(this.db,tx,material.attemptId);
    return matchesDeliveryLease(lease,tuple,receipt) && (receipt.run_state!=='pending_start' || Date.parse(receipt.start_deadline)>Date.now());
  }

  private hasHumanGrantOrigins(nodeId: string): boolean {
    const invalid = this.db.query(`WITH RECURSIVE origins(id) AS (
      SELECT node_id FROM multiremi_authority_nodes WHERE node_id=?
      UNION SELECT e.parent_id FROM multiremi_authority_edges e JOIN origins o ON o.id=e.child_id WHERE e.dependency='continuous'
    ) SELECT n.node_id FROM origins o JOIN multiremi_authority_nodes n ON n.node_id=o.id
      LEFT JOIN multiremi_root_grants g ON g.authority_node_id=n.node_id AND g.subject_id=n.subject_id
        AND g.subject_type=n.subject_type AND g.generation=n.generation AND g.scope=n.scope
      WHERE n.kind='grant' AND (g.grant_id IS NULL OR NOT (
        (g.issuer_type='deployment' AND EXISTS (SELECT 1 FROM multiremi_root_bootstrap_authorizations b
          JOIN multiremi_authority_nodes credential ON credential.node_id=b.proof_node_id AND credential.kind='password'
            AND credential.subject_type='user' AND credential.subject_id=b.user_id
          JOIN multiremi_authority_edges e ON e.child_id=n.node_id AND e.dependency='continuous'
          JOIN multiremi_authority_nodes p ON p.node_id=e.parent_id AND p.kind='deployment_origin' AND p.subject_type='deployment'
          WHERE b.grant_id=g.grant_id AND b.user_id=g.subject_id AND b.deployment_id=g.issuer_id AND p.subject_id=b.deployment_id
            AND b.consumed_at_ms IS NOT NULL AND b.consumed_at_ms<b.expires_at_ms AND b.revision_after=n.revision))
        OR (g.issuer_type='user' AND EXISTS (SELECT 1 FROM multiremi_root_management_events audit
          JOIN multiremi_root_grants issuer ON issuer.grant_id=audit.actor_grant_id AND issuer.generation=audit.actor_generation
            AND issuer.subject_type='user' AND issuer.subject_id=g.issuer_id
          JOIN multiremi_authority_edges parent ON parent.child_id=n.node_id AND parent.parent_id=issuer.authority_node_id AND parent.dependency='continuous'
          JOIN multiremi_authority_edges proof ON proof.child_id=n.node_id AND proof.parent_id=audit.proof_node_id AND proof.dependency='continuous'
          JOIN multiremi_authority_nodes source ON source.node_id=proof.parent_id AND source.subject_type='user' AND source.subject_id=g.issuer_id
            AND ((source.kind='password' AND g.issuer_credential_id IS NULL AND g.origin_family_id IS NULL)
              OR EXISTS (SELECT 1 FROM multiremi_jwt_materials material WHERE material.authority_node_id=source.node_id
                AND material.credential_id=g.issuer_credential_id AND material.family_id=g.origin_family_id AND material.subject_type='user'
                AND material.subject_id=g.issuer_id AND material.purpose='dashboard' AND material.authority_generation=source.generation)
              OR EXISTS (SELECT 1 FROM multiremi_credential_version_bindings binding WHERE binding.authority_node_id=source.node_id
                AND binding.credential_id=g.issuer_credential_id AND binding.family_id=g.origin_family_id AND binding.subject_type='user'
                AND binding.subject_id=g.issuer_id AND binding.credential_type='pat' AND binding.authority_generation=source.generation))
          WHERE audit.action='root.grant.create' AND audit.target_id=g.subject_id AND audit.actor_user_id=g.issuer_id AND audit.revision_after=n.revision))
        OR (g.issuer_type='agent' AND EXISTS (SELECT 1 FROM multiremi_root_management_events audit
          JOIN multiremi_durable_delegations d ON d.issuer_agent_id=g.issuer_id AND d.attempt_id=g.issuer_attempt_id
            AND d.issuer_grant_id=audit.actor_grant_id AND d.issuer_generation=audit.actor_generation
          JOIN multiremi_authority_edges parent ON parent.child_id=n.node_id AND parent.dependency='continuous'
          WHERE audit.action='root.grant.create' AND audit.target_id=g.subject_id AND audit.actor_user_id=g.issuer_id AND audit.revision_after=n.revision
            AND ((parent.parent_id=d.node_id AND d.action='root.grant.create' AND d.credential_id=g.issuer_credential_id AND d.family_id=g.origin_family_id
              AND d.beneficiary_id=g.subject_id AND d.beneficiary_type=g.subject_type AND EXISTS (SELECT 1 FROM multiremi_authority_edges evidence
              WHERE evidence.child_id=d.node_id AND evidence.dependency='evidence' AND evidence.parent_id=audit.proof_node_id))
            OR (parent.parent_id=audit.proof_node_id AND EXISTS (SELECT 1 FROM multiremi_delegated_pats p JOIN multiremi_credential_version_bindings v
              ON v.credential_id=p.credential_id AND v.family_id=p.family_id WHERE p.origin_node_id=d.node_id AND p.family_id=g.origin_family_id
              AND p.credential_id=g.issuer_credential_id AND v.authority_node_id=audit.proof_node_id)))))
      )) LIMIT 1`).get(nodeId);
    return !invalid;
  }

  authorizeWrite(tx: SecurityTx, proof: CredentialProof, request: AuthorityUse): Actor {
    return withSecurityTarget(this.db, tx, `management:${request.actualTarget.type}:${request.actualTarget.id}`, () => {
      const authority = onPrimary(() => this.check(tx, proof, request));
      if (!authority.effectiveRoot) throw new SecurityAbort('root_required');
      const actor = Object.freeze(authority) as Actor;
      this.actors.set(actor, { tx, proof, action: request.action, target: request.actualTarget.id, targetType:request.actualTarget.type,use:request.use });
      return actor;
    });
  }

  requireMutationActor(tx:SecurityTx, actor:Actor, request:AuthorityUse): CurrentAuthority {
    return withSecurityTarget(this.db,tx,`management:${request.actualTarget.type}:${request.actualTarget.id}`,()=>{
      const bound = this.actors.get(actor);
      if (!bound || bound.tx!==tx || bound.action!==request.action || bound.targetType!==request.actualTarget.type
        || bound.target!==request.actualTarget.id || bound.use!==request.use || request.use==='read') throw new SecurityAbort('root_required');
      const current = this.check(tx,bound.proof,request);
      if (!current.effectiveRoot) throw new SecurityAbort('root_required');
      return current;
    });
  }

  guardProtectedMutation(tx: SecurityTx, actor: Actor | null, request: AuthorityUse, expectedVersion: number): void {
    const {type,id} = request.actualTarget;
    withSecurityTarget(this.db,tx,`management:${type}:${id}`,()=>{
      const affected = this.db.query(`SELECT DISTINCT g.grant_id,g.subject_id,g.authority_node_id,g.generation,r.resource_version FROM multiremi_agent_grant_protected_refs r
        JOIN multiremi_agent_grant_dependencies d ON d.grant_id=r.grant_id AND d.invalidated_revision IS NULL
        JOIN multiremi_root_grants g ON g.grant_id=d.grant_id AND g.generation=d.grant_generation AND g.revoked_at_ms IS NULL
        JOIN multiremi_root_subject_state s ON s.active_grant_id=g.grant_id AND s.generation_counter=g.generation
        WHERE r.kind=? AND r.resource_id=? ORDER BY g.grant_id`).all(type,id);
      const snapshots=this.db.query(`SELECT DISTINCT agent_id,resource_version FROM multiremi_current_agent_source_snapshots WHERE kind=? AND resource_id=?`).all(type,id);
      if (!affected.length && !snapshots.length) return;
      if (!actor || request.use!=='write') throw new SecurityAbort('root_required');
      this.requireMutationActor(tx,actor,request);
      if (!Number.isSafeInteger(expectedVersion) || [...affected,...snapshots].some(row=>Number(row.resource_version)!==expectedVersion)) {
        throw new SecurityAbort('authority_revision_conflict');
      }
      const revision = this.advanceSecurityRevision();
      for (const agentId of new Set([...affected.map(row=>row.subject_id),...snapshots.map(row=>row.agent_id)])) {
        const invalidated=this.db.query(`UPDATE multiremi_agent_config_epochs SET config_epoch=config_epoch+1 WHERE agent_id=? RETURNING approval_node_id`).get(agentId);
        if (invalidated) this.db.query(`UPDATE multiremi_authority_nodes SET revoked_at_ms=COALESCE(revoked_at_ms,?),revision=? WHERE node_id=?`).run(Date.now(),revision,invalidated.approval_node_id);
      }
      for (const row of affected) {
        this.db.query(`UPDATE multiremi_agent_grant_dependencies SET invalidated_revision=?,config_epoch=config_epoch+1 WHERE grant_id=? AND invalidated_revision IS NULL`).run(revision,row.grant_id);
        this.db.query(`UPDATE multiremi_authority_nodes SET revoked_at_ms=COALESCE(revoked_at_ms,?),revision=? WHERE node_id=? AND generation=?`).run(Date.now(),revision,row.authority_node_id,row.generation);
      }
    });
  }

  resolveDurableDelegation(tx: SecurityTx, actor: Actor, use: DelegationUse, beneficiary: GrantSubject): AuthorityNodeRef {
    return withSecurityTarget(this.db,tx,`management:${beneficiary.type}:${beneficiary.id}`,()=>{
      const current = this.requireMutationActor(tx,actor,use);
      if (current.transport!=='task' || current.subject?.type!=='agent' || !current.attemptId || !current.recordedGrant || !current.credentialOrigin
        || current.scope!=='system' || beneficiary.type!==use.actualTarget.type || beneficiary.id!==use.actualTarget.id
        || (use.action==='root.grant.create' ? use.use!=='management' : use.action!=='credential.pat.create' || use.use!=='write')
        || !use.idempotencyKey?.trim() || !Number.isSafeInteger(use.expiresAtMs) || use.expiresAtMs<=Date.now() || !/^[a-f0-9]{64}$/.test(use.requestDigest)) {
        throw new SecurityAbort('root_required');
      }
      const target = beneficiary.type==='agent' ? this.db.query('SELECT id FROM multiremi_agents WHERE id=? AND archived_at IS NULL').get(beneficiary.id)
        : this.db.query('SELECT id FROM multiremi_users WHERE id=?').get(beneficiary.id);
      if (!target || use.action==='credential.pat.create' && beneficiary.type==='agent' && beneficiary.id!==current.subject.id) throw new SecurityAbort('root_required');
      const grant = current.recordedGrant, origin = current.credentialOrigin;
      const lease = readCurrentTaskLease(this.db,tx,current.attemptId);
      const entry = readAttemptEligibility(this.db,tx,current.attemptId);
      if (!lease || lease.state!=='running' || entry?.eligibility!=='root' || entry.subject_id!==current.subject.id || entry.grant_id!==grant.grantId
        || Number(entry.grant_generation)!==grant.generation) throw new SecurityAbort('root_authority_revoked');
      const approval = approvedAttemptSources(this.db,JSON.parse(entry.manifest_json));
      const trust = this.db.query(`SELECT authority_node_id FROM multiremi_runtime_trusts WHERE trust_id=? AND generation=? AND incarnation=? AND revoked_at_ms IS NULL`)
        .get(entry.runtime_trust_id,entry.runtime_trust_version,entry.incarnation);
      if (!approval || !trust) throw new SecurityAbort('root_authority_revoked');
      const binding = digest(JSON.stringify([use.requestDigest,use.expiresAtMs,current.attemptId,origin.credential.id,origin.credential.version,
        origin.familyId,lease.consumer_id,Number(lease.run_generation),lease.lease_id,lease.fence_term]));
      const key = [grant.grantId,grant.generation,use.action,beneficiary.type,beneficiary.id,use.idempotencyKey];
      const prior = this.db.query(`SELECT d.node_id,d.request_digest,n.revoked_at_ms,n.expires_at_ms FROM multiremi_durable_delegations d JOIN multiremi_authority_nodes n
        ON n.node_id=d.node_id WHERE issuer_grant_id=? AND issuer_generation=? AND action=? AND beneficiary_type=? AND beneficiary_id=? AND idempotency_key=?`).get(...key);
      if (prior && (prior.request_digest!==binding || prior.revoked_at_ms!==null || Number(prior.expires_at_ms)<=Date.now())) throw new SecurityAbort('authority_revision_conflict');
      const parents = [{id:grant.authorityNodeId,version:grant.generation},...approval.sources];
      for (const source of parents) {
        if (assertUnrevokedAncestry(this.db,tx,{nodeId:source.id,generation:source.version})<use.expiresAtMs) throw new SecurityAbort('root_authority_revoked');
      }
      if (!grantAncestryIsCurrent(this.db,tx,entry.runtime_id,{nodeId:trust.authority_node_id,generation:Number(entry.runtime_trust_version)},'runtime')) {
        throw new SecurityAbort('root_authority_revoked');
      }
      if (prior) return {nodeId:prior.node_id,generation:1};
      const nodeId = this.newNode('durable_delegation','agent',current.subject.id,1,current.checkedRevision,use.expiresAtMs,
        [...new Set([...parents.map(parent=>parent.id),trust.authority_node_id])]);
      this.db.query(`INSERT INTO multiremi_authority_edges SELECT c.node_id,c.generation,c.issued_seq,p.node_id,p.generation,p.issued_seq,'evidence'
        FROM multiremi_authority_nodes c CROSS JOIN multiremi_authority_nodes p WHERE c.node_id=? AND p.node_id=?`).run(nodeId,origin.node.nodeId);
      this.db.query(`INSERT INTO multiremi_durable_delegations(node_id,issuer_agent_id,attempt_id,run_id,run_generation,lease_id,fence_term,credential_id,
        material_version,family_id,request_digest,issuer_grant_id,issuer_generation,action,beneficiary_type,beneficiary_id,idempotency_key)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(nodeId,current.subject.id,current.attemptId,lease.consumer_id,lease.run_generation,lease.lease_id,lease.fence_term,
          origin.credential.id,origin.credential.version,origin.familyId,binding,...key);
      return {nodeId,generation:1};
    });
  }

  revokeDurableDelegation(tx: SecurityTx, actor: Actor, nodeId: string, input: RevokeRootGrantRequest): number {
    const use={action:'root.delegation.revoke',use:'management',actualTarget:{type:'durable_delegation',id:nodeId}};
    return withSecurityTarget(this.db,tx,`management:durable_delegation:${nodeId}`,()=>{
      const current=this.requireMutationActor(tx,actor,use);
      if (!current.subject || !current.recordedGrant || !input.reason?.trim() || !input.idempotency_key?.trim() || !input.reason_code
        || !ROOT_SECURITY_REVOKE_REASONS.includes(input.reason_code)) throw new SecurityAbort('root_required');
      const source=current.credentialOrigin?.node ?? this.passwordOrigin(this.actors.get(actor)!.proof);
      const payload=digest(JSON.stringify([current.subject,current.recordedGrant,source,nodeId,input.reason,input.reason_code,input.expected_revision]));
      const key=[current.subject.id,use.action,nodeId,input.idempotency_key];
      const prior=this.db.query(`SELECT payload_digest,revision_after FROM multiremi_root_management_events WHERE actor_user_id=? AND action=? AND target_id=? AND idempotency_key=?`).get(...key);
      if (prior) {
        if (prior.payload_digest!==payload) throw new SecurityAbort('authority_revision_conflict');
        return Number(prior.revision_after);
      }
      if (input.expected_revision!==current.checkedRevision) throw new SecurityAbort('authority_revision_conflict');
      const revision=this.advanceSecurityRevision(), now=Date.now();
      if (!this.db.query(`UPDATE multiremi_authority_nodes SET revoked_at_ms=?,revision=? WHERE node_id=? AND kind='durable_delegation' AND revoked_at_ms IS NULL
        AND EXISTS(SELECT 1 FROM multiremi_durable_delegations WHERE node_id=?) RETURNING node_id`).get(now,revision,nodeId,nodeId)) throw new SecurityAbort('authority_revision_conflict');
      this.db.query(`INSERT INTO multiremi_root_management_events(actor_user_id,action,target_id,idempotency_key,payload_digest,proof_node_id,actor_grant_id,
        actor_generation,reason,reason_code,revision_before,revision_after,created_at_ms,result_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'{}')`)
        .run(...key,payload,source.nodeId,current.recordedGrant.grantId,current.recordedGrant.generation,input.reason,input.reason_code,current.checkedRevision,revision,now);
      return revision;
    });
  }

  revokeAttemptDelegations(tx: SecurityTx, attemptId: string, reason: typeof ROOT_SECURITY_REVOKE_REASONS[number]): void {
    withSecurityTarget(this.db,tx,`attempt:${attemptId}`,()=>{
      if (!ROOT_SECURITY_REVOKE_REASONS.includes(reason) || readAttemptEligibility(this.db,tx,attemptId)?.eligibility!=='root') throw new SecurityAbort('root_required');
      if (this.db.query('SELECT revision FROM multiremi_attempt_security_revocations WHERE attempt_id=?').get(attemptId)) return;
      const now = Date.now(), revision = this.advanceSecurityRevision();
      this.db.query(`INSERT INTO multiremi_attempt_security_revocations(attempt_id,reason,revision,revoked_at_ms) VALUES(?,?,?,?)`).run(attemptId,reason,revision,now);
      this.db.query(`UPDATE multiremi_authority_nodes SET revoked_at_ms=?,revision=? WHERE revoked_at_ms IS NULL AND node_id IN
        (SELECT node_id FROM multiremi_durable_delegations WHERE attempt_id=?)`).run(now,revision,attemptId);
    });
  }

  private requireFrozenExecution(tx: SecurityTx, grantId: string, generation: number, agentId: string, epoch: number, trust: VersionedRef, resolve = false): void {
    const row = this.db.query(`SELECT * FROM multiremi_agent_grant_dependencies WHERE grant_id=?`).get(grantId);
    if (!row || row.invalidated_revision!==null || Number(row.config_epoch)!==epoch || row.agent_id!==agentId || Number(row.grant_generation)!==generation) {
      throw new SecurityAbort('root_authority_revoked');
    }
    const frozen: VersionedRef[] = JSON.parse(row.trust_versions_json);
    if (!frozen.some(item=>item.id===trust.id && item.version===trust.version)) throw new SecurityAbort('root_authority_revoked');
    if (!resolve) return;
    const current = requireAgentDependencySnapshot(this.resolveAgentDependencies,tx,agentId,frozen.map(item=>item.id),row.dependency_digest);
    if (current.configEpoch!==epoch || !current.trustVersions.some(item=>item.id===trust.id && item.version===trust.version)
      || !frozen.every(item=>current.trustVersions.some(live=>live.id===item.id && live.version===item.version))) throw new SecurityAbort('root_authority_revoked');
    const refs=this.db.query(`SELECT kind,resource_id,resource_version,digest,use_kind FROM multiremi_agent_grant_protected_refs WHERE grant_id=?`).all(grantId);
    if (refs.length!==current.refs.length || !refs.every(ref=>current.refs.some(live=>live.kind===ref.kind && live.id===ref.resource_id
      && live.version===Number(ref.resource_version) && live.digest===ref.digest && live.use===ref.use_kind))) throw new SecurityAbort('root_authority_revoked');
  }

  private retryOrigin(tx: SecurityTx, proof: CredentialProof, target: AttemptTarget): Readonly<RetryOrigin> {
    return withSecurityTarget(this.db,tx,`management:turn:${target.turnId}`,()=>onPrimary(()=>{
      const initial=target.previousAttemptId===null;
      const action=initial?'turn.create':'turn.retry';
      const actor = this.check(tx,proof,{action,use:'invocation',actualTarget:{type:'turn',id:target.turnId}},true);
      if (!actor.effectiveRoot || !actor.subject || !actor.recordedGrant) throw new SecurityAbort('root_required');
      const source = actor.credentialOrigin?.node ?? this.passwordOrigin(proof);
      if (!this.db.query(`UPDATE multiremi_turns SET current_attempt_id=current_attempt_id WHERE id=? AND current_attempt_id=? RETURNING id`)
        .get(target.turnId,target.previousAttemptId??target.attemptId)) throw new SecurityAbort('authority_revision_conflict');
      const row = this.db.query(`SELECT t.workspace_id,t.session_id,t.execution_scope,t.agent_id,s.issue_id,s.chat_id
        FROM multiremi_turns t LEFT JOIN multiremi_turn_attempts a ON a.id=t.current_attempt_id AND a.turn_id=t.id
        JOIN multiremi_agents g ON g.id=t.agent_id AND g.workspace_id=t.workspace_id AND g.archived_at IS NULL
        JOIN multiremi_issue_sessions s ON s.id=t.session_id AND s.workspace_id=t.workspace_id AND s.status='active'
        LEFT JOIN multiremi_issues issue ON issue.id=s.issue_id AND issue.workspace_id=t.workspace_id AND issue.archived_at IS NULL
        LEFT JOIN multiremi_chat_sessions chat ON chat.id=s.chat_id AND chat.workspace_id=t.workspace_id
        WHERE t.id=? AND ${initial?'NOT EXISTS(SELECT 1 FROM multiremi_turn_attempts old WHERE old.turn_id=t.id)':"a.status IN ('lost','failed')"} AND t.status NOT IN ('completed','cancelled')
          AND ((s.chat_id IS NULL AND issue.id IS NOT NULL) OR (s.chat_id IS NOT NULL AND chat.id IS NOT NULL))
          AND NOT EXISTS(SELECT 1 FROM multiremi_turn_attempts WHERE id=?)`).get(target.turnId,target.attemptId);
      if (!row || !target.attemptId || (target.previousAttemptId===null && (target.agentId!==row.agent_id || target.workspaceId!==row.workspace_id || target.sessionId!==row.session_id))) throw new SecurityAbort('authority_revision_conflict');
      return Object.freeze({action,turnId:target.turnId,previousAttemptId:target.previousAttemptId,attemptId:target.attemptId,
        workspaceId:String(row.workspace_id),sessionId:String(row.session_id),sessionOwnerType:row.chat_id?'chat':'issue',sessionOwnerId:String(row.chat_id??row.issue_id),
        executionScope:String(row.execution_scope),agentId:String(row.agent_id),actorId:actor.subject.id,proofNodeId:source.nodeId,
        proofGeneration:source.generation,grantId:actor.recordedGrant.grantId,grantGeneration:actor.recordedGrant.generation});
    }));
  }

  planDirectRetry(proof: CredentialProof, target: RetryTarget) {
    const plan = this.plan(proof,{action:'turn.retry',use:'invocation',actualTarget:{type:'turn',id:target.turnId}});
    const turn = onPrimary(()=>this.db.query('SELECT workspace_id FROM multiremi_turns WHERE id=?').get(target.turnId));
    if (!turn) throw new RootManagementRequestError(404,'Turn not found');
    return {...plan,workspaceIds:[String(turn.workspace_id)],domainTargets:[...plan.domainTargets,`attempt:${target.attemptId}`].sort()};
  }

  private passwordOrigin(proof:CredentialProof) {
    const evidence=this.evidence(proof);
    return {nodeId:evidence.node,generation:evidence.version};
  }

  planAttemptAdmission(proof:CredentialProof,target:AttemptTarget,execution:FinalExecution) {
    if (target.attemptId!==execution.attemptId) throw new SecurityAbort('authority_revision_conflict');
    const base = target.previousAttemptId===null ? {...this.plan(proof,{action:'turn.create',use:'invocation',actualTarget:{type:'turn',id:target.turnId}}),workspaceIds:[target.workspaceId]} : this.planDirectRetry(proof,target);
    const agent = target.previousAttemptId===null ? {agent_id:target.agentId} : this.db.query('SELECT agent_id FROM multiremi_turns WHERE id=?').get(target.turnId);
    const subject = this.db.query(`SELECT g.authority_node_id FROM multiremi_root_subject_state s JOIN multiremi_root_grants g ON g.grant_id=s.active_grant_id
      WHERE s.subject_type='agent' AND s.subject_id=?`).get(agent.agent_id);
    const trust = this.db.query(`SELECT authority_node_id FROM multiremi_runtime_trusts WHERE runtime_id=? AND incarnation=? AND revoked_at_ms IS NULL`)
      .get(execution.runtimeId,execution.incarnation);
    const targets = [...base.domainTargets,`attempt:${execution.attemptId}`,`management:attempt:${execution.attemptId}`,`management:runtime:${execution.runtimeId}`,`management:agent:${agent.agent_id}`,`grant:agent:${agent.agent_id}`];
    if (subject) {
      const dependencies=this.db.query(`SELECT d.trust_versions_json FROM multiremi_agent_grant_dependencies d JOIN multiremi_root_grants g ON g.grant_id=d.grant_id
        WHERE g.authority_node_id=?`).get(subject.authority_node_id);
      for (const ref of JSON.parse(dependencies?.trust_versions_json??'[]')) {
        const runtime=this.db.query('SELECT runtime_id FROM multiremi_runtime_trusts WHERE trust_id=? AND generation=?').get(ref.id,ref.version);
        if (runtime) targets.push(`management:runtime:${runtime.runtime_id}`);
      }
    }
    for (const node of [subject?.authority_node_id,trust?.authority_node_id,execution.providerTrust.id,execution.checkpointTrust?.id]) {
      if (node) targets.push(`authority:${node}`);
    }
    return {...base,domainTargets:[...new Set(targets)].sort()};
  }

  verifyDirectRetryInvocation(tx: SecurityTx, proof: CredentialProof, target: RetryTarget): Invocation {
    if (!target.previousAttemptId) return abortSecurityWrite(this.db,tx,'root_required');
    return this.verifyAttemptInvocation(tx,proof,target);
  }

  verifyAttemptInvocation(tx: SecurityTx, proof: CredentialProof, target: AttemptTarget): Invocation {
    return withSecurityTarget(this.db,tx,`attempt:${target.attemptId}`,()=>{
      const origin = this.retryOrigin(tx,proof,target);
      const invocation = Object.freeze({}) as Invocation;
      this.directRetries.set(invocation,{tx,proof,origin});
      return invocation;
    });
  }

  requireDirectRetryInvocation(tx: SecurityTx, invocation: Invocation, target: RetryTarget): Readonly<RetryOrigin> {
    if (!target.previousAttemptId) return abortSecurityWrite(this.db,tx,'root_required');
    return this.requireAttemptInvocation(tx,invocation,target);
  }

  private requireAttemptInvocation(tx: SecurityTx, invocation: Invocation, target: AttemptTarget): Readonly<RetryOrigin> {
    return withSecurityTarget(this.db,tx,`attempt:${target.attemptId}`,()=>{
      const verified = this.directRetries.get(invocation);
      if (!verified || verified.tx!==tx) throw new SecurityAbort('root_authority_revoked');
      const current = this.retryOrigin(tx,verified.proof,target);
      if (JSON.stringify(current)!==JSON.stringify(verified.origin)) throw new SecurityAbort('authority_revision_conflict');
      return current;
    });
  }

  approveAttemptInputs(tx: SecurityTx, actor:Actor, invocation:Invocation, execution:FinalExecution, inputs:ApprovedExecutionInputs):InputManifest {
    return withSecurityTarget(this.db,tx,`attempt:${execution.attemptId}`,()=>{
      const request = {action:'attempt.inputs.approve',use:'write',actualTarget:{type:'attempt',id:execution.attemptId}};
      const current = this.requireMutationActor(tx,actor,request);
      const verified = this.directRetries.get(invocation);
      if (!verified || verified.tx!==tx || verified.origin.attemptId!==execution.attemptId || !current.recordedGrant) throw new SecurityAbort('root_required');
      const origin = this.requireAttemptInvocation(tx,invocation,verified.origin as AttemptTarget);
      const subject = {type:'agent',id:origin.agentId} as const;
      const grant = readRecordedGrant(this.db,tx,subject);
      const trust = this.db.query(`SELECT trust_id,generation FROM multiremi_runtime_trusts WHERE runtime_id=? AND incarnation=? AND revoked_at_ms IS NULL`).get(execution.runtimeId,execution.incarnation);
      if (!grant || !trust || !inputs.manifest.id || !Number.isSafeInteger(inputs.manifest.version) || inputs.manifest.version<1
        || !inputs.sourcePolicy.id || !Number.isSafeInteger(inputs.sourcePolicy.version) || inputs.sourcePolicy.version<1 || !inputs.providerState.securityDomainId
        || !/^(?:sha256:)?[a-f0-9]{64}$/.test(execution.executionDigest) || !Number.isSafeInteger(execution.configEpoch) || execution.configEpoch<0
        || (!!execution.checkpointTrust)!==(inputs.providerState.checkpointDigest!==null)) throw new SecurityAbort('root_required');
      const issuer = current.credentialOrigin?.node ?? this.passwordOrigin(this.actors.get(actor)!.proof);
      const snapshot = JSON.stringify({origin,execution,inputs});
      const manifest = {...inputs.manifest,digest:`sha256:${digest(snapshot)}`};
      this.db.query(`INSERT INTO multiremi_attempt_input_approvals(manifest_id,manifest_version,manifest_digest,manifest_snapshot,attempt_id,subject_id,
        grant_id,grant_generation,runtime_trust_id,runtime_trust_version,invocation_digest,execution_digest,config_epoch,provider_trust_json,
        checkpoint_trust_json,authority_node_id,authority_generation,issuer_grant_id,issuer_grant_generation,invoker_node_id,invoker_node_generation,
        invoker_grant_id,invoker_grant_generation) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(manifest.id,manifest.version,manifest.digest,snapshot,execution.attemptId,subject.id,grant.grantId,grant.generation,trust.trust_id,trust.generation,
          digest(JSON.stringify(origin)),execution.executionDigest,execution.configEpoch,JSON.stringify(execution.providerTrust),JSON.stringify(execution.checkpointTrust),
          issuer.nodeId,issuer.generation,current.recordedGrant.grantId,current.recordedGrant.generation,origin.proofNodeId,origin.proofGeneration,origin.grantId,origin.grantGeneration);
      return manifest;
    });
  }

  admitAttempt(tx: SecurityTx, subject: GrantSubject, invocation: Invocation, execution: FinalExecution, manifest: InputManifest): ReturnType<AuthorityKernel['admitAttempt']> {
    return withSecurityTarget(this.db,tx,`attempt:${execution.attemptId}`,()=>{
      if (this.db.query('SELECT id FROM multiremi_turn_attempts WHERE id=?').get(execution.attemptId)) throw new SecurityAbort('authority_revision_conflict');
      const state = this.db.query('SELECT feature_activation,security_revision FROM multiremi_security_state WHERE singleton=1').get();
      if (!state) throw new SecurityAbort('security_state_unavailable');
      const grant = readRecordedGrant(this.db,tx,subject);
      if (!grant || Number(state.feature_activation)!==1) return {eligibility:'none'};
      const verified = this.directRetries.get(invocation);
      if (!verified || verified.tx!==tx || subject.type!=='agent' || verified.origin.agentId!==subject.id || verified.origin.attemptId!==execution.attemptId) throw new SecurityAbort('root_required');
      const origin = this.requireAttemptInvocation(tx,invocation,verified.origin as AttemptTarget);
      if (!this.db.query(`SELECT node_id FROM multiremi_authority_nodes WHERE node_id=? AND generation=? AND subject_id=? AND subject_type='agent'
        AND kind='grant' AND scope='system'`).get(grant.authorityNodeId,grant.generation,subject.id) || !this.hasHumanGrantOrigins(grant.authorityNodeId)) throw new SecurityAbort('root_authority_revoked');
      assertUnrevokedAncestry(this.db,tx,{nodeId:grant.authorityNodeId,generation:grant.generation});
      const trust = this.db.query(`SELECT t.trust_id,t.generation,t.authority_node_id,t.challenge_id FROM multiremi_runtime_trusts t
        JOIN multiremi_machine_enrollments e ON e.incarnation=t.incarnation AND e.runtime_id=t.runtime_id AND e.retired_at_ms IS NULL
        WHERE t.runtime_id=? AND t.incarnation=? AND e.daemon_id=? AND t.revoked_at_ms IS NULL`).get(execution.runtimeId,execution.incarnation,execution.daemonId);
      if (!trust || !recordedMachineBindingIsCurrent(this.db,tx,execution.runtimeId,trust.challenge_id)) throw new SecurityAbort('root_authority_revoked');
      this.requireFrozenExecution(tx,grant.grantId,grant.generation,subject.id,execution.configEpoch,{id:trust.trust_id,version:Number(trust.generation)},true);
      assertUnrevokedAncestry(this.db,tx,{nodeId:trust.authority_node_id,generation:Number(trust.generation)});
      const approval = this.db.query(`SELECT * FROM multiremi_attempt_input_approvals WHERE manifest_id=? AND manifest_version=?
        AND manifest_digest=? AND attempt_id=? AND subject_id=? AND grant_id=? AND grant_generation=? AND runtime_trust_id=?
        AND runtime_trust_version=? AND invocation_digest=? AND execution_digest=? AND config_epoch=?`).get(manifest.id,manifest.version,manifest.digest,
        execution.attemptId,subject.id,grant.grantId,grant.generation,trust.trust_id,trust.generation,digest(JSON.stringify(origin)),execution.executionDigest,execution.configEpoch);
      if (!approval || `sha256:${digest(approval.manifest_snapshot)}`!==manifest.digest || !isDeepStrictEqual(JSON.parse(approval.provider_trust_json),execution.providerTrust)
        || !isDeepStrictEqual(JSON.parse(approval.checkpoint_trust_json),execution.checkpointTrust)) throw new SecurityAbort('root_required');
      const approved = approvedAttemptSources(this.db,manifest);
      if (!approved) throw new SecurityAbort('root_authority_revoked');
      for (const [kind,source] of [['provider_trust',execution.providerTrust],['checkpoint_trust',execution.checkpointTrust]] as const) {
        if (!source) continue;
        const bound = this.db.query(`WITH RECURSIVE ancestors(id) AS (SELECT node_id FROM multiremi_authority_nodes WHERE node_id=? AND generation=?
          AND kind=? AND subject_type='agent' AND subject_id=? UNION SELECT e.parent_id FROM multiremi_authority_edges e JOIN ancestors a ON a.id=e.child_id
          WHERE e.dependency='continuous') SELECT COUNT(*) AS matches FROM ancestors WHERE id IN (?,?)`)
          .get(source.id,source.version,kind,subject.id,grant.authorityNodeId,trust.authority_node_id);
        if (Number(bound?.matches)!==2) throw new SecurityAbort('root_authority_revoked');
      }
      for (const source of approved.sources) assertUnrevokedAncestry(this.db,tx,{nodeId:source.id,generation:source.version});
      const ticket = structuredClone({execution,manifest,grant,runtimeTrust:{id:trust.trust_id,version:Number(trust.generation)},
        invocation:{id:digest(JSON.stringify(origin)),version:origin.proofGeneration},admissionRevision:Number(state.security_revision)}) as AdmissionTicket;
      this.admissions.set(ticket,{tx,subject:{...subject},proof:verified.proof,origin,snapshot:structuredClone(ticket)});
      return {eligibility:'root',ticket};
    });
  }

  consumeAdmission(tx: SecurityTx, ticket: AdmissionTicket, inserted: FinalExecution, manifest: InputManifest): void {
    withSecurityTarget(this.db,tx,`attempt:${inserted.attemptId}`,()=>{
      const issued = this.admissions.get(ticket);
      if (!issued || issued.tx!==tx || !isDeepStrictEqual(ticket,issued.snapshot) || !isDeepStrictEqual(inserted,ticket.execution)
        || !isDeepStrictEqual(manifest,ticket.manifest)) throw new SecurityAbort('authority_revision_conflict');
      this.admissions.delete(ticket);
      const {grant,runtimeTrust,invocation,admissionRevision} = ticket;
      const actor=this.check(tx,issued.proof,{action:issued.origin.action,use:'invocation',actualTarget:{type:'turn',id:issued.origin.turnId}},true);
      const currentGrant=readRecordedGrant(this.db,tx,issued.subject);
      const trust=this.db.query(`SELECT authority_node_id,challenge_id FROM multiremi_runtime_trusts WHERE trust_id=? AND generation=?
        AND runtime_id=? AND incarnation=? AND revoked_at_ms IS NULL`).get(runtimeTrust.id,runtimeTrust.version,inserted.runtimeId,inserted.incarnation);
      const approval=approvedAttemptSources(this.db,manifest);
      if (!actor.effectiveRoot || actor.recordedGrant?.grantId!==issued.origin.grantId || actor.recordedGrant.generation!==issued.origin.grantGeneration
        || !isDeepStrictEqual(currentGrant,grant) || !approval || !trust || !recordedMachineBindingIsCurrent(this.db,tx,inserted.runtimeId,trust.challenge_id)) throw new SecurityAbort('root_authority_revoked');
      for (const source of [...approval.sources,{id:trust.authority_node_id,version:runtimeTrust.version},{id:grant.authorityNodeId,version:grant.generation}]) {
        assertUnrevokedAncestry(this.db,tx,{nodeId:source.id,generation:source.version});
      }
      const entry = this.db.query(`INSERT INTO multiremi_attempt_eligibility(attempt_id,eligibility,subject_type,subject_id,grant_id,grant_generation,
        runtime_trust_id,runtime_trust_version,invocation_json,manifest_json,runtime_id,daemon_id,incarnation,execution_digest,config_epoch,
        provider_trust_json,checkpoint_trust_json,admission_revision)
        SELECT a.id,'root','agent',t.agent_id,?,?,?,?,?,?,a.runtime_id,?,?,?,?,?,?,? FROM multiremi_turn_attempts a
        JOIN multiremi_turns t ON t.id=a.turn_id AND t.current_attempt_id=a.id JOIN multiremi_security_state s ON s.singleton=1
        WHERE a.id=? AND t.id=? AND t.agent_id=? AND a.runtime_id=? AND s.feature_activation=1 AND s.security_revision=? RETURNING attempt_id`)
        .get(grant.grantId,grant.generation,runtimeTrust.id,runtimeTrust.version,JSON.stringify(invocation),JSON.stringify(manifest),inserted.daemonId,
          inserted.incarnation,inserted.executionDigest,inserted.configEpoch,JSON.stringify(inserted.providerTrust),JSON.stringify(inserted.checkpointTrust),
          admissionRevision,inserted.attemptId,issued.origin.turnId,issued.subject.id,inserted.runtimeId,admissionRevision);
      if (!entry) throw new SecurityAbort('authority_revision_conflict');
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
      const result = this.insertGrant(tx, {type:'user',id:userId}, reason, null, expectedRevision, { type: 'deployment', id: deploymentId }, [origin]);
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

  planFirstOffer(candidate: PreparedRootDelivery) {
    return onPrimary(() => {
      const tuple = candidate.tuple;
      const row = this.db.query(`SELECT e.subject_id,e.manifest_json,t.workspace_id,g.authority_node_id AS grant_node,
        trust.authority_node_id AS trust_node FROM multiremi_attempt_eligibility e JOIN multiremi_root_grants g ON g.grant_id=e.grant_id
        JOIN multiremi_turn_attempts a ON a.id=e.attempt_id JOIN multiremi_turns t ON t.id=a.turn_id AND t.current_attempt_id=a.id
        JOIN multiremi_runtime_trusts trust ON trust.trust_id=e.runtime_trust_id WHERE e.attempt_id=? AND e.eligibility='root'`).get(tuple.attempt_id);
      const approval = row ? approvedAttemptSources(this.db,JSON.parse(row.manifest_json)) : null;
      const state = this.db.query(`SELECT security_revision FROM multiremi_security_state WHERE singleton=1`).get();
      if (!row || !approval || !state) throw new SecurityAbort('root_authority_revoked');
      const targets = [`attempt:${tuple.attempt_id}`,`receipt:${tuple.receipt_id}`,`grant:agent:${row.subject_id}`,`credential:${candidate.credentialId}`,
        `authority:${candidate.materialNodeId}`,`authority:${row.grant_node}`,`authority:${row.trust_node}`,`management:runtime:${tuple.runtime_id}`,
        ...approval.sources.map(source=>`authority:${source.id}`)];
      return { expectedRevision:Number(state.security_revision),workspaceIds:[String(row.workspace_id)],numberKeys:[],domainTargets:[...new Set(targets)].sort() };
    });
  }

  private issueDelegatedPat(tx: SecurityTx, input: DelegatedPatInput): IssuedCredential {
    const {candidate,actor,use,beneficiary} = input;
    return withSecurityTarget(this.db,tx,`credential:${candidate.credentialId}`,()=>{
      if (use.action!=='credential.pat.create') throw new SecurityAbort('root_required');
      const origin = this.resolveDurableDelegation(tx,actor,use,beneficiary);
      const issuer = this.db.query(`SELECT d.issuer_agent_id,a.workspace_id FROM multiremi_durable_delegations d JOIN multiremi_agents a ON a.id=d.issuer_agent_id
        WHERE d.node_id=? AND a.archived_at IS NULL`).get(origin.nodeId);
      if (!issuer || this.db.query('SELECT credential_id FROM multiremi_delegated_pats WHERE origin_node_id=?').get(origin.nodeId)) throw new SecurityAbort('credential_version_conflict');
      const subject: GrantSubject = {type:'agent',id:issuer.issuer_agent_id};
      const expiresAtMs = use.expiresAtMs, revision = this.advanceSecurityRevision();
      const familyNodeId = this.newNode('credential_family','agent',subject.id,1,revision,expiresAtMs,[origin.nodeId]);
      this.db.query(`INSERT INTO multiremi_credential_families(family_id,authority_node_id,max_expires_at_ms,revision) VALUES(?,?,?,?)`)
        .run(candidate.familyId,familyNodeId,expiresAtMs,revision);
      this.newNode('credential','agent',subject.id,1,revision,expiresAtMs,[familyNodeId],candidate.materialNodeId);
      this.db.query(`INSERT INTO multiremi_access_tokens(id,name,type,purpose,agent_id,workspace_id,token_hash,token_prefix,expires_at,created_at)
        VALUES(?,'Agent PAT','pat','personal',?,?,?,?,?,?)`).run(candidate.credentialId,subject.id,issuer.workspace_id,candidate.tokenHash,candidate.tokenPrefix,
          new Date(expiresAtMs).toISOString(),new Date().toISOString());
      const issued: IssuedCredential = {credential:{id:candidate.credentialId,version:1},node:{nodeId:candidate.materialNodeId,generation:1},familyId:candidate.familyId,
        subject,continuousParents:[{nodeId:familyNodeId,generation:1}],evidenceParents:[],expiresAtMs,material:candidate};
      persistIssuedMaterialBinding(this.db,tx,issued,{credentialId:candidate.credentialId,materialVersion:1,materialDigest:candidate.tokenHash,credentialType:'pat',purpose:'personal',subject});
      this.db.query(`INSERT INTO multiremi_delegated_pats(credential_id,origin_node_id,family_id) VALUES(?,?,?)`).run(candidate.credentialId,origin.nodeId,candidate.familyId);
      releasePatAfterCommit(this.db,tx,candidate);
      return issued;
    });
  }

  issue(tx: SecurityTx, input: IssueCredentialInput): IssuedCredential {
    if ('kind' in input && input.kind==='delegated-pat') return this.issueDelegatedPat(tx,input);
    const candidate = requireActivatingDelivery(this.db,tx,input);
    const tuple = candidate.tuple;
    return withSecurityTarget(this.db,tx,`credential:${candidate.credentialId}`,()=>{
      const entry = readAttemptEligibility(this.db,tx,tuple.attempt_id);
      const state = this.db.query(`SELECT feature_activation,security_revision FROM multiremi_security_state WHERE singleton=1`).get();
      if (Number(state?.feature_activation)!==1 || entry?.eligibility!=='root' || tuple.material_version!==1 || entry.runtime_id!==tuple.runtime_id
        || entry.daemon_id!==tuple.daemon_id || entry.incarnation!==tuple.incarnation || entry.execution_digest!==tuple.execution_digest
        || Number(entry.config_epoch)!==tuple.execution_config_epoch || entry.grant_id!==tuple.grant_id || Number(entry.grant_generation)!==tuple.grant_generation
        || this.db.query('SELECT receipt_id FROM multiremi_delivery_receipts WHERE attempt_id=?').get(tuple.attempt_id)) throw new SecurityAbort('root_authority_revoked');
      const subject: GrantSubject = {type:'agent',id:entry.subject_id};
      const grant = readRecordedGrant(this.db,tx,subject);
      const manifest = JSON.parse(entry.manifest_json);
      const approval = approvedAttemptSources(this.db,manifest);
      const trust = this.db.query(`SELECT authority_node_id,challenge_id FROM multiremi_runtime_trusts WHERE trust_id=? AND generation=?
        AND runtime_id=? AND incarnation=? AND revoked_at_ms IS NULL`).get(entry.runtime_trust_id,entry.runtime_trust_version,tuple.runtime_id,tuple.incarnation);
      if (grant?.grantId!==entry.grant_id || grant.generation!==Number(entry.grant_generation) || !this.hasHumanGrantOrigins(grant.authorityNodeId)
        || !approval || approval.row.attempt_id!==tuple.attempt_id || approval.row.grant_id!==grant.grantId || Number(approval.row.grant_generation)!==grant.generation
        || `sha256:${digest(approval.row.manifest_snapshot)}`!==manifest.digest || manifest.version!==tuple.input_revision || manifest.digest!==tuple.input_digest
        || JSON.parse(approval.row.manifest_snapshot).inputs.providerState.checkpointDigest!==tuple.checkpoint_digest || !trust
        || !recordedMachineBindingIsCurrent(this.db,tx,tuple.runtime_id,trust.challenge_id,tuple)) throw new SecurityAbort('root_authority_revoked');
      const run = this.db.query(`SELECT t.workspace_id FROM multiremi_turn_attempts a JOIN multiremi_turns t ON t.current_attempt_id=a.id AND t.id=a.turn_id
        JOIN multiremi_turn_execution_records e ON e.id=a.id AND e.status='dispatched' JOIN multiremi_usage_task_scopes s ON s.task_id=a.id
        AND s.workspace_id=t.workspace_id AND s.runtime_id=a.runtime_id AND s.agent_id=t.agent_id
        JOIN multiremi_usage_runs r ON r.task_id=a.id AND r.run_id=s.active_run_id AND r.complete=0
        WHERE a.id=? AND a.runtime_id=? AND t.agent_id=? AND r.run_id=? AND a.status='accepted'`).get(tuple.attempt_id,tuple.runtime_id,subject.id,tuple.consumer_id);
      if (!run) throw new SecurityAbort('root_authority_revoked');
      const parents = [{id:grant.authorityNodeId,version:grant.generation},{id:trust.authority_node_id,version:Number(entry.runtime_trust_version)},...approval.sources];
      const expiresAtMs = Date.parse(tuple.material_expires_at);
      for (const parent of parents) {
        const ceiling = assertUnrevokedAncestry(this.db,tx,{nodeId:parent.id,generation:parent.version});
        if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs<=Date.now() || expiresAtMs>ceiling) throw new SecurityAbort('root_authority_revoked');
      }
      const revision = Number(state.security_revision);
      this.newNode('credential_family','agent',subject.id,1,revision,expiresAtMs,[...new Set(parents.map(parent=>parent.id))],candidate.familyNodeId);
      this.db.query(`INSERT INTO multiremi_credential_families(family_id,authority_node_id,max_expires_at_ms,revision) VALUES(?,?,?,?)`)
        .run(candidate.familyId,candidate.familyNodeId,expiresAtMs,revision);
      this.newNode('credential','agent',subject.id,1,revision,expiresAtMs,[candidate.familyNodeId],candidate.materialNodeId);
      this.db.query(`INSERT INTO multiremi_access_tokens(id,name,type,purpose,task_id,agent_id,workspace_id,token_hash,token_prefix,expires_at,created_at)
        VALUES(?,'task','task','task',?,?,?,?,?,?,?)`).run(candidate.credentialId,tuple.attempt_id,subject.id,run.workspace_id,candidate.tokenHash,
          candidate.tokenPrefix,tuple.material_expires_at,new Date().toISOString());
      return {credential:{id:candidate.credentialId,version:1},subject,familyId:candidate.familyId,node:{nodeId:candidate.materialNodeId,generation:1},
        continuousParents:[{nodeId:candidate.familyNodeId,generation:1}],evidenceParents:[],expiresAtMs,material:candidate};
    });
  }

  enrollDeploymentMachine(deploymentProof: string, attestation: HostAttestation, binding: MachinePublicBinding, expectedGeneration: number): AuthorityNodeRef {
    return onPrimary(() => {
      const state = this.db.query('SELECT security_revision FROM multiremi_security_state WHERE singleton=1').get();
      const root = this.db.query('SELECT authority_node_id FROM multiremi_machine_deployment_roots WHERE deployment_id=?').get(binding.deploymentId);
      const runtime = this.db.query('SELECT workspace_id FROM multiremi_runtimes WHERE id=? AND daemon_id=?').get(binding.runtimeId,binding.daemonId);
      if (!state || !root || !runtime) throw new SecurityAbort('root_authority_revoked');
      const previous = this.db.query('SELECT authority_node_id FROM multiremi_machine_enrollments WHERE runtime_id=? AND retired_at_ms IS NULL').get(binding.runtimeId);
      const targets = [`authority:${root.authority_node_id}`,`machine:${binding.runtimeId}`];
      if (previous) targets.push(`authority:${previous.authority_node_id}`);
      return withSecurityWrite(this.db,undefined,{expectedRevision:Number(state.security_revision),workspaceIds:[runtime.workspace_id],numberKeys:[],domainTargets:targets.sort()},
        tx=>this.enrollMachine(tx,deploymentProof,attestation,binding,expectedGeneration));
    });
  }

  enrollMachine(tx: SecurityTx, deploymentProof: string, verifiedAttestation: HostAttestation, publicBinding: MachinePublicBinding,
    expectedGeneration: number): { nodeId: string; generation: number } {
    const binding = publicBinding;
    return withSecurityTarget(this.db, tx, `machine:${binding.runtimeId}`, () => {
      const origin = requireEnrollmentBinding(this.db, tx, deploymentProof, verifiedAttestation, binding, expectedGeneration);
      const prior = this.db.query(`SELECT * FROM multiremi_machine_enrollments WHERE runtime_id=? ORDER BY generation DESC LIMIT 1`).get(binding.runtimeId);
      if (Number(prior?.generation ?? 0) !== expectedGeneration || prior && prior.deployment_id !== binding.deploymentId) {
        throw new SecurityAbort('authority_revision_conflict');
      }
      if (prior && prior.retired_at_ms === null) this.retireEnrollmentGeneration(tx, prior.incarnation, prior.authority_node_id, expectedGeneration);
      const generation = expectedGeneration + 1;
      const revision = this.advanceSecurityRevision();
      const expiry = Math.min(binding.keyExpiresAtMs, verifiedAttestation.expiresAtMs);
      const nodeId = this.newNode('machine_registration','daemon',binding.daemonId,generation,revision,expiry,[origin]);
      this.db.query(`INSERT INTO multiremi_machine_enrollments(incarnation,deployment_id,consumer_id,runtime_id,daemon_id,credential_id,
        credential_digest,authority_node_id,generation,signing_spki,recipient_spki,recipient_key_id,key_expires_at_ms,isolation_verified_at_ms,
        immutable_carrier_verified_at_ms,attestation_expires_at_ms,attestation_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(binding.incarnation,binding.deploymentId,binding.consumerId,binding.runtimeId,binding.daemonId,binding.credentialId,
          binding.credentialDigest,nodeId,generation,binding.signingSpki,binding.recipientSpki,binding.recipientKeyId,binding.keyExpiresAtMs,
          verifiedAttestation.isolationVerifiedAtMs,verifiedAttestation.immutableCarrierVerifiedAtMs,verifiedAttestation.expiresAtMs,verifiedAttestation.id);
      return { nodeId, generation };
    });
  }

  retireMachine(tx: SecurityTx, deploymentProof: string, deploymentId: string, runtimeId: string, incarnation: string, expectedGeneration: number): void {
    withSecurityTarget(this.db, tx, `machine:${runtimeId}`, () => {
      requireMachineDeployment(this.db, tx, deploymentId, machineRetirementPayload(deploymentId,runtimeId,incarnation,expectedGeneration), deploymentProof);
      const prior = this.db.query(`SELECT authority_node_id FROM multiremi_machine_enrollments WHERE deployment_id=? AND runtime_id=? AND incarnation=?
        AND generation=? AND retired_at_ms IS NULL`).get(deploymentId,runtimeId,incarnation,expectedGeneration);
      if (!prior) throw new SecurityAbort('authority_revision_conflict');
      this.retireEnrollmentGeneration(tx,incarnation,prior.authority_node_id,expectedGeneration);
      this.advanceSecurityRevision();
    });
  }

  private advanceSecurityRevision(): number {
    const state = this.db.query(`UPDATE multiremi_security_state SET security_revision=security_revision+1 WHERE singleton=1 RETURNING security_revision`).get();
    if (!state) throw new SecurityAbort('security_state_unavailable');
    return Number(state.security_revision);
  }

  private retireEnrollmentGeneration(tx: SecurityTx, incarnation: string, nodeId: string, generation: number): void {
    withSecurityTarget(this.db, tx, `authority:${nodeId}`, () => {
      const now = Date.now();
      const retired = this.db.query(`UPDATE multiremi_machine_enrollments SET retired_at_ms=? WHERE incarnation=? AND generation=?
        AND retired_at_ms IS NULL RETURNING incarnation`).get(now,incarnation,generation);
      if (!retired) throw new SecurityAbort('authority_revision_conflict');
      this.db.query(`UPDATE multiremi_authority_nodes SET revoked_at_ms=COALESCE(revoked_at_ms,?) WHERE node_id=? AND generation=?`).run(now,nodeId,generation);
      this.db.query(`UPDATE multiremi_runtime_trusts SET revoked_at_ms=COALESCE(revoked_at_ms,?) WHERE incarnation=?`).run(now,incarnation);
    });
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

  private insertGrant(tx: SecurityTx, subject: GrantSubject, reason: string, expiry: number | null, before: number,
    issuer: { type: 'deployment' | 'user' | 'agent'; id: string }, parents: string[], origin: CurrentAuthority['credentialOrigin'] = null, issuerAttemptId: string | null = null): CreateRootGrantResponse {
    const state = this.db.query("SELECT generation_counter,active_grant_id FROM multiremi_root_subject_state WHERE subject_type=? AND subject_id=?").get(subject.type,subject.id);
    const generation = Number(state?.generation_counter ?? 0)+1;
    const revision = before+1;
    const now = Date.now();
    if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(revision)) throw new SecurityAbort('authority_revision_conflict');
    const previousId = state?.active_grant_id ?? null;
    if (previousId !== null) {
      const prior = this.db.query(`SELECT g.authority_node_id,g.revoked_at_ms,g.expires_at_ms FROM multiremi_root_grants g
        JOIN multiremi_authority_nodes n ON n.node_id=g.authority_node_id AND n.generation=g.generation AND n.kind='grant'
          AND n.subject_type=g.subject_type AND n.subject_id=g.subject_id AND n.scope=g.scope
        WHERE g.grant_id=? AND g.subject_type=? AND g.subject_id=? AND g.generation=?`).get(previousId,subject.type,subject.id,generation-1);
      if (!prior) throw new SecurityAbort('security_state_unavailable');
      if (prior.revoked_at_ms===null && (prior.expires_at_ms===null || Number(prior.expires_at_ms)>now)
        && grantAncestryIsCurrent(this.db,tx,subject.id,{nodeId:prior.authority_node_id,generation:generation-1},subject.type) && this.hasHumanGrantOrigins(prior.authority_node_id)) {
        throw new SecurityAbort('authority_revision_conflict');
      }
      this.db.query(`UPDATE multiremi_authority_nodes SET revoked_at_ms=?,revision=? WHERE node_id=? AND generation=? AND revoked_at_ms IS NULL`)
        .run(now,revision,prior.authority_node_id,generation-1);
    }
    const node = this.newNode('grant', subject.type, subject.id, generation, revision, expiry, parents);
    if (!grantAncestryIsCurrent(this.db, tx, subject.id, { nodeId: node, generation }, subject.type)) throw new SecurityAbort('root_authority_revoked');
    const id = randomUUID();
    this.db.query(`INSERT INTO multiremi_root_grants(grant_id,subject_type,subject_id,generation,scope,authority_node_id,issuer_type,issuer_id,revision,reason,created_at_ms,expires_at_ms,issuer_credential_id,origin_family_id,issuer_attempt_id)
      VALUES(?,?,?,?,'system',?,?,?,?,?,?,?,?,?,?)`).run(id,subject.type,subject.id,generation,node,issuer.type,issuer.id,revision,reason,now,expiry,origin?.credential.id??null,origin?.familyId??null,issuerAttemptId);
    if (!this.db.query(`INSERT INTO multiremi_root_subject_state(subject_type,subject_id,generation_counter,active_grant_id) VALUES(?,?,?,?)
      ON CONFLICT(subject_type,subject_id) DO UPDATE SET generation_counter=excluded.generation_counter,active_grant_id=excluded.active_grant_id
      WHERE multiremi_root_subject_state.active_grant_id IS NOT DISTINCT FROM ? AND multiremi_root_subject_state.generation_counter=? RETURNING generation_counter`)
      .get(subject.type,subject.id,generation,id,previousId,generation-1)) throw new SecurityAbort('authority_revision_conflict');
    if (!this.db.query('UPDATE multiremi_security_state SET security_revision=? WHERE singleton=1 AND security_revision=? RETURNING singleton')
      .get(revision,before)) throw new SecurityAbort('authority_revision_conflict');
    return { security_revision: revision, grant: { id, subject, scope: 'system', generation, status: 'active', effective: true,
      effective_reason_code: 'active', authority_node_id: node, issuer, origin_attempt_id: issuerAttemptId, origin_family_id: origin?.familyId??null, reason, revocation_reason: null,
      created_at: new Date(now).toISOString(), expires_at: expiry === null ? null : new Date(expiry).toISOString(), revoked_at: null, revision } };
  }

  grant(tx: SecurityTx, actor: Parameters<AuthorityKernel['grant']>[1], input: CreateRootGrantRequest): CreateRootGrantResponse {
    const target = input.subject;
    if (!target.id || (target.type !== 'agent' && (target.type !== 'user' || !target.id.startsWith('usr_')))) return abortSecurityWrite(this.db,tx,'root_required');
    return withSecurityTarget(this.db, tx, `management:${target.type}:${target.id}`, () => onPrimary(() => {
      const bound = this.actors.get(actor as Actor);
      if (!bound || bound.tx !== tx || bound.target !== target.id || bound.targetType !== target.type || bound.use !== 'management' || bound.action !== createAction) throw new SecurityAbort('root_required');
      const current = this.check(tx, bound.proof, { action: createAction, actualTarget: target, use: 'management' });
      if (!current.effectiveRoot || !current.recordedGrant || !current.subject) throw new SecurityAbort('root_required');
      const previous = actor as Actor;
      if (previous.checkedRevision !== current.checkedRevision || previous.recordedGrant?.grantId !== current.recordedGrant.grantId) throw new SecurityAbort('authority_revision_conflict');
      if (!input.reason?.trim() || !input.idempotency_key?.trim() || !Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0
        || target.type==='user' && (input.runtime_trust_ids?.length || input.accepted_dependency_digest != null)) throw new RootManagementRequestError(400, 'Invalid human grant request');
      const expiry = input.expires_at == null ? null : Date.parse(input.expires_at);
      if (expiry !== null && !Number.isSafeInteger(expiry)) throw new RootManagementRequestError(400, 'Invalid expiry');
      const key = [current.subject.id,createAction,target.id,input.idempotency_key];
      const payload = digest(JSON.stringify(target.type==='user' && current.subject.type==='user' ? [input.expected_revision,input.reason,expiry] :
        [target.type,current.subject,current.credentialOrigin?.credential,current.recordedGrant.grantId,current.recordedGrant.generation,input.expected_revision,input.reason,expiry,[...(input.runtime_trust_ids??[])].sort(),input.accepted_dependency_digest]));
      const prior = this.db.query(`SELECT result_json,payload_digest,actor_grant_id,actor_generation FROM multiremi_root_management_events
        WHERE actor_user_id=? AND action=? AND target_id=? AND idempotency_key=?`).get(...key);
      if (prior) {
        if (prior.payload_digest !== payload || prior.actor_grant_id!==current.recordedGrant.grantId || Number(prior.actor_generation)!==current.recordedGrant.generation) throw new SecurityAbort('authority_revision_conflict');
        const result: CreateRootGrantResponse = JSON.parse(prior.result_json);
        const record = this.db.query(`SELECT g.revoked_at_ms,g.revoke_reason,g.revision,s.active_grant_id FROM multiremi_root_grants g
          JOIN multiremi_root_subject_state s ON s.subject_type=g.subject_type AND s.subject_id=g.subject_id WHERE g.grant_id=?`).get(result.grant.id);
        if (!record) throw new SecurityAbort('security_state_unavailable');
        const revoked = record.revoked_at_ms !== null;
        const expired = expiry !== null && expiry <= Date.now();
        const effective = !revoked && !expired && record.active_grant_id === result.grant.id && grantAncestryIsCurrent(this.db,tx,target.id,
          { nodeId: result.grant.authority_node_id, generation: result.grant.generation },target.type) && this.hasHumanGrantOrigins(result.grant.authority_node_id);
        return { security_revision: current.checkedRevision, replayed: true, grant: { ...result.grant, effective, revision: Number(record.revision),
          revoked_at: revoked ? new Date(Number(record.revoked_at_ms)).toISOString() : null, revocation_reason: record.revoke_reason,
          status: revoked ? 'revoked' : expired ? 'expired' : 'active', effective_reason_code: revoked ? 'grant_revoked' : expired ? 'grant_expired' : effective ? 'active' : 'ancestor_revoked' } };
      }
      if (current.checkedRevision !== input.expected_revision) throw new SecurityAbort('authority_revision_conflict');
      if (expiry !== null && expiry <= Date.now()) throw new RootManagementRequestError(400, 'Invalid expiry');
      const source = current.credentialOrigin?.node ?? this.passwordOrigin(bound.proof);
      let parent = source, issuerAttemptId = current.attemptId;
      if (current.subject.type==='agent') {
        if (expiry===null || !current.credentialOrigin || current.scope!=='system') throw new SecurityAbort('root_required');
        if (current.transport==='task') parent = this.resolveDurableDelegation(tx,actor as Actor,{action:createAction,use:'management',actualTarget:target,
          idempotencyKey:input.idempotency_key,requestDigest:payload,expiresAtMs:expiry},target);
        else {
          const provenance = this.db.query(`SELECT d.attempt_id FROM multiremi_delegated_pats p JOIN multiremi_durable_delegations d ON d.node_id=p.origin_node_id
            WHERE p.credential_id=? AND p.family_id=? AND d.issuer_agent_id=? AND d.issuer_grant_id=? AND d.issuer_generation=?`).get(current.credentialOrigin.credential.id,
              current.credentialOrigin.familyId,current.subject.id,current.recordedGrant.grantId,current.recordedGrant.generation);
          if (!provenance || assertUnrevokedAncestry(this.db,tx,source)<expiry) throw new SecurityAbort('root_authority_revoked');
          issuerAttemptId=provenance.attempt_id;
        }
      }
      const parents = [current.recordedGrant.authorityNodeId,parent.nodeId];
      const snapshot = target.type==='agent' ? requireAgentDependencySnapshot(this.resolveAgentDependencies,tx,target.id,input.runtime_trust_ids??[],input.accepted_dependency_digest??'') : null;
      if (snapshot) {
        const approval=this.db.query(`SELECT approval_node_id FROM multiremi_agent_config_epochs WHERE agent_id=? AND config_epoch=?`).get(target.id,snapshot.configEpoch);
        if (approval) parents.push(approval.approval_node_id);
        if (!this.db.query('SELECT id FROM multiremi_agents WHERE id=? AND archived_at IS NULL').get(target.id)) throw new SecurityAbort('root_required');
        for (const trust of snapshot.trustVersions) {
          const row = this.db.query(`SELECT authority_node_id,runtime_id,challenge_id FROM multiremi_runtime_trusts WHERE trust_id=? AND generation=? AND revoked_at_ms IS NULL`).get(trust.id,trust.version);
          if (!row || !recordedMachineBindingIsCurrent(this.db,tx,row.runtime_id,row.challenge_id)) throw new SecurityAbort('root_runtime_untrusted');
          parents.push(row.authority_node_id);
        }
      } else {
        const targetPassword = this.passwordRow(target.id, true);
        const targetProof = targetPassword && this.versionRow(target.id, digest(targetPassword.password_hash));
        if (!targetProof || !grantAncestryIsCurrent(this.db, tx, target.id, { nodeId: targetProof.password_node_id,
          generation: Number(targetProof.version) })) throw new SecurityAbort('root_required');
      }
      const result = this.insertGrant(tx,target,input.reason,expiry,current.checkedRevision,current.subject,[...new Set(parents)],current.credentialOrigin,issuerAttemptId);
      if (snapshot) {
        this.db.query(`INSERT INTO multiremi_agent_grant_dependencies(grant_id,grant_generation,agent_id,config_epoch,dependency_digest,trust_versions_json)
          VALUES(?,?,?,?,?,?)`).run(result.grant.id,result.grant.generation,target.id,snapshot.configEpoch,snapshot.digest,JSON.stringify(snapshot.trustVersions));
        const insert = this.db.query(`INSERT INTO multiremi_agent_grant_protected_refs(grant_id,kind,resource_id,resource_version,digest,use_kind) VALUES(?,?,?,?,?,?)`);
        for (const ref of snapshot.refs) insert.run(result.grant.id,ref.kind,ref.id,ref.version,ref.digest,ref.use);
        for (const trust of snapshot.trustVersions) {
          const execution = this.db.query(`SELECT x.provider_ref,x.checkpoint_policy_ref,t.authority_node_id FROM multiremi_current_agent_execution_sources x
            JOIN multiremi_runtime_trusts t ON t.trust_id=x.trust_id AND t.generation=x.trust_generation AND t.runtime_id=x.runtime_id
              AND t.incarnation=x.incarnation AND t.revoked_at_ms IS NULL
            WHERE x.agent_id=? AND x.config_epoch=? AND x.trust_id=? AND x.trust_generation=?`).get(target.id,snapshot.configEpoch,trust.id,trust.version);
          if (!execution) {
            if (snapshot.refs.some(ref=>ref.kind==='provider-trust' || ref.kind==='checkpoint-policy')) throw new SecurityAbort('authority_revision_conflict');
            continue;
          }
          for (const [kind, use, serialized, nodeKind] of [['provider-trust','execute',execution.provider_ref,'provider_trust'],
            ['checkpoint-policy','restore',execution.checkpoint_policy_ref,'checkpoint_trust']] as const) {
            const reference = JSON.parse(serialized);
            if (reference.kind!==kind || reference.use!==use || !snapshot.refs.some(ref=>isDeepStrictEqual(ref,reference))) throw new SecurityAbort('authority_revision_conflict');
            this.newNode(nodeKind,'agent',target.id,result.grant.generation,result.security_revision,expiry,
              [result.grant.authority_node_id,execution.authority_node_id],executionTrustNodeId(result.grant.id,trust.id,reference));
          }
        }
      }
      this.db.query(`INSERT INTO multiremi_root_management_events(actor_user_id,action,target_id,idempotency_key,payload_digest,proof_node_id,actor_grant_id,
        actor_generation,reason,revision_before,revision_after,created_at_ms,result_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(...key,payload,source.nodeId,current.recordedGrant.grantId,current.recordedGrant.generation,input.reason,current.checkedRevision,result.security_revision,Date.now(),JSON.stringify(result));
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
      if (!bound || bound.tx !== tx || bound.action !== action || bound.target !== targetId || bound.targetType !== type || bound.use !== 'management') throw new SecurityAbort('root_required');
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
      const source = current.credentialOrigin?.node ?? this.passwordOrigin(bound.proof);
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
        const node = this.newNode('runtime_trust','runtime',targetId,generation,revision,expiry,[current.recordedGrant.authorityNodeId,source.nodeId,machine.authorityNodeId]);
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
        .run(...key,payload,source.nodeId,current.recordedGrant.grantId,current.recordedGrant.generation,input.reason,creating?null:change.revoke.reason_code??null,before,revision,now,JSON.stringify(result));
      return result;
    }));
  }

  private revoke(tx: SecurityTx, actor: Parameters<AuthorityKernel['revokeGrant']>[1], targetId: string, action: string,
    input: RevokeRootGrantRequest): Response {
    const type = action === grantAction ? 'grant' : 'credential_family';
    return withSecurityTarget(this.db, tx, `management:${type}:${targetId}`, () => {
      const bound = this.actors.get(actor as Actor);
      if (!bound || bound.tx !== tx || bound.target !== targetId || bound.targetType !== type || bound.use !== 'management' || bound.action !== action) throw new SecurityAbort('root_required');
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
      if (action===familyAction) this.db.query(`UPDATE multiremi_authority_nodes SET revoked_at_ms=?,revision=? WHERE revoked_at_ms IS NULL AND node_id IN
        (SELECT node_id FROM multiremi_durable_delegations WHERE family_id=?)`).run(now,revision,targetId);
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
        .run(...key, payload, current.credentialOrigin?.node.nodeId ?? this.passwordOrigin(bound.proof).nodeId, current.recordedGrant.grantId, current.recordedGrant.generation,
          input.reason, input.reason_code ?? null, before, revision, now, JSON.stringify(result));
      return result;
    });
  }
}
