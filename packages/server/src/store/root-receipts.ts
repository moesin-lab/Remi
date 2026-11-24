import { createHash, randomBytes } from 'node:crypto';
import type { RootDeliveryEnvelopePayload, RootDeliveryTuple, RootDeliveryStatusResponse, RootDeliveryInstallAckResponse,
  RootDeliveryReplayRequest, RootDeliveryInstallAckRequest, RootExecutionLocator } from '@multiremi/contracts/root-delivery.js';
import { sealRootDelivery, serializeRootDeliveryTuple } from '../worker/root-delivery-envelope.js';
import type { IssuedCredential, ReceiptService } from './root-authority-contract.js';
import type { SqlDatabase } from './db/postgres.js';
import { persistIssuedMaterialBinding } from './credential-version-bindings.js';
import { withSecurityTarget, type SecurityTx } from './security-write.js';

type Lease = { start_deadline: string; lease_id: string; fence_term: string };
type Machine = Parameters<ReceiptService['resolveReceiptStatus']>[0];
type CheckReceipt = (tx: SecurityTx, machine: Machine, tuple: RootDeliveryTuple, action: 'status' | 'replay' | 'install_ack', lease: Lease) => void;
type StoredReceipt = Lease & { binding_json: string; envelope_digest: string; run_state: 'pending_start' | 'running';
  ack_state: 'pending' | 'confirmed'; execution_locator_json: string | null };

function frozenPayload(value: Readonly<Record<string, unknown>>): string {
  if (['auth_token','raw','raw_token','bearer','envelope','envelope_digest','machine_proof'].some(field => Object.hasOwn(value, field))) {
    throw new Error('Private material in receipt payload');
  }
  function sorted(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(sorted);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([field, member]) => [field, sorted(member)]));
    }
    if (input !== null && typeof input !== 'string' && typeof input !== 'boolean' && !Number.isFinite(input)) throw new Error('Invalid receipt payload');
    return input;
  }
  return JSON.stringify(sorted(value));
}

export function rootBusinessPayloadDigest(payload: Readonly<Record<string, unknown>>): string {
  return `sha256:${createHash('sha256').update(frozenPayload(payload)).digest('hex')}`;
}

export class PreparedRootDelivery {
  private constructor(readonly tuple: RootDeliveryTuple, readonly businessJson: string, readonly envelope: string,
    readonly envelopeDigest: string, readonly tokenHash: string, readonly tokenPrefix: string) { Object.freeze(this); }

  static async prepare(binding: RootDeliveryTuple, payload: Readonly<Record<string, unknown>>, key: CryptoKey): Promise<PreparedRootDelivery> {
    const tuple = Object.freeze({ ...binding });
    const business = frozenPayload(payload);
    if (`sha256:${createHash('sha256').update(business).digest('hex')}` !== tuple.business_payload_digest) throw new Error('receipt_conflict');
    const raw = `mat_${randomBytes(20).toString('hex')}`;
    const sealed = await sealRootDelivery(tuple, raw, key);
    return new PreparedRootDelivery(tuple, business, sealed.envelope, sealed.envelope_digest,
      createHash('sha256').update(raw).digest('hex'), raw.slice(0, 12));
  }
}

export class RootReceiptStore {
  constructor(private readonly db: SqlDatabase) {}

  private checked<T>(tx: SecurityTx, machine: Machine, receiptId: string, action: Parameters<CheckReceipt>[3], check: CheckReceipt,
    read: (row: StoredReceipt, tuple: RootDeliveryTuple) => T): T {
    return withSecurityTarget(this.db, tx, `receipt:${receiptId}`, () => {
      const row: StoredReceipt | null = this.db.query(`SELECT binding_json,envelope_digest,run_state,ack_state,start_deadline,
        lease_id,fence_term,execution_locator_json FROM multiremi_delivery_receipts WHERE receipt_id=?`).get(receiptId);
      if (!row) throw new Error('stale_execution');
      const tuple: RootDeliveryTuple = JSON.parse(row.binding_json);
      if (serializeRootDeliveryTuple(tuple) !== row.binding_json || tuple.receipt_id !== receiptId) throw new Error('receipt_conflict');
      if (!(Date.parse(tuple.material_expires_at) > Date.now()) || !['pending_start', 'running'].includes(row.run_state) ||
          (row.run_state === 'pending_start' && !(Date.parse(row.start_deadline) > Date.now()))) throw new Error('stale_execution');
      withSecurityTarget(this.db, tx, `receipt:${receiptId}`, () => check(tx, machine, tuple, action,
        { start_deadline: row.start_deadline, lease_id: row.lease_id, fence_term: row.fence_term }));
      return read(row, tuple);
    });
  }

