import { PostgresSyncDatabase, type SqlDatabase } from '@multiremi/store/db/postgres.js';
import { openSqliteDatabase } from '@multiremi/store/db/sqlite.js';
import { PreparedAgentPat, type DelegationUse } from '@multiremi/store/durable-delegation.js';
import { PreparedRootDelivery, RootReceiptStore } from '@multiremi/store/root-receipts.js';
import { RootManagement } from '@multiremi/store/root-management.js';
import { withSecurityWrite } from '@multiremi/store/security-write.js';
import type { RootDeliveryTuple } from '@multiremi/contracts/root-delivery.js';

export type RaceInput = { action:'offer'; tuple:RootDeliveryTuple; business:{turn_id:string}; publicKey:JsonWebKey }
  | { action:'pat'|'revoke'; raw:string; use:DelegationUse; attemptId:string; agentId:string };

self.onmessage = async (event: MessageEvent<{backend:string;database:string;barrier:SharedArrayBuffer;input:RaceInput}>) => {
  const {backend,database,barrier,input}=event.data;
  const db=backend==='postgres' ? new PostgresSyncDatabase(database) : openSqliteDatabase(database) as unknown as SqlDatabase;
  try {
    if (backend==='sqlite') db.exec('PRAGMA busy_timeout=10000');
    const root=new RootManagement(db);
    const ready=()=>{
      const count=new Int32Array(barrier);
      if (Atomics.add(count,0,1)===0) {
        if (Atomics.wait(count,0,1,10000)==='timed-out') throw new Error('issuer barrier timeout');
      } else Atomics.notify(count,0);
    };
    if (input.action==='offer') {
      const key=await crypto.subtle.importKey('jwk',input.publicKey,{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
      const candidate=await PreparedRootDelivery.prepare(input.tuple,input.business,key);
      const plan=root.planFirstOffer(candidate);
      const receipts=new RootReceiptStore(db,root);
      ready();
      withSecurityWrite(db,'1',plan,tx=>receipts.activate(tx,candidate,{lease_id:'race',fence_term:'1',start_deadline:input.tuple.material_expires_at},(activeTx,material)=>{
        db.query("UPDATE multiremi_turn_attempts SET status='accepted' WHERE id=?").run(input.tuple.attempt_id);
        return root.issue(activeTx,material);
      }));
    } else {
      const proof=root.registeredCredentials.verify(input.raw);
      const candidate=PreparedAgentPat.prepare();
      const base=root.plan(proof,input.use);
      const plan={...base,domainTargets:[...base.domainTargets,`credential:${candidate.credentialId}`].sort()};
      ready();
      withSecurityWrite(db,'1',plan,tx=>{
        if (input.action==='revoke') return root.revokeAttemptDelegations(tx,input.attemptId,'security_compromised');
        root.issue(tx,{kind:'delegated-pat',actor:root.authorizeWrite(tx,proof,input.use),use:input.use,beneficiary:{type:'agent',id:input.agentId},candidate});
      });
    }
    self.postMessage('committed');
  } catch (error) { self.postMessage(error instanceof Error ? error.message : String(error)); }
  finally { db.close(); }
};
