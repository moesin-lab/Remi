import { afterEach, beforeEach, expect, it } from 'bun:test';
import { openSqliteDatabase } from '@multiremi/store/db/sqlite.js';
import type { SqlDatabase } from '@multiremi/store/db/postgres.js';
import { expandSecurityState } from '@multiremi/store/security-state-schema.js';
import { afterSecurityCommit, withSecurityTarget, withSecurityWrite, type SecurityTx } from '@multiremi/store/security-write.js';
import { securityWritePlan as plan } from '../../fixtures/security-write.js';

let sqlite: ReturnType<typeof openSqliteDatabase>;
let db: SqlDatabase;
beforeEach(() => {
  sqlite = openSqliteDatabase();
  db = sqlite as unknown as SqlDatabase;
  expandSecurityState(db);
  db.exec(`CREATE TABLE multiremi_workspaces (id TEXT PRIMARY KEY, updated_at TEXT);
    INSERT INTO multiremi_workspaces VALUES ('workspace-a', 'original');
    CREATE TABLE effects (id INTEGER)`);
});
afterEach(() => sqlite.close());

it('starts disabled, enforces a single gate, and never resets its revision on repeat', () => {
  expect(db.query('SELECT * FROM multiremi_security_state').all()).toEqual([{
    singleton: 1, security_revision: 0, feature_activation: 0, bootstrap_completed: 0, minimum_enforcement_version: null,
  }]);
  expect(() => db.run('INSERT INTO multiremi_security_state(singleton) VALUES(2)')).toThrow();
  db.run('UPDATE multiremi_security_state SET security_revision=3');
  expandSecurityState(db);
  expect(db.query('SELECT security_revision FROM multiremi_security_state').get()?.security_revision).toBe(3);
});

it('commits a planned write and expires its handle', () => {
  let saved!: SecurityTx;
  const notifications: boolean[] = [];
  withSecurityWrite(db, undefined, plan, tx => {
    saved = tx;
    afterSecurityCommit(db, tx, () => notifications.push(sqlite.inTransaction));
    expect(notifications).toEqual([]);
    withSecurityTarget(db, tx, 'issue:example', () => db.run('INSERT INTO effects VALUES(1)'));
  });
  expect(db.query('SELECT id FROM effects').all()).toEqual([{id: 1}]);
  expect(notifications).toEqual([false]);
  expect(() => withSecurityTarget(db, saved, 'issue:example', () => 2)).toThrow('security_tx_invalid');
});

for (const [label, operation] of Object.entries({
  unplanned: (tx: SecurityTx) => withSecurityTarget(db, tx, 'issue:other', () => true),
  nested: () => withSecurityWrite(db, undefined, plan, () => true),
  promise: (tx: SecurityTx) => withSecurityTarget(db, tx, 'issue:example', () => Promise.resolve()),
  businessFailure: (tx: SecurityTx) => withSecurityTarget(db, tx, 'issue:example', () => { throw new Error('failed'); }),
})) {
  it(`rolls back earlier effects even when ${label} is caught`, () => {
    let notified = false;
    expect(() => withSecurityWrite(db, undefined, plan, tx => {
      db.run('INSERT INTO effects VALUES(1)');
      afterSecurityCommit(db, tx, () => { notified = true; });
      try { operation(tx); } catch { return 'caught'; }
    })).toThrow();
    expect(db.query('SELECT id FROM effects').all()).toEqual([]);
    expect(notified).toBe(false);
    expect(withSecurityWrite(db, undefined, plan, () => 'reused')).toBe('reused');
  });
}

it('rejects missing workspaces, stale revisions, reordered locks and a missing gate before callback', () => {
  const unexpected = () => { throw new Error('callback ran'); };
  expect(() => withSecurityWrite(db, undefined, {...plan, workspaceIds: ['absent']}, unexpected)).toThrow('security_target_unplanned');
  expect(() => withSecurityWrite(db, undefined, {...plan, expectedRevision: 1}, unexpected)).toThrow('authority_revision_conflict');
  expect(() => withSecurityWrite(db, undefined, {...plan, numberKeys: ['b', 'a']}, unexpected)).toThrow('security_lock_order');
  db.run('DELETE FROM multiremi_security_state');
  expect(() => withSecurityWrite(db, undefined, plan, unexpected)).toThrow('security_state_unavailable');
});
