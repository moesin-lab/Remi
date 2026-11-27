import { expect, it } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RootMachineKeys } from '@daemon/agent-runtime/root-machine-keys.js';
import { RootManagement } from '@multiremi/store/root-management.js';
import { machineEnrollmentPayload, machineRetirementPayload } from '@multiremi/store/machine-enrollment.js';
import { withSecurityWrite, type SecurityTx } from '@multiremi/store/security-write.js';
import { pendingTurnBackendTests } from './pending-turn-test-backends.js';

pendingTurnBackendTests('machine enrollment', fixture => {
  it('requires deployment and isolation signatures, rotates by generation and retires the active node', () => {
    const { db, databaseUrl } = fixture();
    const kernel = new RootManagement(db);
    const deployment = generateKeyPairSync('ed25519');
    const attestor = generateKeyPairSync('ed25519');
    const machine = generateKeyPairSync('ed25519');
    const recipient = generateKeyPairSync('rsa', { modulusLength: 3072 });
    const pem = (key: typeof machine.publicKey) => key.export({type:'spki',format:'pem'}).toString();
    const now = Date.now();
    const digest = 'ab'.repeat(32);
    db.run(`INSERT INTO multiremi_authority_nodes VALUES('deployment',1,1,'deployment_origin','deployment','test','system',0,9999999999999,NULL,0)`);
    db.query(`INSERT INTO multiremi_machine_deployment_roots VALUES('test','deployment',?,?)`).run(pem(deployment.publicKey),pem(attestor.publicKey));
    db.run(`INSERT INTO multiremi_runtimes(id,name,provider,daemon_id,workspace_id,created_at,updated_at) VALUES('rt','test','codex','daemon','local','now','now')`);
    db.query(`INSERT INTO multiremi_access_tokens(id,workspace_id,daemon_id,name,type,token_hash,token_prefix,created_at)
      VALUES('token','local','daemon','test','daemon',?,'test','now')`).run(digest);
    const bindingFor = (incarnation: string) => new RootMachineKeys({ deploymentId:'test', runtimeId:'rt', daemonId:'daemon', incarnation, consumerId:'consumer', credentialId:'token',
      credentialDigest:digest, recipientKeyId:'key', keyExpiresAtMs:now+120000 },recipient.privateKey,machine.privateKey).publicBinding();
    let binding = bindingFor('first');
    const attestation = {id:'report', isolationVerifiedAtMs:now, immutableCarrierVerifiedAtMs:now, expiresAtMs:now+60000};
    const transact = <T>(revision: number, oldNode: string | null, run: (tx: SecurityTx) => T) => withSecurityWrite(db,undefined,
      {expectedRevision:revision,workspaceIds:['local'],numberKeys:[],domainTargets:['authority:deployment','machine:rt',...(oldNode?[`authority:${oldNode}`]:[])].sort()},run);
    const enroll = (generation: number, revision: number, prior: string | null, issuer = deployment, host = attestor) => {
      const proof = sign(null,machineEnrollmentPayload('deployment',binding,attestation,generation),issuer.privateKey).toString('base64url');
      const signature = sign(null,machineEnrollmentPayload('attestation',binding,attestation,generation),host.privateKey).toString('base64url');
      return transact(revision,prior,tx=>kernel.enrollMachine(tx,proof,{...attestation,signature},binding,generation));
    };
    expect(()=>enroll(0,0,null,machine)).toThrow('root_authority_revoked');
    expect(()=>enroll(0,0,null,deployment,machine)).toThrow('root_authority_revoked');
    const first = enroll(0,0,null);
    expect(first.generation).toBe(1);
    binding=bindingFor('second');
    expect(()=>enroll(0,1,first.nodeId)).toThrow('authority_revision_conflict');
    const second = enroll(1,1,first.nodeId);
    expect(second.generation).toBe(2);
    expect(db.query('SELECT revoked_at_ms FROM multiremi_authority_nodes WHERE node_id=?').get(first.nodeId).revoked_at_ms).toBeTruthy();
    const proof = sign(null,machineRetirementPayload('test','rt','second',2),deployment.privateKey).toString('base64url');
    transact(2,second.nodeId,tx=>kernel.retireMachine(tx,proof,'test','rt','second',2));
    expect(db.query('SELECT incarnation FROM multiremi_machine_enrollments WHERE retired_at_ms IS NULL').all()).toEqual([]);
    expect(()=>transact(3,second.nodeId,tx=>kernel.retireMachine(tx,proof,'test','rt','second',2))).toThrow('authority_revision_conflict');
    const directory = mkdtempSync(join(tmpdir(),'machine-enroll-'));
    try {
      binding = bindingFor('third');
      const bundle = join(directory,'enrollment.json');
      const sqlite = join(directory,'server.sqlite');
      if (!databaseUrl) db.query('VACUUM INTO ?').run(sqlite);
      const invoke = (signer:typeof deployment) => {
        writeFileSync(bundle, JSON.stringify({binding, expectedGeneration:2,
          deploymentProof:sign(null,machineEnrollmentPayload('deployment',binding,attestation,2),signer.privateKey).toString('base64url'),
          attestation:{...attestation,signature:sign(null,machineEnrollmentPayload('attestation',binding,attestation,2),attestor.privateKey).toString('base64url')}}));
        return Bun.spawnSync([process.execPath,'apps/remi/main.ts','db','enroll-machine','--bundle',bundle,...(databaseUrl?[]:['--sqlite-file',sqlite])],
          {env:{...process.env,MULTIREMI_DATABASE_URL:databaseUrl??''},stdout:'pipe',stderr:'pipe'});
      };
      expect(invoke(machine).exitCode).not.toBe(0);
      const registered = invoke(deployment);
      expect(registered.exitCode).toBe(0);
      expect(JSON.parse(registered.stdout.toString())).toMatchObject({generation:3});
      expect(invoke(deployment).exitCode).not.toBe(0);
    } finally { rmSync(directory,{recursive:true,force:true}); }
  }, 30_000);
});
