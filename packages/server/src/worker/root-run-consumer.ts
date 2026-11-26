import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { RootMachineClient } from '@daemon/agent-runtime/root-machine-client.js';
import { RootRunSupervisor } from '@daemon/agent-runtime/root-run-supervisor.mjs';
import type { RootDeliveryTuple, RootExecutionLocator } from '@multiremi/contracts/root-delivery.js';
import { samePolicyOffer } from '@multiremi/contracts/system-prompt-policy.js';
import { DaemonProtocolRpcError, type DaemonProtocolClient } from './daemon-protocol-client.js';
import type { PlannedRestartJournal } from './planned-restart-journal.js';
import { RootReceiptClient } from './root-receipt-client.js';
import { rootBusinessPayloadDigest } from '@shared/root-business-payload.js';

export class RootRunConsumer {
  private readonly pending = new Map<string, Promise<void>>();
  private readonly retry = new Set<string>();
  private readonly active = new Map<string, RootDeliveryTuple>();

  constructor(readonly runtimeId: string, private readonly journal: PlannedRestartJournal,
    private readonly receipts: Pick<RootReceiptClient, 'status' | 'replay' | 'acknowledge' | 'proof'>,
    private readonly supervisor: Pick<RootRunSupervisor, 'ensureInstalled' | 'attach' | 'startOnce'>,
    private readonly transport: Pick<DaemonProtocolClient, 'event' | 'rpc'>) {}

  receive(tuple: RootDeliveryTuple, digest: string): Promise<void> {
    if (tuple.runtime_id !== this.runtimeId) throw new Error('stale_execution');
    const local = this.journal.receiveRootExecution(tuple, digest);
    const pending = this.pending.get(tuple.receipt_id);
    if (pending) return pending;
    const work = this.installAndStart(tuple, digest, local).then(() => {
      this.retry.delete(tuple.receipt_id);
      this.active.set(tuple.attempt_id, tuple);
    }, error => {
      if (this.active.get(tuple.attempt_id)?.receipt_id === tuple.receipt_id) this.active.delete(tuple.attempt_id);
      if ((error instanceof DaemonProtocolRpcError && !error.retryable) || error?.message === 'stale_execution' ||
          error?.message === 'receipt_conflict' || Date.parse(tuple.material_expires_at) <= Date.now()) {
        this.retry.delete(tuple.receipt_id);
      } else this.retry.add(tuple.receipt_id);
      throw error;
    }).finally(() => this.pending.delete(tuple.receipt_id));
    this.pending.set(tuple.receipt_id, work);
    return work;
  }

  activeAttempts() {
    return [...this.active.values()].filter(tuple => Date.parse(tuple.material_expires_at) > Date.now()).map(tuple => tuple.attempt_id);
  }

  reservedAttempts() {
    if (!this.pending.size && !this.retry.size) return [];
    return this.journal.rootExecutions(this.runtimeId).filter(({tuple}) => (this.pending.has(tuple.receipt_id) || this.retry.has(tuple.receipt_id)) &&
      Date.parse(tuple.material_expires_at) > Date.now()).map(({tuple}) => tuple.attempt_id);
  }

  hasRecoveryCandidate() {
    return this.journal.rootExecutions(this.runtimeId).some(({tuple}) => Date.parse(tuple.material_expires_at) > Date.now());
  }

  hasReceipt(tuple: RootDeliveryTuple, digest: string) {
    return this.journal.rootExecutions(this.runtimeId).some(row => row.tuple.receipt_id === tuple.receipt_id &&
      this.journal.rootEnvelopeDigest(tuple) === digest);
  }

  async recover(onFailure: (attempt: string) => void, retryOnly = false) {
    if (retryOnly && !this.retry.size && !this.active.size) return;
    for (const { tuple, digest } of this.journal.rootExecutions(this.runtimeId)) {
      if (retryOnly && !this.retry.has(tuple.receipt_id) && this.active.get(tuple.attempt_id)?.receipt_id !== tuple.receipt_id) continue;
      try { await this.receive(tuple, digest); } catch { onFailure(tuple.attempt_id); }
    }
  }

