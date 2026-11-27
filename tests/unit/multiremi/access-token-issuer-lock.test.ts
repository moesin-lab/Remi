import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteDatabase } from '@multiremi/store/db/sqlite.js';
import type { SqlDatabase } from '@multiremi/store/db/postgres.js';
import { runMigrations } from '@multiremi/store/migrations.js';
import { AccessTokensRepo } from '@multiremi/store/repos/access-tokens-repo.js';
import { JwtMaterialUnavailable } from '@multiremi/store/jwt-materials.js';

test('legacy credential inserts serialize with activation across primary connections', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'credential-issuer-'));
  const path = join(directory, 'isolated.sqlite');
  const issuer = openSqliteDatabase(path);
  const activator = openSqliteDatabase(path);
  try {
    runMigrations(issuer as unknown as SqlDatabase);
    activator.exec('PRAGMA busy_timeout=0');
    const activate = () => activator.exec(`UPDATE multiremi_security_state SET bootstrap_completed=1,
      minimum_enforcement_version='test',feature_activation=1 WHERE singleton=1`);
    const repo = new AccessTokensRepo(issuer as unknown as SqlDatabase);
    const first = await repo.createAccessToken({ name: 'closed', expiresInDays: 1 }, () => {
      expect(activate).toThrow(/locked|busy/i);
    });
    const pending = [
      repo.createAccessToken({ name: 'personal', type: 'pat' }),
      repo.createAccessToken({ name: 'session', type: 'pat', purpose: 'session' }),
      repo.createAccessToken({ name: 'install', type: 'daemon' }),
      repo.renewAccessTokenExpiry(first.id),
    ];
    activate();
    for (const result of await Promise.allSettled(pending)) {
      expect(result.status === 'rejected' && result.reason instanceof JwtMaterialUnavailable).toBe(true);
    }
    expect(issuer.query('SELECT id FROM multiremi_access_tokens').all()).toEqual([{ id: first.id }]);
    expect((await repo.verifyAccessToken(first.token))?.expiresAt).toBe(first.expiresAt);
  } finally {
    activator.close();
    issuer.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
