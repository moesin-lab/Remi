import { expect, it } from 'bun:test';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { runtimeConnectionSnapshot } from '@multiremi/contracts/runtime-connection.js';
import { readWorkspacePromptSettings } from '@multiremi/prompts/workspace-settings.js';
import { agentDependencyDigest } from '@multiremi/store/agent-dependencies.js';
import type { AgentConfigurationApproval } from '@multiremi/store/agent-source-approvals.js';
import { beginMachineChallenge } from '@multiremi/store/machine-proof.js';
import type { SqlDatabase } from '@multiremi/store/db/postgres.js';
import { withSecurityWrite } from '@multiremi/store/security-write.js';
import { bootstrap } from './fixtures/root-kernel-bootstrap.js';
import { pendingTurnBackendTests } from './pending-turn-test-backends.js';

pendingTurnBackendTests('production root attempt inputs', fixture => {
  it('admits only frozen execution and the reviewed, versioned turn messages on create and retry', async () => {
    const { store, createIssue } = fixture();
    const { db } = store as unknown as { db: SqlDatabase };
    const runtime = store.registerRuntime({ name: 'worker', provider: 'codex', workspaceId: 'local', daemonId: 'worker' });
    const agent = store.createAgent({ name: 'reviewer', provider: 'codex', runtimeId: runtime.id });
    const issue = createIssue({ title: 'inputs', assigneeType: 'agent', assigneeId: agent.id });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const { input: login } = await bootstrap(db, store.resolveAgentDependencies);
    const service = store.rootManagement;
    const proof = await service.verifyIndependentPassword(login.userId, 'test-dashboard-password');
    const expiry = Date.now() + 3_600_000;
    const hash = createHash('sha256').update('test-daemon').digest('hex');
    db.query("INSERT INTO multiremi_authority_nodes VALUES('machine',100,1,'machine_registration','daemon','worker','system',1,?,NULL,0)").run(expiry);
    db.query("INSERT INTO multiremi_authority_nodes VALUES('trust-node',101,1,'runtime_trust','runtime',?,'system',1,?,NULL,1)").run(runtime.id, expiry);
    db.run("INSERT INTO multiremi_authority_edges VALUES('trust-node',1,101,'machine',1,100,'continuous')");
    db.query("INSERT INTO multiremi_access_tokens(id,name,type,workspace_id,daemon_id,token_hash,token_prefix,created_at) VALUES('token','test','daemon','local','worker',?,'test','now')").run(hash);
    const signing = generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' });
    const recipient = generateKeyPairSync('rsa', { modulusLength: 3072 }).publicKey.export({ format: 'pem', type: 'spki' });
    db.query(`INSERT INTO multiremi_machine_enrollments(incarnation,deployment_id,consumer_id,runtime_id,daemon_id,credential_id,credential_digest,
      authority_node_id,generation,signing_spki,recipient_spki,recipient_key_id,key_expires_at_ms,isolation_verified_at_ms,immutable_carrier_verified_at_ms,attestation_expires_at_ms,attestation_id)
      VALUES('inc','deploy','consumer',?,'worker','token',?,'machine',1,?,?,'key',?,1,1,?,'evidence')`).run(runtime.id, hash, signing, recipient, expiry, expiry);
    const machinePlan = service.plan(proof, { action: 'root.runtime-trust.grant', use: 'management', actualTarget: { type: 'runtime', id: runtime.id } });
    const challenge = withSecurityWrite(db, undefined, { ...machinePlan, domainTargets: [...machinePlan.domainTargets, `machine:${runtime.id}`].sort() },
      tx => beginMachineChallenge(db, tx, 'test-daemon', runtime.id, 'root.runtime-trust.grant', runtime.id));
    db.query('UPDATE multiremi_machine_challenges SET consumed_at_ms=1,proof_digest=? WHERE challenge_id=?').run('fixture', challenge.id);
    db.query("INSERT INTO multiremi_runtime_trusts VALUES('trust',?,1,'inc',?,'trust-node','{}',NULL)").run(runtime.id, challenge.id);

    const sources: AgentConfigurationApproval['sources'][number][] = [];
    function approve(kind: string, id: string, use: string, value: unknown) {
      const ref = { kind, id, use, version: 1, digest: agentDependencyDigest(value) };
      sources.push({ ref, content: JSON.stringify(value), dependencies: [] });
      return ref;
    }
    const { root: _projection, skills, ...configuration } = store.getAgent(agent.id, {includeFiles: true})!;
    const workspace = store.getWorkspace('local')!;
    approve('agent', agent.id, 'configuration', configuration);
    approve('agent', agent.id, 'instructions', agent.instructions);
    approve('agent', agent.id, 'skills', skills);
    approve('agent', agent.id, 'plugins', store.resolveAgentPluginSnapshot(agent.id));
    approve('workspace', workspace.id, 'configuration', {context: workspace.context, settings: workspace.settings, repos: workspace.repos});
    approve('workspace', workspace.id, 'prompt', readWorkspacePromptSettings(workspace));
    const host = store.getRuntime(runtime.id)!;
    approve('runtime', host.id, 'execute', {daemonId: host.daemonId, incarnation: 'inc', provider: host.provider, runtimeMode: host.runtimeMode, metadata: host.metadata, models: host.models});
    const profile = approve('runtime', host.id, 'effective-profile', runtimeConnectionSnapshot(store.getAgentExecutionProfile(host.id, agent), agent.model));
    const execution = { trustId: 'trust', profileDigest: profile.digest, provider: approve('provider-trust','provider','execute','test provider'),
      checkpointPolicy: approve('checkpoint-policy','checkpoint','restore','test checkpoint policy'), inputPolicy: approve('input-policy','inputs','accept','test input policy') };
    const scope = {type:'agent', id:agent.id};
    const action = { action:'root.agent-configuration.approve', use:'write', actualTarget:scope };
    const configPlan = service.planAgentGrant(proof, agent.id, ['trust']);
    const approved = withSecurityWrite(db, undefined, configPlan, tx => service.approveAgentConfiguration(tx,service.authorizeWrite(tx,proof,action),agent.id,null,{sources,executions:[execution]}));
    const plan = service.planAgentGrant(proof, agent.id, ['trust']);
    const grant = withSecurityWrite(db, undefined, plan, tx => service.grant(tx,service.authorizeWrite(tx,proof,{action:'root.grant.create',use:'management',actualTarget:scope}),
      {subject:{type:'agent',id:agent.id},runtime_trust_ids:['trust'],accepted_dependency_digest:approved.digest,expected_revision:plan.expectedRevision,idempotency_key:'grant',reason:'reviewed'}));
    const taskInput = { agentId: agent.id, issueId: issue.id, prompt: 'original instruction' };
    const submit = () => store.createAdmittedTask(taskInput, proof, {messages: [], includeSubmittedPrompt: true});
    expect(submit).toThrow();
    expect(db.query("SELECT 1 FROM multiremi_authority_nodes WHERE node_id='provider'").get()).toBeNull();
    const sequence = Number(db.query('SELECT MAX(issued_seq) AS seq FROM multiremi_authority_nodes').get().seq) + 1;
    db.query("INSERT INTO multiremi_authority_nodes VALUES('provider',?,1,'provider_trust','agent',?,'system',1,?,NULL,2)").run(sequence, agent.id, expiry);
    for (const parent of [grant.grant.authority_node_id,'trust-node']) db.query(`INSERT INTO multiremi_authority_edges SELECT 'provider',1,?,node_id,generation,issued_seq,'continuous'
      FROM multiremi_authority_nodes WHERE node_id=?`).run(sequence,parent);
    const task = submit();
    expect(task.issueSessionId).toBe(session.id);
    const message = db.query(`SELECT m.* FROM multiremi_turns t JOIN multiremi_conversation_log m ON m.id=t.trigger_message_id WHERE t.id=?`).get(task.id);
    const approvedInputs = (id: string) => JSON.parse(db.query('SELECT manifest_snapshot FROM multiremi_attempt_input_approvals WHERE attempt_id=?').get(id).manifest_snapshot);
    const source = {id:message.id, version:Number(message.revision)};
    const author = db.query('SELECT user_id FROM multiremi_workspace_members WHERE id=?').get(message.sender_id);
    const manifest = approvedInputs(task.id);
    expect(manifest.inputs.entries).toEqual([{source,snapshot:taskInput.prompt,purpose:'instruction',author:{type:'user',id:author.user_id}}]);
    expect(manifest.inputs.sourcePolicy).toEqual({id:'inputs',version:1});
    expect(manifest.execution.providerTrust).toEqual({id:'provider',version:1});
    db.query("UPDATE multiremi_turn_attempts SET status='lost' WHERE id=?").run(task.id);
    db.query("UPDATE multiremi_turns SET status='failed' WHERE id=?").run(task.id);
    const retry = () => store.retryAdmittedTurn(task.id, task.id, proof, {messages:[source]});
    const rejectRetry = () => {
      expect(retry).toThrow();
      expect(store.getTurn(task.id)?.current_attempt_id).toBe(task.id);
      expect(db.query('SELECT attempt_id FROM multiremi_attempt_input_approvals').all()).toHaveLength(1);
    };
    expect(() => store.retryAdmittedTurn(task.id, task.id, proof, {messages:[{...source,version:source.version+1}]})).toThrow();
    expect(() => store.retryAdmittedTurn(task.id, task.id, proof, {messages:[]})).toThrow();
    db.query("UPDATE multiremi_authority_nodes SET revoked_at_ms=1 WHERE node_id='provider'").run();
    rejectRetry();
    db.query("UPDATE multiremi_authority_nodes SET revoked_at_ms=NULL WHERE node_id='provider'").run();
    db.query("UPDATE multiremi_agent_source_snapshots SET resource_version=2 WHERE agent_id=? AND kind='input-policy'").run(agent.id);
    rejectRetry();
    db.query("UPDATE multiremi_agent_source_snapshots SET resource_version=1 WHERE agent_id=? AND kind='input-policy'").run(agent.id);
    db.query("UPDATE multiremi_conversation_log SET sender_id='unknown' WHERE id=?").run(message.id);
    rejectRetry();
    db.query('UPDATE multiremi_conversation_log SET sender_id=? WHERE id=?').run(message.sender_id, message.id);
    db.query("UPDATE multiremi_turn_attempts SET session_id='unverified-checkpoint' WHERE id=?").run(task.id);
    rejectRetry();
    db.query('UPDATE multiremi_turn_attempts SET session_id=NULL WHERE id=?').run(task.id);
    expect(store.getTurn(task.id)?.current_attempt_id).toBe(task.id);
    const retried = retry();
    expect(approvedInputs(retried.current_attempt_id!).inputs.entries).toEqual(manifest.inputs.entries);
    expect(db.query("SELECT attempt_id FROM multiremi_attempt_eligibility WHERE eligibility='root' AND attempt_id IN (?,?)").all(task.id,retried.current_attempt_id)).toHaveLength(2);
  });
});
