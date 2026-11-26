import { expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RootDeliveryStatusResponse } from '@multiremi/contracts/root-delivery.js';
import { PlannedRestartJournal } from '@multiremi/worker/planned-restart-journal.js';
import { DaemonProtocolClient } from '@multiremi/worker/daemon-protocol-client.js';
import { MultiremiDaemon } from '@multiremi/worker/daemon.js';
import { releaseDaemonTrace } from '@multiremi/worker/trace-transport.js';
import { releaseDaemonOutbox } from '@multiremi/worker/report-transport.js';
import { disabledSshMeshRuntime } from '../../helpers/ssh-mesh-isolation.js';
import { RootRunConsumer, openRootRunConsumer } from '@multiremi/worker/root-run-consumer.js';
import { rootBusinessPayloadDigest } from '@shared/root-business-payload.js';
import { fixtureDeliveryStatusResponse, fixtureInitialRootDeliveryEnvelopePayload, fixtureInitialRootDeliveryTuple, fixtureExecutionLocator as locator,
  fixtureMachineProof, fixtureRootRestartResumeReply } from '../../fixtures/root-authority.js';

it('opens no root journal for an unconfigured or partially configured daemon', async () => {
  const protocol = new DaemonProtocolClient({serverUrl:'http://fixture', daemonId:'daemon', cliVersion:'0.2.96'});
  const open = () => { throw Error('unexpected journal open'); };
  expect(await openRootRunConsumer('runtime', 'daemon', open, protocol, {})).toBeNull();
  await expect(openRootRunConsumer('runtime', 'daemon', open, protocol, {MULTIREMI_ROOT_HOST_DIR:'/private'})).rejects.toThrow('Invalid root receiver configuration');
});

it('gates fresh offers and routes redelivery and bound resume through the same receiver', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'root-offer-'));
  const delivery = fixtureInitialRootDeliveryEnvelopePayload;
  const {runtime_id, daemon_id} = delivery.tuple;
  const protocol = new DaemonProtocolClient({serverUrl:'http://fixture', daemonId:daemon_id, cliVersion:'0.2.96'});
  spyOn(protocol, 'sharesCap').mockReturnValue(true);
  const daemon = new MultiremiDaemon({serverUrl:'http://fixture', runtimeId:runtime_id, daemonId:daemon_id,
    protocolClient:protocol, workspacesRoot:directory, outboxPath:':memory:', gcEnabled:false,
    sshMeshManager:disabledSshMeshRuntime(), maxConcurrency:1});
  const journal = new PlannedRestartJournal(':memory:');
  const unexpected = async () => { throw new Error('unexpected operation'); };
  const receiver = new RootRunConsumer(runtime_id, journal, {status:unexpected, replay:unexpected, proof:unexpected, acknowledge:unexpected},
    {ensureInstalled:unexpected, attach:unexpected, startOnce:unexpected}, protocol);
  daemon['rootReceiver'] = {consumer:receiver, close() {}};
  const receive = spyOn(receiver, 'receive').mockResolvedValue(undefined);
  try {
    await expect(daemon['receiveRootDelivery'](delivery, 0)).rejects.toMatchObject({code:'claims_paused'});
    daemon['ready'] = true;
    daemon['serverDrainActive'] = true;
    await expect(daemon['receiveRootDelivery'](delivery, 0)).rejects.toMatchObject({code:'draining'});
    daemon['serverDrainActive'] = false;
    await expect(daemon['receiveRootDelivery'](delivery, 1)).rejects.toMatchObject({code:'capacity'});
    daemon['activeTaskCount'] = 1;
    await expect(daemon['receiveRootDelivery'](delivery, 0)).rejects.toMatchObject({code:'capacity'});
    expect(receive).not.toHaveBeenCalled();
    expect(journal.rootExecutions(runtime_id)).toEqual([]);
    journal.receiveRootExecution(delivery.tuple, delivery.envelope_digest);
    await daemon['receiveRootDelivery'](delivery, 0);
    expect(receive).toHaveBeenCalledTimes(1);

    const reply = fixtureRootRestartResumeReply;
    const execution = {runtime_id, daemon_id, workspace_id:'local', attempt_id:reply.attempt_id,
      handoff_id:reply.handoff_id, turn_id:reply.turn_id, generation:reply.generation-1};
    daemon['restartJournal'] = journal;
    const {generation, ...scope} = execution;
    const entry = journal.prepare(execution, {version:1, session_id:null, work_dir:null, trace_head:0, input_ack_seq:0, delivered_message_ids:[],
      policy_receipt:{...scope, prior_restart_generation:generation, offer_generation:'offer', content_hash:'a'.repeat(64), receipt_id:'adopted'}});
    journal.acknowledge(reply.handoff_id);
    daemon['restartRecoveryCandidates'].add(reply.handoff_id);
    spyOn(daemon as unknown as {preflightRestart():Promise<boolean>}, 'preflightRestart').mockResolvedValue(true);
    const resumed = {...reply.root_delivery, tuple:{...reply.root_delivery.tuple, consumer_id:entry.consumer_id}};
    spyOn(daemon['taskDownlinks'], 'rpc').mockResolvedValue({...reply, root_delivery:resumed});
    const ordinaryRun = spyOn(daemon as unknown as {handleTask():Promise<void>}, 'handleTask');
    await daemon['resumePlannedRestarts']();
    expect(receive).toHaveBeenLastCalledWith(resumed.tuple, resumed.envelope_digest);
    expect(journal.get(reply.handoff_id)?.state).toBe('resumed');
    expect(journal.claimLaunch(journal.get(reply.handoff_id)!)).toBe(false);
    expect(ordinaryRun).not.toHaveBeenCalled();
  } finally {
    daemon.stop();
    await releaseDaemonTrace(protocol);
    await releaseDaemonOutbox(protocol);
    journal.close();
    rmSync(directory, {recursive:true, force:true});
  }
});