  status(tx: SecurityTx, machine: Machine, receiptId: string, check: CheckReceipt): RootDeliveryStatusResponse {
    return this.checked(tx, machine, receiptId, 'status', check, (row, tuple) => ({
      ok: true, committed: true, tuple, envelope_digest: row.envelope_digest, run_state: row.run_state, ack_state: row.ack_state,
      start_deadline: row.start_deadline, lease_id: row.lease_id, fence_term: row.fence_term,
      allowed_recovery_action: row.run_state === 'running' ? 'reattach_running' : row.ack_state === 'confirmed' ? 'start_execution' : 'replay_envelope',
      security_revision: Number(this.db.query('SELECT security_revision FROM multiremi_security_state WHERE singleton=1').get().security_revision),
    }));
  }

  replay(tx: SecurityTx, machine: Machine, request: Omit<RootDeliveryReplayRequest, 'machine_proof'>, check: CheckReceipt): RootDeliveryEnvelopePayload {
    return this.checked(tx, machine, request.receipt_id, 'replay', check, (row, tuple) => {
      if (tuple.receipt_version !== request.expected_receipt_version || tuple.delivery_version !== request.expected_delivery_version ||
          row.lease_id !== request.run_lease_id || row.fence_term !== request.fence_term) throw new Error('receipt_conflict');
      const stored = this.db.query('SELECT envelope,business_payload_json FROM multiremi_delivery_receipts WHERE receipt_id=?').get(tuple.receipt_id);
      const business = JSON.parse(stored.business_payload_json);
      if (rootBusinessPayloadDigest(business) !== tuple.business_payload_digest ||
          `sha256:${createHash('sha256').update(stored.envelope).digest('hex')}` !== row.envelope_digest) throw new Error('receipt_conflict');
      return { tuple, envelope: stored.envelope, envelope_digest: row.envelope_digest, frozen_business_payload: business,
        start_deadline: row.start_deadline, lease_id: row.lease_id, fence_term: row.fence_term, run_state: row.run_state };
    });
  }

  acknowledge(tx: SecurityTx, machine: Machine, request: Omit<RootDeliveryInstallAckRequest, 'machine_proof'>, check: CheckReceipt): RootDeliveryInstallAckResponse {
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

  activate(tx: SecurityTx, candidate: PreparedRootDelivery, lease: Lease,
    issueAndActivateRun: (tx: SecurityTx, candidate: PreparedRootDelivery) => IssuedCredential): RootDeliveryEnvelopePayload {
    const { tuple } = candidate;
    return withSecurityTarget(this.db, tx, `receipt:${tuple.receipt_id}`, () => {
      if (this.db.query(`SELECT 1 FROM multiremi_delivery_receipts WHERE receipt_id=? OR (attempt_id=? AND run_generation=?)`)
        .get(tuple.receipt_id, tuple.attempt_id, tuple.run_generation)) throw new Error('receipt_conflict');
      if (!(Date.parse(lease.start_deadline) > Date.now()) || !lease.lease_id || !lease.fence_term ||
          !(Date.parse(tuple.material_expires_at) > Date.now())) throw new Error('stale_execution');
      const issued = issueAndActivateRun(tx, candidate);
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
      this.db.run(`INSERT INTO multiremi_delivery_receipts(receipt_id,attempt_id,handoff_id,run_generation,consumer_id,receipt_version,
        delivery_version,material_version,credential_id,binding_json,envelope,envelope_digest,business_payload_json,start_deadline,lease_id,
        fence_term,ack_state,run_state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending','pending_start')`,
      [tuple.receipt_id, tuple.attempt_id, tuple.handoff_id, tuple.run_generation, tuple.consumer_id, tuple.receipt_version, tuple.delivery_version,
        tuple.material_version, issued.credential.id, serializeRootDeliveryTuple(tuple), candidate.envelope, candidate.envelopeDigest, candidate.businessJson,
        lease.start_deadline, lease.lease_id, lease.fence_term]);
      return { tuple, ...lease, run_state: 'pending_start', envelope: candidate.envelope, envelope_digest: candidate.envelopeDigest,
        frozen_business_payload: JSON.parse(candidate.businessJson) };
    });
  }
}
