import { createHash, createPublicKey, randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { frozenPayload, rootBusinessPayloadDigest } from '@shared/root-business-payload.js';
export { rootBusinessPayloadDigest } from '@shared/root-business-payload.js';
import { hashSystemPromptContent } from '@shared/system-prompt-policy-hash.js';
import type { PolicyOfferIdentity } from '@multiremi/contracts/system-prompt-policy.js';
import { assertUnrevokedAncestry } from './authority-provenance.js';
import { tableExists } from './unified-model-migration.js';

import type { RootDeliveryEnvelopePayload, RootDeliveryTuple, RootDeliveryExecutionKey, RootDeliveryStatusResponse, RootDeliveryInstallAckResponse,
  RootDeliveryReplayRequest, RootDeliveryInstallAckRequest, RootExecutionLocator } from '@multiremi/contracts/root-delivery.js';
import { sealRootDelivery, serializeRootDeliveryTuple } from '../worker/root-delivery-envelope.js';
import type { IssuedCredential, ReceiptService } from './root-authority-contract.js';
import type { SqlDatabase } from './db/postgres.js';
import { persistIssuedMaterialBinding } from './credential-version-bindings.js';
import { approvedAttemptSources, readCurrentTaskLease, writeCurrentTaskLease } from './task-authority.js';
import { RootManagement } from './root-management.js';
import { beginMachineChallenge, bindMachineConnection, releaseMachineConnection, requireCurrentMachine, verifyConnectionChallenge, verifyMachineChallenge, type MachineConnection } from './machine-proof.js';
import { abortSecurityWrite, withSecurityTarget, withSecurityWrite, type SecurityTx } from './security-write.js';
import { prepareMachineConnection, attachMachineConnection, sessionMachineConnection } from './machine-proof.js';

type Lease = { start_deadline: string; lease_id: string; fence_term: string };
type Machine = Parameters<ReceiptService['resolveReceiptStatus']>[0];
type CheckReceipt = (tx: SecurityTx, machine: Machine, tuple: RootDeliveryTuple, action: 'status' | 'replay' | 'install_ack' | 'start', lease: Lease) => void;
function receiptPurpose(action: Parameters<CheckReceipt>[3]): string {
  return action==='start' ? 'task.start' : `delivery.receipt.${action}`;
}
type StoredReceipt = Lease & { binding_json: string; envelope_digest: string; run_state: 'pending_start' | 'running';
  ack_state: 'pending' | 'confirmed'; execution_locator_json: string | null };

const preparedDeliveries = new WeakSet<PreparedRootDelivery>();
class CommittedRunConflict extends Error {
  constructor() { super('receipt_conflict'); }
}
const activatingDeliveries = new WeakMap<SecurityTx, { db: SqlDatabase; candidate: PreparedRootDelivery }>();

export function requireActivatingDelivery(db: SqlDatabase, tx: SecurityTx, input: unknown): PreparedRootDelivery {
  const activation = activatingDeliveries.get(tx);
  if (!activation || activation.db !== db || activation.candidate !== input) return abortSecurityWrite(db, tx, 'credential_version_conflict');
  return activation.candidate;
}

export class PreparedRootDelivery {
  readonly credentialId = randomUUID();
  readonly familyId = randomUUID();
  readonly familyNodeId = randomUUID();
  readonly materialNodeId = randomUUID();
  private constructor(readonly tuple: RootDeliveryTuple, readonly businessJson: string, readonly envelope: string,
    readonly envelopeDigest: string, readonly tokenHash: string, readonly tokenPrefix: string) { Object.freeze(this); }

  static async prepare(binding: RootDeliveryTuple, payload: Readonly<Record<string, unknown>>, key: CryptoKey): Promise<PreparedRootDelivery> {
    const tuple = Object.freeze({ ...binding });
    const business = frozenPayload(payload);
    if (`sha256:${createHash('sha256').update(business).digest('hex')}` !== tuple.business_payload_digest) throw new Error('receipt_conflict');
    const raw = `mat_${randomBytes(20).toString('hex')}`;
    const sealed = await sealRootDelivery(tuple, raw, key);
    const candidate = new PreparedRootDelivery(tuple, business, sealed.envelope, sealed.envelope_digest,
      createHash('sha256').update(raw).digest('hex'), raw.slice(0, 12));
    preparedDeliveries.add(candidate);
    return candidate;
  }
}

export class RootReceiptStore {
  constructor(private readonly db: SqlDatabase, private readonly authority = new RootManagement(db)) {}

  planRecovery(receiptId: string) { return this.authority.registeredCredentials.planReceipt(receiptId); }

  findReceipt(key: RootDeliveryExecutionKey, runtimeId: string, consumerId: string): string | null {
    const row=this.db.query(`SELECT r.receipt_id FROM multiremi_delivery_receipts r JOIN multiremi_current_task_leases l
      ON l.attempt_id=r.attempt_id AND l.run_generation=r.run_generation AND l.consumer_id=r.consumer_id
      WHERE r.attempt_id=? AND l.runtime_id=? AND l.consumer_id=? AND (r.handoff_id=? OR (r.handoff_id IS NULL AND ?=1))
      AND (r.receipt_id=? OR ?=1)`).get(key.attempt_id,runtimeId,consumerId,key.handoff_id??null,key.handoff_id==null?1:0,
        key.receipt_id??null,key.receipt_id==null?1:0);
    return row?.receipt_id ?? null;
  }

  bindConnection(owner: object, bearer: string) { return bindMachineConnection(this.db,owner,bearer); }

  prepareConnection(bearer: string) { return prepareMachineConnection(this.db, bearer); }
  attachConnection(session: object, connection: MachineConnection) { attachMachineConnection(this.db, connection, session); }

  challengeSession(tx: SecurityTx, session: object, runtimeId: string, action: Parameters<CheckReceipt>[3], receiptId: string) {
    return this.challenge(tx, sessionMachineConnection(session), runtimeId, action, receiptId);
  }

  releaseConnection(owner: object) { releaseMachineConnection(owner); }

  authenticateConnection(tx: SecurityTx, owner: object, action: Parameters<CheckReceipt>[3], receiptId: string,
    proof: Parameters<typeof verifyConnectionChallenge>[5]) {
    return verifyConnectionChallenge(this.db,tx,owner,receiptPurpose(action),receiptId,proof);
  }

  challenge(tx: SecurityTx, connection: MachineConnection, runtimeId: string, action: Parameters<CheckReceipt>[3], receiptId: string) {
    return beginMachineChallenge(this.db,tx,connection,runtimeId,receiptPurpose(action),receiptId);
  }

  authenticate(tx: SecurityTx, connection: MachineConnection, challengeId: string, action: Parameters<CheckReceipt>[3], receiptId: string,
    proof: Parameters<typeof verifyMachineChallenge>[6]) {
    return verifyMachineChallenge(this.db,tx,connection,challengeId,receiptPurpose(action),receiptId,proof);
  }

  private checked<T>(tx: SecurityTx, machine: Machine, receiptId: string, action: Parameters<CheckReceipt>[3], check: CheckReceipt | undefined,
    read: (row: StoredReceipt, tuple: RootDeliveryTuple) => T): T {
    return withSecurityTarget(this.db, tx, `receipt:${receiptId}`, () => {
      const row: StoredReceipt | null = this.db.query(`SELECT binding_json,envelope_digest,run_state,ack_state,start_deadline,
        lease_id,fence_term,execution_locator_json FROM multiremi_delivery_receipts WHERE receipt_id=?`).get(receiptId);
      if (!row) throw new Error('stale_execution');
      const tuple: RootDeliveryTuple = JSON.parse(row.binding_json);
      if (serializeRootDeliveryTuple(tuple) !== row.binding_json || tuple.receipt_id !== receiptId) throw new Error('receipt_conflict');
      if (!(Date.parse(tuple.material_expires_at) > Date.now()) || !['pending_start', 'running'].includes(row.run_state) ||
          (row.run_state === 'pending_start' && !(Date.parse(row.start_deadline) > Date.now()))) throw new Error('stale_execution');
      const owner = requireCurrentMachine(this.db, tx, machine, receiptPurpose(action), receiptId);
      if (owner.consumerId !== tuple.consumer_id || owner.runtimeId !== tuple.runtime_id || owner.daemonId !== tuple.daemon_id ||
          owner.incarnation !== tuple.incarnation || owner.keyId !== tuple.recipient_key_id || owner.fingerprint !== tuple.recipient_key_fingerprint) throw new Error('stale_execution');
      this.authority.requireReceiptAuthority(tx, receiptId);
      withSecurityTarget(this.db, tx, `receipt:${receiptId}`, () => check?.(tx, machine, tuple, action,
        { start_deadline: row.start_deadline, lease_id: row.lease_id, fence_term: row.fence_term }));
      return read(row, tuple);
    });
  }

  start(tx: SecurityTx, machine: Machine, receiptId: string, locator: RootExecutionLocator, leaseExpiresAtMs: number,
    startAttempt: (tuple: RootDeliveryTuple) => void): 'started' | 'replayed' {
    return this.checked(tx,machine,receiptId,'start',undefined,(row,tuple)=>{
      if (row.ack_state!=='confirmed' || !row.execution_locator_json || !isDeepStrictEqual(JSON.parse(row.execution_locator_json),locator)) {
        throw new Error('stale_execution');
      }
      if (row.run_state==='running') return 'replayed';
      const current=readCurrentTaskLease(this.db,tx,tuple.attempt_id);
      if (!current) throw new Error('stale_execution');
      writeCurrentTaskLease(this.db,tx,Number(current.lease_version),{attemptId:tuple.attempt_id,leaseId:row.lease_id,fenceTerm:row.fence_term,
        consumerId:tuple.consumer_id,runGeneration:tuple.run_generation,runtimeId:tuple.runtime_id,daemonId:tuple.daemon_id,incarnation:tuple.incarnation,
        state:'running',expiresAtMs:Math.min(leaseExpiresAtMs,Date.parse(tuple.material_expires_at))});
      startAttempt(tuple);
      const update=this.db.run(`UPDATE multiremi_delivery_receipts SET run_state='running' WHERE receipt_id=? AND run_state='pending_start'
        AND ack_state='confirmed' AND EXISTS(SELECT 1 FROM multiremi_turn_attempts a JOIN multiremi_turns t ON t.current_attempt_id=a.id
        AND t.id=a.turn_id WHERE a.id=? AND a.status='running' AND a.runtime_id=?)`,[receiptId,tuple.attempt_id,tuple.runtime_id]);
      if (update.changes!==1) throw new Error('stale_execution');
      if (!(Date.parse(row.start_deadline)>Date.now())) throw new Error('stale_execution');
      this.authority.requireReceiptAuthority(tx,receiptId);
      return 'started';
    });
  }

  status(tx: SecurityTx, machine: Machine, receiptId: string, check?: CheckReceipt): RootDeliveryStatusResponse {
    return this.checked(tx, machine, receiptId, 'status', check, (row, tuple) => ({
      ok: true, committed: true, tuple, envelope_digest: row.envelope_digest, run_state: row.run_state, ack_state: row.ack_state,
      start_deadline: row.start_deadline, lease_id: row.lease_id, fence_term: row.fence_term,
      allowed_recovery_action: row.run_state === 'running' ? 'reattach_running' : row.ack_state === 'confirmed' ? 'start_execution' : 'replay_envelope',
      security_revision: Number(this.db.query('SELECT security_revision FROM multiremi_security_state WHERE singleton=1').get().security_revision),
    }));
  }

  replay(tx: SecurityTx, machine: Machine, request: Omit<RootDeliveryReplayRequest, 'machine_proof'>, check?: CheckReceipt): RootDeliveryEnvelopePayload {
    return this.checked(tx, machine, request.receipt_id, 'replay', check, (row, tuple) => {
      if (tuple.receipt_version !== request.expected_receipt_version || tuple.delivery_version !== request.expected_delivery_version ||
          row.lease_id !== request.run_lease_id || row.fence_term !== request.fence_term) throw new Error('receipt_conflict');
      return this.storedEnvelope(tuple, row);
    });
  }

  acknowledge(tx: SecurityTx, machine: Machine, request: Omit<RootDeliveryInstallAckRequest, 'machine_proof'>, check?: CheckReceipt): RootDeliveryInstallAckResponse {
    return this.checked(tx, machine, request.tuple.receipt_id, 'install_ack', check, (row, tuple) => {
      const keys: (keyof typeof request.tuple)[] = ['receipt_id','receipt_version','delivery_version','material_version','attempt_id','handoff_id',
        'run_generation','consumer_id','runtime_id','daemon_id','incarnation','recipient_key_id','recipient_key_fingerprint'];
      if (request.envelope_digest !== row.envelope_digest || keys.some(key => tuple[key] !== request.tuple[key])) throw new Error('receipt_conflict');
      const loc = request.execution_locator;
      if (loc.runtime_id !== tuple.runtime_id || loc.daemon_id !== tuple.daemon_id || loc.incarnation !== tuple.incarnation ||
          loc.carrier_mode !== 'immutable_run_env' || [loc.execution_id, loc.birth_token_id, loc.launch_identity].some(value =>
            typeof value !== 'string' || !value || value.length > 512) || loc.started_at !== null) throw new Error('stale_execution');
      const locator: RootExecutionLocator = { execution_id: loc.execution_id, launch_identity: loc.launch_identity, carrier_mode: loc.carrier_mode,
        runtime_id: loc.runtime_id, daemon_id: loc.daemon_id, incarnation: loc.incarnation, birth_token_id: loc.birth_token_id, started_at: null };
      const encoded = JSON.stringify(locator);
      if (row.ack_state === 'confirmed') {
        if (row.execution_locator_json !== encoded) throw new Error('receipt_conflict');
      } else if (row.run_state !== 'pending_start' || this.db.run(`UPDATE multiremi_delivery_receipts SET ack_state='confirmed',execution_locator_json=?
        WHERE receipt_id=? AND ack_state='pending' AND execution_locator_json IS NULL AND run_state='pending_start'`, [encoded, tuple.receipt_id]).changes !== 1) {
        throw new Error('receipt_conflict');
      }
      return { ok: true, ack_state: 'confirmed', run_state: row.run_state, start_deadline: row.start_deadline,
        lease_id: row.lease_id, fence_term: row.fence_term, idempotent_replay: row.ack_state === 'confirmed' };
    });
  }

  private storedEnvelope(tuple: RootDeliveryTuple, row: StoredReceipt): RootDeliveryEnvelopePayload {
    const stored = this.db.query('SELECT envelope,business_payload_json FROM multiremi_delivery_receipts WHERE receipt_id=?').get(tuple.receipt_id);
    const business = JSON.parse(stored.business_payload_json);
    if (rootBusinessPayloadDigest(business) !== tuple.business_payload_digest ||
        `sha256:${createHash('sha256').update(stored.envelope).digest('hex')}` !== row.envelope_digest) throw new Error('receipt_conflict');
    return { tuple, envelope: stored.envelope, envelope_digest: row.envelope_digest, frozen_business_payload: business,
      start_deadline: row.start_deadline, lease_id: row.lease_id, fence_term: row.fence_term, run_state: row.run_state };
  }

  isRootAttempt(attemptId: string): boolean {
    return !!this.db.query("SELECT 1 FROM multiremi_attempt_eligibility WHERE attempt_id=? AND eligibility='root'").get(attemptId);
  }

  dispatchedRootAttempts(runtimeId: string): string[] {
    return this.db.query(`SELECT a.id FROM multiremi_attempt_eligibility e JOIN multiremi_turn_attempts a ON a.id=e.attempt_id
      JOIN multiremi_turns t ON t.id=a.turn_id AND t.current_attempt_id=a.id WHERE e.eligibility='root' AND e.runtime_id=?
      AND a.runtime_id=e.runtime_id AND a.status='accepted' ORDER BY a.accepted_at,a.id`).all(runtimeId).map(row=>String(row.id));
  }

  async firstTaskOffer(attemptId: string, runtimeId: string, daemonId: string, credentialId: string, fence: string, current: () => void) {
    const read = () => {
      const row = this.db.query(`SELECT e.*,t.id AS turn_id,t.workspace_id,t.legacy_prompt,p.binding_json,p.created_at AS dispatch_time,m.consumer_id,m.recipient_spki,m.recipient_key_id,
        m.key_expires_at_ms,m.attestation_expires_at_ms FROM multiremi_attempt_eligibility e
        JOIN multiremi_turn_attempts a ON a.id=e.attempt_id AND a.runtime_id=e.runtime_id AND a.status='accepted'
        JOIN multiremi_turns t ON t.id=a.turn_id AND t.current_attempt_id=a.id AND t.agent_id=e.subject_id
        JOIN multiremi_attempt_system_prompts p ON p.task_id=a.id AND p.workspace_id=t.workspace_id
        JOIN multiremi_machine_enrollments m ON m.incarnation=e.incarnation AND m.runtime_id=e.runtime_id AND m.daemon_id=e.daemon_id
        JOIN multiremi_access_tokens token ON token.id=m.credential_id AND token.workspace_id=t.workspace_id AND token.token_hash=m.credential_digest
          AND token.type='daemon' AND token.daemon_id=m.daemon_id AND token.revoked_at IS NULL
        WHERE e.eligibility='root' AND e.attempt_id=? AND e.runtime_id=? AND e.daemon_id=? AND m.credential_id=? AND m.retired_at_ms IS NULL`)
        .get(attemptId,runtimeId,daemonId,credentialId);
      if (!row) throw new Error('root_runtime_untrusted');
      const manifest = JSON.parse(row.manifest_json);
      const approval = approvedAttemptSources(this.db,manifest);
      if (!approval || approval.row.attempt_id!==attemptId || approval.row.grant_id!==row.grant_id ||
          approval.row.subject_id!==row.subject_id || approval.row.execution_digest!==row.execution_digest ||
          Number(approval.row.config_epoch)!==Number(row.config_epoch) || approval.row.runtime_trust_id!==row.runtime_trust_id ||
          Number(approval.row.runtime_trust_version)!==Number(row.runtime_trust_version) || approval.row.invocation_digest!==JSON.parse(row.invocation_json).id ||
          Number(approval.row.grant_generation)!==Number(row.grant_generation) || `sha256:${createHash('sha256').update(approval.row.manifest_snapshot).digest('hex')}`!==manifest.digest) {
        throw new Error('root_input_unapproved');
      }
      const {inputs} = JSON.parse(approval.row.manifest_snapshot);
      const authorizedSource=this.db.query(`WITH RECURSIVE sources(id,generation) AS (
        SELECT node_id,generation FROM multiremi_authority_nodes WHERE node_id IN (${approval.sources.map(()=>'?').join(',')})
        UNION SELECT edge.parent_id,edge.parent_generation FROM multiremi_authority_edges edge JOIN sources s
          ON s.id=edge.child_id AND s.generation=edge.child_generation WHERE edge.dependency='continuous')
        SELECT 1 FROM sources s JOIN multiremi_authority_nodes n ON n.node_id=s.id AND n.generation=s.generation
        WHERE s.id=? AND s.generation=? AND n.subject_type=? AND n.subject_id=?`);
      for (const entry of inputs.entries) {
        if (!authorizedSource.get(...approval.sources.map(source=>source.id),entry.source.id,entry.source.version,entry.author.type,entry.author.id)) {
          throw new Error('root_input_unapproved');
        }
      }
      if (row.legacy_prompt && !inputs.entries.some((entry: {purpose:string;snapshot:string})=>entry.purpose==='instruction' && entry.snapshot===row.legacy_prompt)) {
        throw new Error('root_input_unapproved');
      }
      const binding=JSON.parse(row.binding_json);
      const {dispatch,offerGeneration,confirmed,...systemPrompt}=binding;
      if (dispatch?.protocol!=='adopt' || !['proposed','adopted'].includes(dispatch.state) || dispatch.runtimeId!==runtimeId ||
          dispatch.daemonId!==daemonId || typeof offerGeneration!=='string' || !offerGeneration || systemPrompt.workspaceId!==row.workspace_id ||
          hashSystemPromptContent(systemPrompt.content)!==systemPrompt.contentHash) throw new Error('policy_offer_mismatch');
      const receiptId=createHash('sha256').update(JSON.stringify([attemptId,offerGeneration,systemPrompt.contentHash])).digest('hex');
      if (dispatch.receiptId!==undefined && dispatch.receiptId!==receiptId) throw new Error('policy_offer_mismatch');
      const policy_offer={attempt_id:attemptId,workspace_id:row.workspace_id,runtime_id:runtimeId,daemon_id:daemonId,
        offer_generation:offerGeneration,receipt_id:receiptId,content_hash:systemPrompt.contentHash};
      const business = {turn_id:row.turn_id,attempt_id:attemptId,input_revision:manifest.version,prompt:row.legacy_prompt??'',input:{entries:inputs.entries,policy_offer,system_prompt:systemPrompt}};
      const authority=this.db.query(`SELECT g.authority_node_id AS grant_node,t.authority_node_id AS trust_node FROM multiremi_root_grants g
        JOIN multiremi_runtime_trusts t ON t.trust_id=? AND t.generation=? WHERE g.grant_id=? AND g.generation=?`)
        .get(row.runtime_trust_id,row.runtime_trust_version,row.grant_id,row.grant_generation);
      if (!authority) throw new Error('root_authority_revoked');
      const parents=[...approval.sources,{id:authority.grant_node,version:Number(row.grant_generation)},
        {id:authority.trust_node,version:Number(row.runtime_trust_version)}];
      return {row,manifest,business,parents,checkpoint:inputs.providerState.checkpointDigest};
    };
    current();
    const snapshot=read();
    const {row,manifest,business,checkpoint}=snapshot;
    const publicKey=createPublicKey(row.recipient_spki);
    const spki=publicKey.export({type:'spki',format:'der'});
    const key=await crypto.subtle.importKey('jwk',publicKey.export({format:'jwk'}),{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
    const dispatched=Date.parse(row.dispatch_time);
    const revision=this.db.query('SELECT security_revision FROM multiremi_security_state WHERE singleton=1').get();
    const ceiling=withSecurityWrite(this.db,fence,{expectedRevision:Number(revision?.security_revision),workspaceIds:[row.workspace_id],numberKeys:[],
      domainTargets:[...new Set(snapshot.parents.map(source=>`authority:${source.id}`))].sort()},tx=>Math.min(...snapshot.parents.map(source=>
        assertUnrevokedAncestry(this.db,tx,{nodeId:source.id,generation:source.version}))));
    const expiry=Math.min(dispatched+3600_000,Number(row.key_expires_at_ms),Number(row.attestation_expires_at_ms),ceiling);
    const candidate=await PreparedRootDelivery.prepare({receipt_id:randomUUID(),receipt_version:1,delivery_version:1,material_version:1,
      attempt_id:attemptId,handoff_id:null,handoff_generation:0,run_generation:1,consumer_id:row.consumer_id,runtime_id:runtimeId,daemon_id:daemonId,
      incarnation:row.incarnation,recipient_key_id:row.recipient_key_id,recipient_key_fingerprint:`sha256:${createHash('sha256').update(spki).digest('hex')}`,
      execution_config_epoch:Number(row.config_epoch),execution_digest:row.execution_digest,input_revision:manifest.version,input_digest:manifest.digest,
      checkpoint_digest:checkpoint,grant_id:row.grant_id,grant_generation:Number(row.grant_generation),material_expires_at:new Date(expiry).toISOString(),
      business_payload_digest:rootBusinessPayloadDigest(business)},business,key);
    return this.commitFirstOffer(candidate,{lease_id:randomUUID(),fence_term:fence,start_deadline:new Date(Math.min(expiry,dispatched+90_000)).toISOString()},first=>{
      current();
      const verified=read();
      if (!isDeepStrictEqual({...snapshot,row:{...row,binding_json:verified.row.binding_json}},verified)) throw new Error('authority_revision_conflict');
      if (first) {
        const binding=JSON.parse(verified.row.binding_json);
        if (binding.dispatch.state!=='proposed') throw new Error('policy_offer_mismatch');
        binding.dispatch.receiptId=business.input.policy_offer.receipt_id;
        this.db.query('UPDATE multiremi_attempt_system_prompts SET binding_json=? WHERE task_id=?').run(JSON.stringify(binding),attemptId);
        this.db.query('UPDATE multiremi_turn_attempts SET offered_at=COALESCE(offered_at,?) WHERE id=?').run(new Date().toISOString(),attemptId);
      }
    });
  }

  withPolicyOffer<T>(identity: PolicyOfferIdentity, credentialId: string, fence: string, action: () => T): T {
    const receiptId=this.db.query('SELECT receipt_id FROM multiremi_delivery_receipts WHERE attempt_id=? AND run_generation=1').get(identity.attempt_id)?.receipt_id;
    if (!receiptId) throw new Error('policy_offer_mismatch');
    return withSecurityWrite(this.db,fence,this.planRecovery(receiptId),tx=>{
      this.authority.requireReceiptAuthority(tx,receiptId);
      const row=this.db.query(`SELECT r.* FROM multiremi_delivery_receipts r JOIN multiremi_attempt_eligibility e ON e.attempt_id=r.attempt_id
        JOIN multiremi_machine_enrollments m ON m.incarnation=e.incarnation AND m.runtime_id=e.runtime_id AND m.daemon_id=e.daemon_id
        WHERE r.receipt_id=? AND m.credential_id=? AND m.retired_at_ms IS NULL`).get(receiptId,credentialId);
      if (!row) throw new Error('root_authority_revoked');
      const business=JSON.parse(row.business_payload_json);
      if (rootBusinessPayloadDigest(business)!==JSON.parse(row.binding_json).business_payload_digest ||
          !isDeepStrictEqual(business.input?.policy_offer,identity)) throw new Error('policy_offer_mismatch');
      return action();
    });
  }

  commitFirstOffer(candidate: PreparedRootDelivery, lease: Lease, check?: (first:boolean) => void): RootDeliveryEnvelopePayload {
    const { tuple } = candidate;
    if (!preparedDeliveries.has(candidate) || tuple.handoff_id !== null || tuple.handoff_generation !== 0 || tuple.run_generation !== 1) {
      throw new Error('receipt_conflict');
    }
    const existing = () => this.db.query('SELECT receipt_id FROM multiremi_delivery_receipts WHERE attempt_id=? AND run_generation=?')
      .get(tuple.attempt_id, tuple.run_generation)?.receipt_id;
    const replay = (receiptId: string) => {
      const plan = this.planRecovery(receiptId);
      return withSecurityWrite(this.db, lease.fence_term, plan, tx => withSecurityTarget(this.db, tx, `receipt:${receiptId}`, () => {
        this.authority.requireReceiptAuthority(tx, receiptId);
        const row: StoredReceipt = this.db.query('SELECT * FROM multiremi_delivery_receipts WHERE receipt_id=?').get(receiptId);
        check?.(false);
        const committed: RootDeliveryTuple = JSON.parse(row.binding_json);
        if (committed.receipt_id !== receiptId || serializeRootDeliveryTuple(committed) !== row.binding_json ||
            !isDeepStrictEqual(committed, { ...tuple, receipt_id: receiptId, material_expires_at: committed.material_expires_at })) {
          throw new Error('receipt_conflict');
        }
        return this.storedEnvelope(committed, row);
      }));
    };
    const previous = existing();
    if (previous) return replay(previous);
    const plan = this.authority.planFirstOffer(candidate);
    try {
      return withSecurityWrite(this.db, lease.fence_term, plan, tx => {
        if (existing()) throw new CommittedRunConflict();
        check?.(true);
        return this.activate(tx, candidate, lease, (activeTx, prepared) => {
          const emptyLegacy=tableExists(this.db,'multiremi_usage_legacy_sources') ? `AND (r.run_id<>'legacy' OR NOT EXISTS
            (SELECT 1 FROM multiremi_usage_legacy_sources s WHERE s.task_id=r.task_id AND (s.source_usage IS NULL OR s.source_usage='[]'))
            OR EXISTS (SELECT 1 FROM multiremi_usage_units u WHERE u.task_id=r.task_id AND u.run_id=r.run_id))` : '';
          const bound = this.db.query(`INSERT INTO multiremi_usage_task_scopes(task_id,workspace_id,agent_id,runtime_id,active_run_id,runtime_provenance)
            SELECT a.id,t.workspace_id,t.agent_id,a.runtime_id,?,'live_task' FROM multiremi_turn_attempts a
            JOIN multiremi_turns t ON t.current_attempt_id=a.id AND t.id=a.turn_id
            WHERE a.id=? AND a.runtime_id=? AND a.status='accepted'
            AND NOT EXISTS (SELECT 1 FROM multiremi_usage_runs r WHERE r.task_id=a.id ${emptyLegacy})
            ON CONFLICT(task_id) DO UPDATE SET active_run_id=excluded.active_run_id,runtime_id=excluded.runtime_id,runtime_provenance='live_task'
            WHERE multiremi_usage_task_scopes.active_run_id IS NULL AND multiremi_usage_task_scopes.agent_id=excluded.agent_id
              AND multiremi_usage_task_scopes.workspace_id=excluded.workspace_id
              AND (multiremi_usage_task_scopes.runtime_id IS NULL OR multiremi_usage_task_scopes.runtime_id=excluded.runtime_id)
            RETURNING task_id`).get(tuple.consumer_id,tuple.attempt_id,tuple.runtime_id);
          if (!bound) throw new Error('stale_execution');
          this.db.query('INSERT INTO multiremi_usage_runs(task_id,run_id,revision,complete) VALUES(?,?,-1,0)').run(tuple.attempt_id,tuple.consumer_id);
          return this.authority.issue(activeTx, prepared);
        });
      });
    } catch (error) {
      if (!(error instanceof CommittedRunConflict)) throw error;
      const winner = existing();
      if (!winner) throw error;
      return replay(winner);
    }
  }

  activate(tx: SecurityTx, candidate: PreparedRootDelivery, lease: Lease,
    issueAndActivateRun: (tx: SecurityTx, candidate: PreparedRootDelivery) => IssuedCredential, expectedLeaseVersion = 0): RootDeliveryEnvelopePayload {
    const { tuple } = candidate;
    return withSecurityTarget(this.db, tx, `receipt:${tuple.receipt_id}`, () => {
      const businessJson = frozenPayload(JSON.parse(candidate.businessJson));
      if (!preparedDeliveries.has(candidate) || `sha256:${createHash('sha256').update(businessJson).digest('hex')}` !== tuple.business_payload_digest) {
        throw new Error('receipt_conflict');
      }
      if (this.db.query(`SELECT 1 FROM multiremi_delivery_receipts WHERE receipt_id=? OR (attempt_id=? AND run_generation=?)`)
        .get(tuple.receipt_id, tuple.attempt_id, tuple.run_generation)) throw new Error('receipt_conflict');
      if (!(Date.parse(lease.start_deadline) > Date.now()) || !lease.lease_id || !lease.fence_term ||
          !(Date.parse(tuple.material_expires_at) > Date.now())) throw new Error('stale_execution');
      if (activatingDeliveries.has(tx)) throw new Error('receipt_conflict');
      activatingDeliveries.set(tx, { db: this.db, candidate });
      let issued: IssuedCredential;
      try { issued = issueAndActivateRun(tx, candidate); }
      finally { activatingDeliveries.delete(tx); }
      if (issued.material !== candidate || issued.credential.id !== candidate.credentialId || issued.familyId !== candidate.familyId ||
          issued.node.nodeId !== candidate.materialNodeId) throw new Error('credential_version_conflict');
      if (issued.subject.type !== 'agent' || issued.credential.version !== tuple.material_version ||
          issued.expiresAtMs !== Date.parse(tuple.material_expires_at) || issued.expiresAtMs <= Date.now()) throw new Error('credential_version_conflict');
      if (!this.db.query(`SELECT 1 FROM multiremi_usage_task_scopes s JOIN multiremi_usage_runs r
        ON r.task_id=s.task_id AND r.run_id=s.active_run_id JOIN multiremi_turn_attempts a ON a.id=s.task_id
        JOIN multiremi_turns t ON t.current_attempt_id=a.id AND t.id=a.turn_id
        WHERE s.task_id=? AND s.active_run_id=? AND s.runtime_id=? AND a.runtime_id=? AND t.agent_id=? AND r.complete=0`)
        .get(tuple.attempt_id, tuple.consumer_id, tuple.runtime_id, tuple.runtime_id, issued.subject.id)) throw new Error('stale_execution');
      persistIssuedMaterialBinding(this.db, tx, issued, { credentialId: issued.credential.id, materialVersion: tuple.material_version,
        materialDigest: candidate.tokenHash, credentialType: 'task', purpose: 'task', subject: issued.subject });
      const material = this.db.query(`INSERT INTO multiremi_credential_materials
        (credential_id,material_version,family_id,authority_node_id,authority_generation,authority_seq,expires_at_ms)
        SELECT t.id,?,f.family_id,n.node_id,n.generation,n.issued_seq,? FROM multiremi_access_tokens t
        JOIN multiremi_credential_families f ON f.family_id=? AND f.revoked_at_ms IS NULL AND f.max_expires_at_ms>=?
        JOIN multiremi_authority_nodes n ON n.node_id=? AND n.generation=? AND n.revoked_at_ms IS NULL AND n.expires_at_ms>=?
        JOIN multiremi_authority_edges e ON e.child_id=n.node_id AND e.child_generation=n.generation AND e.child_seq=n.issued_seq
          AND e.parent_id=f.authority_node_id AND e.dependency='continuous'
        WHERE t.id=? AND t.token_hash=? AND t.token_prefix=? AND t.revoked_at IS NULL AND t.task_id=? AND t.agent_id=?
          AND t.type='task' AND t.purpose='task' AND t.expires_at=? RETURNING credential_id`)
        .get(tuple.material_version, issued.expiresAtMs, issued.familyId, issued.expiresAtMs, issued.node.nodeId, issued.node.generation,
          issued.expiresAtMs, issued.credential.id, candidate.tokenHash, candidate.tokenPrefix, tuple.attempt_id, issued.subject.id, tuple.material_expires_at);
      if (!material) throw new Error('credential_version_conflict');
      writeCurrentTaskLease(this.db, tx, expectedLeaseVersion, { attemptId: tuple.attempt_id, leaseId: lease.lease_id,
        fenceTerm: lease.fence_term, consumerId: tuple.consumer_id, runGeneration: tuple.run_generation,
        runtimeId: tuple.runtime_id, daemonId: tuple.daemon_id, incarnation: tuple.incarnation,
        expiresAtMs: Math.min(Date.parse(tuple.material_expires_at), Date.parse(lease.start_deadline)), state: 'dispatched' });
      const receipt = this.db.query(`INSERT INTO multiremi_delivery_receipts(receipt_id,attempt_id,handoff_id,run_generation,consumer_id,receipt_version,
        delivery_version,material_version,credential_id,binding_json,envelope,envelope_digest,business_payload_json,start_deadline,lease_id,
        fence_term,ack_state,run_state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending','pending_start')
        ON CONFLICT(attempt_id,run_generation) DO NOTHING RETURNING receipt_id`)
        .get(tuple.receipt_id, tuple.attempt_id, tuple.handoff_id, tuple.run_generation, tuple.consumer_id, tuple.receipt_version, tuple.delivery_version,
        tuple.material_version, issued.credential.id, serializeRootDeliveryTuple(tuple), candidate.envelope, candidate.envelopeDigest, businessJson,
        lease.start_deadline, lease.lease_id, lease.fence_term);
      if (!receipt) throw new CommittedRunConflict();
      this.authority.requireReceiptAuthority(tx,tuple.receipt_id);
      return { tuple, ...lease, run_state: 'pending_start', envelope: candidate.envelope, envelope_digest: candidate.envelopeDigest,
        frozen_business_payload: JSON.parse(businessJson) };
    });
  }
}
