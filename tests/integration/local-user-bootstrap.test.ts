import { afterAll, beforeAll, expect, test } from 'bun:test';
import { MultiremiStore } from '@multiremi/store.js';
import { runStartupMigrations } from '@multiremi/store/migrations.js';
import { openIntegrationDatabase, type IntegrationDatabase } from '../helpers/integration-database.js';

let fixture: IntegrationDatabase;
beforeAll(async () => {
  fixture = await openIntegrationDatabase();
  runStartupMigrations(fixture.db);
}, 30_000);
afterAll(async () => { await fixture?.close(); });

test('local user bootstrap preserves the winner of a concurrent first insert', () => {
  const { db } = fixture;
  expect(db.query("SELECT id FROM multiremi_users WHERE id = 'local'").get()).toBeFalsy();
  const run = db.run.bind(db);
  let interleaved = false;
  // Schedule the other writer's committed insert after this caller's real
  // missing-user SELECT, immediately before its INSERT. No timing window is
  // required, and both inserts still execute through the real SQL engine.
  db.run = (...args) => {
    const [sql] = args;
    if (!interleaved && /INSERT INTO multiremi_users/.test(sql)) {
      interleaved = true;
      run(...args);
      run("UPDATE multiremi_users SET name = ?, email = ?, profile_description = ? WHERE id = 'local'",
        ['Winning user', 'winner@example.test', 'Preserve this profile']);
    }
    return run(...args);
  };
  try {
    const store = new MultiremiStore(db);
    const winner = store.getCurrentUser();
    expect(interleaved).toBe(true);
    expect(winner).toMatchObject({ id: 'local', name: 'Winning user', email: 'winner@example.test',
      profileDescription: 'Preserve this profile' });
    expect(store.getCurrentUser()).toEqual(winner);
    expect(db.query("SELECT id FROM multiremi_users WHERE id = 'local'").all()).toEqual([{ id: 'local' }]);
  } finally { db.run = run; }
});
