import { expect, it } from 'bun:test';
import { PreparedRootDelivery, RootReceiptStore, rootBusinessPayloadDigest } from '@multiremi/store/root-receipts.js';
import { expandRootReceipts } from '@multiremi/store/root-receipt-schema.js';
import { recipientFingerprint } from '@multiremi/worker/root-delivery-envelope.js';
import { withSecurityWrite } from '@multiremi/store/security-write.js';
import { pendingTurnBackendTests } from './pending-turn-test-backends.js';
import { fixtureDeliveryTuple } from '../../fixtures/root-authority.js';

pendingTurnBackendTests('root delivery prepare and abort', fixture => {
  it('keeps preparation unauthenticatable and rolls back run writes on issuer rejection', async () => {
    const { db, store } = fixture();
    db.exec('CREATE TABLE IF NOT EXISTS multiremi_credential_families(family_id TEXT PRIMARY KEY)');
    expandRootReceipts(db);
    const agent = store.createAgent({ name: 'receipt fixture', provider: 'codex' });
    const task = store.createTask({ agentId: agent.id, prompt: 'test' });
    const business = { task: task.id, input: { unicode: '回执', read: 1 } };
    const key = await crypto.subtle.generateKey({ name: 'RSA-OAEP', hash: 'SHA-256', modulusLength: 3072,
      publicExponent: new Uint8Array([1,0,1]) }, false, ['encrypt','decrypt']);
    const tuple = { ...fixtureDeliveryTuple, attempt_id: task.id, recipient_key_fingerprint: recipientFingerprint(key.publicKey),
      material_expires_at: new Date(Date.now() + 120000).toISOString(), business_payload_digest: rootBusinessPayloadDigest(business) };
    const candidate = await PreparedRootDelivery.prepare(tuple, business, key.publicKey);
    expect(db.query('SELECT id FROM multiremi_access_tokens WHERE token_hash=?').get(candidate.tokenHash)).toBeNull();
    expect(rootBusinessPayloadDigest({ input: { read: 1, unicode: '回执' }, task: task.id })).toBe(tuple.business_payload_digest);
    expect(() => rootBusinessPayloadDigest({ ...business, auth_token: 'test' })).toThrow('Private material');
    const repo = new RootReceiptStore(db);
    const plan = { expectedRevision: 0, workspaceIds: ['local'], numberKeys: [], domainTargets: [`receipt:${tuple.receipt_id}`] };
    expect(() => withSecurityWrite(db, undefined, plan, tx => repo.activate(tx, candidate,
      { lease_id: 'test', fence_term: 'test', start_deadline: tuple.material_expires_at }, () => {
        db.run('INSERT INTO multiremi_usage_runs(task_id,run_id,revision,complete) VALUES(?,?,0,0)', [task.id, tuple.consumer_id]);
        throw new Error('root_invoker_untrusted');
      }))).toThrow('root_invoker_untrusted');
    expect(db.query('SELECT run_id FROM multiremi_usage_runs WHERE task_id=?').get(task.id)).toBeNull();
    expect(db.query('SELECT receipt_id FROM multiremi_delivery_receipts').all()).toEqual([]);
    expect(db.query('SELECT credential_id FROM multiremi_credential_materials').all()).toEqual([]);
  });
});
