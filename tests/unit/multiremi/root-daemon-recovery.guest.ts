import { expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, chownSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { startMultiremiServer } from '@multiremi/api.js';
import { pendingTurnBackendTests } from './pending-turn-test-backends.js';
import { prepareRecoveryAdmission, recoveryIdentity } from './root-daemon-recovery-fixture.js';

const tests = '/repo/tests/unit/multiremi';
const runtime = '/repo/packages/daemon/src/agent-runtime';
const drop = 'import os,sys; uid=int(sys.argv[1]); os.setgroups([]); os.setgid(uid); os.setuid(uid); os.execv(sys.argv[2], sys.argv[2:])';
if (!process.env.MULTIREMI_TEST_POSTGRES_URL || process.env.MULTIREMI_TEST_LOCK_ORDER_SENTINEL !== '1') throw Error('Dual database and sentinel required');

pendingTurnBackendTests('multi-UID root consumer with one authority database', (fixture, backend) => {
  it.each(['before disconnect','after reconnect'] as const)('recovers interrupted ACKs and a lost start reply with one model, run and Q created %s', async questionTiming => {
    const {db,store} = fixture();
    if (backend === 'PostgreSQL') expect(Number(db.query("SELECT current_setting('server_version_num') AS version").get().version)).toBe(170012);
    const root = mkdtempSync('/srv/a2-');
    chmodSync(root,0o755);
    for (const [name,uid,gid,mode] of [['public',0,0,0o711],['private',0,0,0o700],['daemon',1101,1101,0o700],
      ['machine',1102,1101,0o2750],['execution',1103,1103,0o700]] as const) {
      const path = `${root}/${name}`; mkdirSync(path); chownSync(path,uid,gid); chmodSync(path,mode);
    }
    const children = new Set<ChildProcess>();
    function launch(command: string[], uid?: number) {
      const args = uid ? ['/usr/bin/python3','-c',drop,String(uid),...command] : command;
      const child = spawn(args[0],args.slice(1),{stdio:['pipe','pipe','inherit'],env:{PATH:'/usr/bin:/bin',HOME:'/tmp'},cwd:'/repo'});
      children.add(child);
      const exited = once(child,'exit').then(([code]) => { children.delete(child); return code; });
      const lines = createInterface({input:child.stdout})[Symbol.asyncIterator]();
      async function next(prefix = '') {
        for (;;) {
          const line = await lines.next();
          if (line.done) throw Error(`Guest process exited (${await exited})`);
          if (line.value.startsWith(prefix)) return line.value.slice(prefix.length);
        }
      }
      return {child,exited,next};
    }
    const server = startMultiremiServer({store,port:0,hostname:'127.0.0.1',authToken:'isolated-master',backgroundJobs:true,daemonWelcomeCaps:['root.delivery','prompt.policy.adopt.v1']});
    const origin = `http://127.0.0.1:${server.port}`;
    const modelServer = createServer();
    const modelConnected = once(modelServer,'connection').then(([socket]) => ({socket,replies:createInterface({input:socket})[Symbol.asyncIterator]()}));
    modelServer.listen(`${root}/model.sock`);
    const jwtKeys = ['JWT_SECRET','MULTIREMI_JWT_SIGNING_DOMAIN','MULTIREMI_JWT_KEY_EPOCH'];
    const prior = jwtKeys.map(key=>process.env[key]);
    try {
      await once(modelServer,'listening'); chmodSync(`${root}/model.sock`,0o660); chownSync(`${root}/model.sock`,0,1103);
      writeFileSync(`${root}/binding.json`,JSON.stringify({identity:recoveryIdentity(),daemonUid:1101,executionUids:[1103],supervisorTargetSocket:`${root}/public/target.sock`}));
      const key = launch(['/usr/bin/python3',`${tests}/root-daemon-recovery-key.py`,root],1102);
      const publicKeys = JSON.parse(await key.next()); expect(publicKeys.uid).toBe(1102);
      const controller = (mode: string) => launch(['/bun',`${tests}/root-daemon-recovery-controller.ts`,root,mode],1101);
      const bindingReader = controller('binding');
      const binding = JSON.parse(await bindingReader.next());
      expect(await bindingReader.exited).toBe(0);
      expect(binding).toMatchObject({signingSpki:publicKeys.signing,recipientSpki:publicKeys.recipient});
      const {target,human,signing,execution} = await prepareRecoveryAdmission(fixture(),binding,async challenge=>{
        const signer = controller('sign'); signer.child.stdin.end(JSON.stringify(challenge));
        const proof = JSON.parse(await signer.next()); expect(await signer.exited).toBe(0); return proof;
      });
      const workspace = store.createWorkspace({name:'Guest protected target',slug:'guest-target'});
      const url = `${origin}/api/workspaces/${workspace.id}`;
      Object.assign(process.env,{JWT_SECRET:signing.secret,MULTIREMI_JWT_SIGNING_DOMAIN:signing.domainId,MULTIREMI_JWT_KEY_EPOCH:signing.keyEpoch});
      writeFileSync(`${root}/offer`,JSON.stringify({origin,tuple:{runtime_id:execution.runtimeId,daemon_id:execution.daemonId}}));
      const issuer = controller('offer');
      const delivery = JSON.parse(await issuer.next('GUEST '));
      expect(await issuer.exited).toBe(0);
      const {tuple,envelope_digest:digest} = delivery;
      const reportPolicy = delivery.frozen_business_payload.input.policy_offer;
      expect(reportPolicy).toMatchObject({workspace_id:'local',runtime_id:execution.runtimeId,daemon_id:execution.daemonId,attempt_id:target.attemptId});
      expect(reportPolicy.receipt_id).toMatch(/^[0-9a-f]{64}$/);
      expect(reportPolicy.offer_generation).toMatch(/\S/);
      expect(reportPolicy.content_hash).toMatch(/^[0-9a-f]{64}$/);
      writeFileSync(`${root}/offer`,JSON.stringify({tuple,digest,origin,reportPolicy}));
      const node = '/usr/bin/node';
      writeFileSync(`${root}/plans`,JSON.stringify({plans:[{tuple,uid:1103,gid:1103,file:node,args:[`${tests}/root-daemon-recovery-model.mjs`,root,url],
        cwd:'/srv',sha256:createHash('sha256').update(readFileSync(node)).digest('hex')}]}));
      writeFileSync(`${root}/config`,JSON.stringify({directory:`${root}/private`,publicDirectory:`${root}/public`,daemonUid:1101,daemonGid:1101,
        keyServiceUid:1102,keyServiceGid:1102,hostSocket:`${root}/daemon/host.sock`,approvedPlansFile:`${root}/plans`}));
      const supervisor = launch([node,`${runtime}/root-run-service.mjs`,`${root}/config`]);
      expect(await supervisor.next()).toBe('root run supervisor ready');
      const state = () => db.query('SELECT ack_state,run_state,material_version FROM multiremi_delivery_receipts WHERE receipt_id=?').get(tuple.receipt_id);
      for (const [mode,code,ack,run] of [['before-ack',41,'pending','pending_start'],['after-ack',42,'confirmed','pending_start'],
        ['after-start',43,'confirmed','running']] as const) {
        console.log(`guest ${backend} ${mode}`);
        expect(await controller(mode).exited).toBe(code);
        expect(state()).toMatchObject({ack_state:ack,run_state:run,material_version:tuple.material_version});
      }
      const original = controller('resume'); expect(JSON.parse(await original.next('GUEST '))).toEqual({ready:true,uid:1101});
      console.log(`guest ${backend} consumer resumed, waiting for model`);
      const {socket,replies} = await modelConnected;
      const next = async () => { const line = await replies.next(); if (line.done) throw Error('Model exited'); return JSON.parse(line.value); };
      const model = await next(); expect(model).toMatchObject({uid:1103,version:String(tuple.delivery_version)});
      expect(Number.isSafeInteger(model.pid) && model.pid > 1).toBe(true);
      const ask = async (command:object) => {socket.write(JSON.stringify(command)+'\n'); return next();};
      expect(await ask({name:'Before daemon loss'})).toEqual({pid:model.pid,status:200});
      const copy = await ask({copy:true,name:'Replica before loss'}); expect(copy.status).toBe(200); expect(copy.pid).not.toBe(model.pid);
      expect(Number.isSafeInteger(copy.pid) && copy.pid > 1).toBe(true);
      const createQuestion = async (daemon: typeof original) => {
        daemon.child.stdin.write(JSON.stringify(await ask({question:true}))+'\n');
        const {question} = JSON.parse(await daemon.next('GUEST '));
        expect(question).toMatch(/\S/);
        expect(store.getQuestion(question)).toMatchObject({id:question,status:'pending',wait_status:'waiting',source_attempt_id:tuple.attempt_id});
        return question;
      };
      let questionId = questionTiming === 'before disconnect' ? await createQuestion(original) : undefined;
      original.child.kill('SIGKILL'); await original.exited;
      const restored = controller('resume'); expect(JSON.parse(await restored.next('GUEST '))).toEqual({ready:true,uid:1101});
      expect(await ask({name:'After daemon recovery'})).toEqual({pid:model.pid,status:200});
      if (questionTiming === 'after reconnect') questionId = await createQuestion(restored);
      expect(store.getQuestion(questionId)).toMatchObject({id:questionId,status:'pending',wait_status:'waiting',source_attempt_id:tuple.attempt_id});
      expect(store.getWorkspace(workspace.id)?.name).toBe('After daemon recovery');
      expect(readFileSync(`${root}/execution/launches`,'utf8').trim().split('\n')).toEqual([String(model.pid)]);
      const task = store.getTask(tuple.attempt_id)!;
      expect(store.listIssueQuestions(task.issueId!).map(entry=>entry.id)).toEqual([questionId]);
      expect(Number(db.query('SELECT COUNT(*) AS count FROM multiremi_usage_runs WHERE task_id=?').get(task.id).count)).toBe(1);
      expect(state()).toMatchObject({run_state:'running',material_version:tuple.material_version});
      db.query('UPDATE multiremi_authority_nodes SET revoked_at_ms=? WHERE node_id=?').run(Date.now(),'provider');
      expect(await ask({name:'Revoked original'})).toEqual({pid:model.pid,status:401});
      expect(await ask({copy:true,name:'Revoked replica'})).toEqual({pid:copy.pid,status:401});
      expect(store.getWorkspace(workspace.id)?.name).toBe('After daemon recovery');
      const response = await fetch(url,{method:'PATCH',headers:{authorization:`Bearer ${human}`,'content-type':'application/json'},body:JSON.stringify({name:'Independent human'})});
      expect(response.status).toBe(200); await response.text(); expect(store.getWorkspace(workspace.id)?.name).toBe('Independent human');
      socket.end();
    } finally {
      for (const child of children) child.kill('SIGKILL');
      modelServer.close(); await server.stop(true);
      jwtKeys.forEach((key,index)=>{if (prior[index]===undefined) delete process.env[key]; else process.env[key]=prior[index];});
      rmSync(root,{recursive:true,force:true});
    }
  },180000);
});
