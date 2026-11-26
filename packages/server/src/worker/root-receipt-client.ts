import { isDeepStrictEqual } from 'node:util';
import { assertStatusResponseHasNoSecrets, type RootDeliveryEnvelopePayload, type RootDeliveryMachineProof,
  type RootDeliveryStatusResponse, type RootDeliveryTuple, type RootExecutionLocator } from '@multiremi/contracts/root-delivery.js';
import type { MachineChallenge } from '@shared/machine-challenge.js';
import type { DaemonProtocolClient } from './daemon-protocol-client.js';

type ReceiptAction = 'status' | 'replay' | 'install_ack' | 'start';

export class RootReceiptClient {
  constructor(private readonly transport: Pick<DaemonProtocolClient, 'rpc'>,
    private readonly keys: { answerChallenge(challenge: MachineChallenge): Promise<RootDeliveryMachineProof> }) {}

  async proof(tuple: RootDeliveryTuple, action: ReceiptAction) {
    const response = await this.transport.rpc('delivery.receipt.challenge', {action, attempt_id:tuple.attempt_id,
      handoff_id:tuple.handoff_id, receipt_id:tuple.receipt_id, consumer_id:tuple.consumer_id}, tuple.runtime_id);
    const challenge = response.challenge as MachineChallenge | undefined;
    if (response.ok !== true || !challenge || challenge.targetId !== tuple.receipt_id || challenge.purpose !==
        (action === 'start' ? 'task.start' : `delivery.receipt.${action}`)) throw new Error('stale_execution');
    const proof = await this.keys.answerChallenge(challenge);
    if (proof.runtime_id !== tuple.runtime_id || proof.daemon_id !== tuple.daemon_id || proof.incarnation !== tuple.incarnation ||
        proof.consumer_id !== tuple.consumer_id || proof.recipient_key_id !== tuple.recipient_key_id ||
        proof.recipient_key_fingerprint !== tuple.recipient_key_fingerprint) throw new Error('stale_execution');
    return proof;
  }

  async status(tuple: RootDeliveryTuple, digest: string): Promise<RootDeliveryStatusResponse> {
    const reply = await this.transport.rpc('delivery.receipt.status', {execution_key:{attempt_id:tuple.attempt_id,
      receipt_id:tuple.receipt_id, handoff_id:tuple.handoff_id}, machine_proof:await this.proof(tuple,'status')}, tuple.runtime_id);
    assertStatusResponseHasNoSecrets(reply);
    const action = reply.run_state === 'running' && reply.ack_state === 'confirmed' ? 'reattach_running' :
      reply.run_state === 'pending_start' && Date.parse(String(reply.start_deadline)) > Date.now() ?
        ({pending:'replay_envelope', confirmed:'start_execution'} as Record<string,string>)[String(reply.ack_state)] : undefined;
    if (!action || reply.allowed_recovery_action !== action || reply.ok !== true || reply.committed !== true ||
        !isDeepStrictEqual(reply.tuple,tuple) || reply.envelope_digest !== digest || !reply.lease_id || !reply.fence_term ||
        !(Date.parse(tuple.material_expires_at) > Date.now())) throw new Error('stale_execution');
    return reply as unknown as RootDeliveryStatusResponse;
  }

  async replay(tuple: RootDeliveryTuple, status: RootDeliveryStatusResponse): Promise<RootDeliveryEnvelopePayload> {
    const reply = await this.transport.rpc('delivery.receipt.replay', {receipt_id:tuple.receipt_id,
      expected_receipt_version:tuple.receipt_version, expected_delivery_version:tuple.delivery_version,
      run_lease_id:status.lease_id, fence_term:status.fence_term, machine_proof:await this.proof(tuple,'replay')},tuple.runtime_id);
    if (reply.ok !== true || reply.replay !== true || !isDeepStrictEqual(reply.tuple,tuple) || reply.envelope_digest !== status.envelope_digest ||
        reply.lease_id !== status.lease_id || reply.fence_term !== status.fence_term || reply.run_state !== status.run_state ||
        reply.start_deadline !== status.start_deadline || typeof reply.envelope !== 'string') throw new Error('stale_execution');
    return reply as unknown as RootDeliveryEnvelopePayload;
  }

  async acknowledge(tuple: RootDeliveryTuple, digest: string, locator: RootExecutionLocator) {
    const reply = await this.transport.rpc('delivery.receipt.install_ack', {tuple, envelope_digest:digest, execution_locator:locator,
      installed_at:new Date().toISOString(), machine_proof:await this.proof(tuple,'install_ack')},tuple.runtime_id);
    if (reply.ok !== true || reply.ack_state !== 'confirmed') throw new Error('stale_execution');
    return reply;
  }
}