  private async installAndStart(tuple: RootDeliveryTuple, digest: string, local: ReturnType<PlannedRestartJournal['receiveRootExecution']>) {
    let status = await this.receipts.status(tuple, digest);
    let locator: RootExecutionLocator | null = local.locator && { ...local.locator, started_at: null };
    if (!locator) {
      locator = await this.supervisor.ensureInstalled(tuple, status.lease_id!, status.fence_term!);
      this.journal.advanceRootExecution(tuple, digest, locator, 'installed');
    }
    if (status.ack_state === 'pending') {
      if (local.state === 'confirmed' || local.state === 'started') throw new Error('stale_execution');
      await this.receipts.acknowledge(tuple, digest, locator);
      status = await this.receipts.status(tuple, digest);
    }
    if (status.ack_state !== 'confirmed') throw new Error('stale_execution');
    if (local.state !== 'started') this.journal.advanceRootExecution(tuple, digest, locator, 'confirmed');
    let handle = await this.supervisor.attach(tuple, locator, status.lease_id!, status.fence_term!);
    if (local.state === 'started' && status.allowed_recovery_action === 'reattach_running') return;
    if (status.run_state === 'pending_start') {
      if (local.state === 'started') throw new Error('stale_execution');
      const delivery = await this.receipts.replay(tuple, status);
      const business = delivery.frozen_business_payload;
      if (rootBusinessPayloadDigest(business) !== tuple.business_payload_digest) throw new Error('receipt_conflict');
      const input = business.input as Record<string, unknown> | undefined;
      const proposed = input !== undefined && Object.hasOwn(input, 'policy_offer');
      const policy = (proposed ? input.policy_offer : input?.policy_receipt) as Record<string, unknown> | undefined;
      if (!policy || typeof policy.receipt_id !== 'string' || !policy.receipt_id ||
          typeof policy.offer_generation !== 'string' || !policy.offer_generation ||
          typeof policy.content_hash !== 'string' || !/^[0-9a-f]{64}$/.test(policy.content_hash)) {
        throw new DaemonProtocolRpcError('policy_offer_mismatch', false);
      }
      if (proposed) {
        if (typeof policy.workspace_id !== 'string' || !policy.workspace_id || policy.runtime_id !== tuple.runtime_id ||
            policy.daemon_id !== tuple.daemon_id || policy.attempt_id !== tuple.attempt_id) throw new DaemonProtocolRpcError('policy_offer_mismatch', false);
        const identity = { workspace_id:policy.workspace_id, runtime_id:tuple.runtime_id, daemon_id:tuple.daemon_id, attempt_id:tuple.attempt_id,
          receipt_id:policy.receipt_id, offer_generation:policy.offer_generation, content_hash:policy.content_hash };
        const adopted = await this.transport.rpc('task.offer_adopt',identity,tuple.runtime_id);
        if (adopted.state !== 'adopted' || (adopted.grant !== 'first' && adopted.grant !== 'replay') || !samePolicyOffer(identity,adopted)) {
          throw new DaemonProtocolRpcError('policy_offer_mismatch', false);
        }
      }
      const reply = await this.transport.event({ t: 'task.start', id: randomUUID(), rt: tuple.runtime_id, p: {
        task_id: tuple.attempt_id, root_receipt_id: tuple.receipt_id, handoff_id: tuple.handoff_id,
        receipt_id: policy.receipt_id, offer_generation: policy.offer_generation, content_hash: policy.content_hash,
        generation: tuple.handoff_generation, usage_run_id: tuple.consumer_id, execution_locator: locator,
        machine_proof: await this.receipts.proof(tuple, 'start'),
      } });
      if (reply.ok !== true || reply.execution_authorized !== true) throw new Error('stale_execution');
      status = await this.receipts.status(tuple, digest);
      if (status.allowed_recovery_action !== 'reattach_running') throw new Error('stale_execution');
      handle = await this.supervisor.attach(tuple, locator, status.lease_id!, status.fence_term!);
    }
    const startedAt = await this.supervisor.startOnce(handle);
    this.journal.advanceRootExecution(tuple, digest, { ...locator, started_at: startedAt }, 'started');
  }
}

export async function openRootRunConsumer(runtimeId: string, daemonId: string, openJournal: () => PlannedRestartJournal,
  protocol: DaemonProtocolClient, env = process.env) {
  const host = env.MULTIREMI_ROOT_HOST_DIR;
  const machine = env.MULTIREMI_ROOT_MACHINE_DIR;
  const supervisor = env.MULTIREMI_ROOT_SUPERVISOR_DIR;
  const serviceUid = env.MULTIREMI_ROOT_MACHINE_UID;
  const supervisorUid = env.MULTIREMI_ROOT_SUPERVISOR_UID;
  if ([host, machine, supervisor, serviceUid, supervisorUid].every(value => value === undefined)) return null;
  if (!host || !isAbsolute(host) || !machine || !isAbsolute(machine) || !supervisor || !isAbsolute(supervisor) ||
      !serviceUid || !/^\d+$/.test(serviceUid) || supervisorUid !== '0') throw new Error('Invalid root receiver configuration');
  const keys = new RootMachineClient(machine, Number(serviceUid));
  const binding = await keys.publicBinding();
  if (binding.runtimeId !== runtimeId || binding.daemonId !== daemonId) return null;
  const journal = openJournal();
  const receipts = new RootReceiptClient(protocol, keys);
  const {RootHostBridge} = await import('./root-host-bridge.js');
  const bridge = new RootHostBridge(host, receipts, keys, tuple => journal.rootEnvelopeDigest(tuple));
  const control = new RootRunSupervisor({endpoint: join(supervisor, 'control.sock'), supervisorUid: Number(supervisorUid)});
  await bridge.listen();
  return {consumer: new RootRunConsumer(runtimeId, journal, receipts, control, protocol), close: () => bridge.close()};
}
