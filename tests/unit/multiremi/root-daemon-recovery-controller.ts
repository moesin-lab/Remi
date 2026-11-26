import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { DAEMON_MIN_CLI_VERSION } from '@multiremi/contracts/daemon-protocol.js';
import { DaemonProtocolClient, DaemonProtocolRpcError, type DaemonProtocolLane } from '@multiremi/worker/daemon-protocol-client.js';
import { PlannedRestartJournal } from '@multiremi/worker/planned-restart-journal.js';
import { openRootRunConsumer } from '@multiremi/worker/root-run-consumer.js';
import { RootMachineClient } from '@daemon/agent-runtime/root-machine-client.js';
import { classifyDaemonTaskOfferPayload } from '@multiremi/contracts/root-delivery.js';

const [root, fault] = process.argv.slice(2);
if (process.geteuid!() !== 1101 || process.getgid!() !== 1101) throw Error('Expected the guest daemon identity');
if (fault === 'binding' || fault === 'sign') {
  const keys = new RootMachineClient(`${root}/machine`,1102);
  const reply = fault === 'binding' ? await keys.publicBinding() : await keys.answerChallenge(JSON.parse(await Bun.stdin.text()));
  console.log(JSON.stringify(reply));
  process.exit(0);
}
const { tuple, digest, origin, reportPolicy } = JSON.parse(readFileSync(`${root}/offer`, 'utf8'));
const issuing = fault === 'offer';
const firstOffer = Promise.withResolvers<unknown>();
const journal = new PlannedRestartJournal(`${root}/daemon/journal`);
const client = new DaemonProtocolClient({serverUrl:origin, token:'machine-token', daemonId:tuple.daemon_id,
  cliVersion:DAEMON_MIN_CLI_VERSION, caps:['root.delivery','prompt.policy.adopt.v1'],onFrame(frame) {
    if (issuing && frame.type === 'task.offer') {
      const offer = classifyDaemonTaskOfferPayload(frame.payload);
      if (offer.kind === 'root') firstOffer.resolve(offer.payload.root_delivery);
      else firstOffer.reject(Error('Expected a root task offer'));
    }
  }});
const rpc = client.rpc.bind(client);
client.rpc = async (method, ...args) => {
  if (method === 'delivery.receipt.install_ack' && fault === 'before-ack') process.exit(41);
  const reply = await rpc(method, ...args).catch(error => {
    console.error(`guest ${fault} ${method} failed (${error instanceof DaemonProtocolRpcError ? error.code : 'transport'})`);
    throw error;
  });
  if (method === 'task.offer_adopt' && (reply.state !== 'adopted' || reply.receipt_id !== reportPolicy.receipt_id)) {
    console.error('guest adoption response',Object.keys(reply).sort(),{adopted:reply.state==='adopted',matchingReceipt:reply.receipt_id===reportPolicy.receipt_id});
    throw Error('Missing adoption for sealed offer');
  }
  if (method === 'delivery.receipt.install_ack' && fault === 'after-ack' && reply.ok) process.exit(42);
  return reply;
};
const event = client.event.bind(client);
client.event = async frame => {
  const reply = await event(frame).catch(error => {
    console.error(`guest ${fault} ${frame.t} failed (${error instanceof DaemonProtocolRpcError ? error.code : 'transport'})`);
    throw error;
  });
  if (frame.t === 'task.start' && fault === 'after-start' && reply.execution_authorized) process.exit(43);
  return reply;
};
const confirmed = Promise.withResolvers<void>();
const lane: DaemonProtocolLane = {runtime:()=>({runtime_id:tuple.runtime_id, provider:'codex', max_concurrency:1,
  active_task_ids:issuing ? [] : [tuple.attempt_id], capabilities:{root_delivery_protocol:1,root_carrier_modes:['immutable_run_env']}}),
  heartbeat:()=>({active_task_count:issuing ? 0 : 1}), onRuntimeConfirmed:confirmed.resolve, async onHeartbeatAck(){}, async probeUpgrade(){}, async onTerminal(){} };
client.addLane(lane);
client.startLane(lane);
await confirmed.promise;
if (issuing) {
  client.send({t:'runtime.ready',rt:tuple.runtime_id,p:{active_task_ids:[]}});
  const timer = setTimeout(()=>firstOffer.reject(Error('No signed task.offer within 20 seconds')),20000);
  try { console.log('GUEST ' + JSON.stringify(await firstOffer.promise)); }
  finally { clearTimeout(timer); client.stopLane(lane); journal.close(); }
  process.exit(0);
}
const live = await openRootRunConsumer(tuple.runtime_id,tuple.daemon_id,()=>journal,client,{
  MULTIREMI_ROOT_HOST_DIR:`${root}/daemon`, MULTIREMI_ROOT_MACHINE_DIR:`${root}/machine`, MULTIREMI_ROOT_SUPERVISOR_DIR:`${root}/public`,
  MULTIREMI_ROOT_MACHINE_UID:'1102', MULTIREMI_ROOT_SUPERVISOR_UID:'0',
});
if (!live) throw Error('Machine binding mismatch');
const receive = live.consumer.receive.bind(live.consumer);
live.consumer.receive = async (...args) => {
  try { return await receive(...args); }
  catch (error) {
    const reason = error instanceof Error ? error.message : '';
    console.error(`guest ${fault} recovery rejected (${/^[\w :().-]{1,100}$/.test(reason) ? reason : 'unclassified'})`);
    throw error;
  }
};
try {
  if (fault === 'before-ack') await live.consumer.receive(tuple,digest);
  else {
    const failed: string[] = [];
    await live.consumer.recover(attempt => failed.push(attempt));
    if (failed.length) throw Error(`Failed recovery for ${failed.join(',')}`);
  }
  await live.consumer.receive(tuple,digest);
  console.log('GUEST ' + JSON.stringify({ready:true,uid:process.geteuid!()}));
  for await (const line of createInterface({input:process.stdin})) {
    const question = JSON.parse(line);
    if (question.reply_message_id) {
      const payload = {...question,...reportPolicy};
      const saved = await client.rpc('turn.decision.get',payload,tuple.runtime_id);
      if ((saved.reply as {id?:string} | null)?.id !== question.reply_message_id) throw Error('Original answer was not delivered');
      const consumed = await client.rpc('turn.decision.consume',payload,tuple.runtime_id);
      console.log('GUEST ' + JSON.stringify({consumed:consumed.ok}));
      continue;
    }
    const result = await client.rpc('turn.decision',{...question,...reportPolicy},tuple.runtime_id);
    console.log('GUEST ' + JSON.stringify({question:result.message_id}));
  }
} finally { live.close(); client.stopLane(lane); journal.close(); }