for (const interrupt of ['install', 'ack', 'adopt', 'event', 'startOnce']) {
  it(`recovers after losing the ${interrupt} reply and reattaches the same execution`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'root-receiver-'));
    const path = join(directory, 'journal.db');
    const policy = { workspace_id:'local', attempt_id:fixtureInitialRootDeliveryTuple.attempt_id, runtime_id:fixtureInitialRootDeliveryTuple.runtime_id,
      daemon_id:fixtureInitialRootDeliveryTuple.daemon_id, receipt_id:'adopted-policy-receipt', offer_generation:'generation', content_hash:'e'.repeat(64) };
    const business = {input:{policy_offer:policy}};
    const tuple = {...fixtureInitialRootDeliveryTuple, business_payload_digest:rootBusinessPayloadDigest(business),
      material_expires_at:new Date(Date.now()+60_000).toISOString()};
    const firstJournal = new PlannedRestartJournal(path);
    let journal = firstJournal;
    const digest = fixtureDeliveryStatusResponse.envelope_digest;
    const started = new Date().toISOString();
    let status: RootDeliveryStatusResponse = { ...fixtureDeliveryStatusResponse, tuple };
    let revoked = false, interrupted = false, adopted = false, launches = 0, events = 0;
    const lose = (step: string) => {
      if (interrupt === step && !interrupted) { interrupted = true; throw new Error('reply lost'); }
    };
    const receiver = () => new RootRunConsumer(tuple.runtime_id, journal, {
      status: async () => { if (revoked) throw Error('stale_execution'); return status; },
      replay: async () => ({...fixtureInitialRootDeliveryEnvelopePayload, tuple, frozen_business_payload:business}),
      proof: async () => fixtureMachineProof,
      acknowledge: async (bound, hash, target) => {
        expect([bound, hash, target]).toEqual([tuple, digest, locator]);
        status = {...status, ack_state: 'confirmed', allowed_recovery_action: 'start_execution'};
        lose('ack');
        return {ok: true};
      },
    }, {
      ensureInstalled: async () => { expect(journal.rootEnvelopeDigest(tuple)).toBe(digest); lose('install'); return locator; },
      attach: async (bound, target, lease, term) => {
        expect(target).toEqual(locator);
        expect(lease).toBe(status.lease_id!);
        expect(term).toBe(status.fence_term!);
        return { tuple: bound, locator: target, lease, term, generation: 'controller' };
      },
      startOnce: async handle => {
        expect(status.run_state).toBe('running');
        expect(handle.lease).toBe('running-lease');
        if (!launches) launches++;
        lose('startOnce');
        return started;
      },
    }, {
      rpc: async (method, identity, runtime) => {
        expect([method,identity,runtime]).toEqual(['task.offer_adopt',policy,tuple.runtime_id]);
        const grant = adopted ? 'replay' : 'first';
        adopted = true;
        lose('adopt');
        return {ok:true,state:'adopted',grant,...policy};
      },
      event: async frame => {
        expect(adopted).toBe(true);
        expect(frame).toMatchObject({t:'task.start', rt:tuple.runtime_id, p:{receipt_id:policy.receipt_id,offer_generation:policy.offer_generation,content_hash:policy.content_hash,task_id:tuple.attempt_id,
          root_receipt_id:tuple.receipt_id, execution_locator:locator, machine_proof:fixtureMachineProof}});
        events++;
        status = {...status, run_state:'running', lease_id:'running-lease', allowed_recovery_action:'reattach_running'};
        lose('event');
        return {ok:true, execution_authorized:true};
      },
    });
    try {
      const original = receiver();
      const first = original.receive(tuple, digest);
      expect(original.activeAttempts()).toEqual([]);
      expect(original.reservedAttempts()).toEqual([tuple.attempt_id]);
      expect(original.receive(tuple, digest)).toBe(first);
      await expect(first).rejects.toThrow('reply lost');
      journal = new PlannedRestartJournal(path);
      const recovered = receiver();
      expect(recovered.activeAttempts()).toEqual([]);
      if (interrupt === 'ack') {
        policy.receipt_id = 'substituted';
        await expect(recovered.receive(tuple, digest)).rejects.toThrow('receipt_conflict');
        expect(events).toBe(0);
        policy.receipt_id = 'adopted-policy-receipt';
      }
      const failures: string[] = [];
      await recovered.recover(attempt => failures.push(attempt));
      expect(failures).toEqual([]);
      expect(recovered.activeAttempts()).toEqual([tuple.attempt_id]);
      expect(recovered.reservedAttempts()).toEqual([]);
      await recovered.receive(tuple, digest);
      expect(journal.receiveRootExecution(tuple, digest)).toEqual({state:'started', launchIdentity:locator.launch_identity,
        locator:{...locator, started_at:started}});
      revoked = true;
      await expect(original.receive(tuple, digest)).rejects.toThrow('stale_execution');
      await expect(recovered.receive(tuple, digest)).rejects.toThrow('stale_execution');
      expect(recovered.activeAttempts()).toEqual([]);
      expect([events, launches]).toEqual([1, 1]);
    } finally {
      if (journal !== firstJournal) journal.close();
      firstJournal.close();
      rmSync(directory, {recursive:true, force:true});
    }
  });
}
