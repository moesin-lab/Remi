import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { frozenPayload, rootBusinessPayloadDigest } from '@shared/root-business-payload.js';
export { rootBusinessPayloadDigest } from '@shared/root-business-payload.js';
import type { RootDeliveryEnvelopePayload, RootDeliveryTuple, RootDeliveryExecutionKey, RootDeliveryStatusResponse, RootDeliveryInstallAckResponse,
  RootDeliveryReplayRequest, RootDeliveryInstallAckRequest, RootExecutionLocator } from '@multiremi/contracts/root-delivery.js';
import { sealRootDelivery, serializeRootDeliveryTuple } from '../worker/root-delivery-envelope.js';
import type { IssuedCredential, ReceiptService } from './root-authority-contract.js';
import type { SqlDatabase } from './db/postgres.js';
import { persistIssuedMaterialBinding } from './credential-version-bindings.js';
import { readCurrentTaskLease, writeCurrentTaskLease } from './task-authority.js';
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

  commitFirstOffer(candidate: PreparedRootDelivery, lease: Lease): RootDeliveryEnvelopePayload {
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
        return this.activate(tx, candidate, lease, (activeTx, prepared) => {
          const bound = this.db.query(`INSERT INTO multiremi_usage_task_scopes(task_id,workspace_id,agent_id,runtime_id,active_run_id,runtime_provenance)
            SELECT a.id,t.workspace_id,t.agent_id,a.runtime_id,?,'live_task' FROM multiremi_turn_attempts a
            JOIN multiremi_turns t ON t.current_attempt_id=a.id AND t.id=a.turn_id
            WHERE a.id=? AND a.runtime_id=? AND a.status='accepted'
            AND NOT EXISTS (SELECT 1 FROM multiremi_usage_runs r WHERE r.task_id=a.id)
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
