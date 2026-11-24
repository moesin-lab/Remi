import { expect, it } from 'bun:test';
import { pendingTurnBackendTests } from './pending-turn-test-backends.js';

pendingTurnBackendTests('credential material CAS', fixture => {
  it('returns material only to the winner when both renewals remain within the threshold', async () => {
    const { store } = fixture();
    const token = await store.createAccessToken({ name: 'test rotation', type: 'pat', expiresInDays: 1 });
    const renew = () => store.renewAccessTokenExpiry(token.id, { thresholdDays: 7, extensionDays: 2 });
    const results = await Promise.all([renew(), renew()]);
    const winners = results.filter(result => result?.renewed);
    expect(winners).toHaveLength(1);
    expect(results.filter(result => result && !result.renewed && !result.rawToken)).toHaveLength(1);
    expect(await store.verifyAccessToken(token.token)).toBeNull();
    expect((await store.verifyAccessToken(winners[0]!.rawToken!))?.id).toBe(token.id);
  });
});
