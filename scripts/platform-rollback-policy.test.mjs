import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rollbackPolicy } from './platform-rollback-policy.mjs';
const manifest = { version: '1.2.0', ref: 'a'.repeat(40) };
const review = {
  targetRef: manifest.ref, previousVersion: '1.1.9', previousDataSchema: 'b'.repeat(64),
  reviewedBy: 'release reviewer', reason: 'Previous code reads the unchanged record format',
  previousRelease: { version: '1.1.9', dataSchema: 'b'.repeat(64) },
};
test('no review gives no cross-fingerprint attestation', () => {
  assert.deepEqual(rollbackPolicy(manifest), []);
});
test('review attests only the published previous schema', () => {
  assert.deepEqual(rollbackPolicy(manifest, review), [review.previousDataSchema]);
});
test('rejects stale, malformed, unreviewed and mismatched declarations', () => {
  for (const patch of [
    { targetRef: 'c'.repeat(40) }, { previousDataSchema: 'd'.repeat(64) },
    { previousDataSchema: 'invalid' }, { reviewedBy: '' }, { reason: ' ' },
    { previousVersion: '1.1.8' }, { previousRelease: undefined },
    { previousVersion: '1.2.0', previousRelease: { ...review.previousRelease, version: '1.2.0' } },
    { previousVersion: '2.0.0', previousRelease: { ...review.previousRelease, version: '2.0.0' } },
  ]) assert.throws(() => rollbackPolicy(manifest, { ...review, ...patch }));
  assert.throws(() => rollbackPolicy(manifest, null));
});
