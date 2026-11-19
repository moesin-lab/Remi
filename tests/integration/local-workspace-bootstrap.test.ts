import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MultiremiStore } from '@multiremi/store.js';
import { openSqliteDatabase } from '@multiremi/store/db/sqlite.js';
import type { SqlDatabase } from '@multiremi/store/db/postgres.js';
import { openIntegrationDatabase } from '../helpers/integration-database.js';
import { twoProcessChildEnv } from '../helpers/two-process.js';

for (const boundary of ['workspace', 'member'] as const) {
  test(`local bootstrap re-reads a concurrent ${boundary} winner in another process`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mul303-'));
    const fixture = process.env.MULTIREMI_TEST_POSTGRES_URL ? await openIntegrationDatabase() : null;
    const target = fixture?.url ?? join(directory, 'db.sqlite');
    const db = fixture?.db ?? openSqliteDatabase(target) as unknown as SqlDatabase;
    try {
      // Migrate first, then remove only bootstrap identities: the race is after
      // migrate() and before Store's operator repair, not in schema migration.
      new MultiremiStore(db);
      db.run("DELETE FROM multiremi_workspace_members WHERE workspace_id = 'local'");
      db.run("DELETE FROM multiremi_workspaces WHERE id = 'local'");
      const query = db.query.bind(db);
      let interleaved = false;
      db.query = ((sql: string) => {
        const statement = query(sql);
        const matches = boundary === 'workspace'
          ? /^SELECT \* FROM multiremi_workspaces WHERE id = \?$/.test(sql)
          : /SELECT \* FROM multiremi_workspace_members WHERE id = \?|SELECT member\.\*/.test(sql);
        if (!matches) return statement;
        return { ...statement, get: (...args: unknown[]) => {
          const row = statement.get(...args);
          if (!row && !interleaved) {
            interleaved = true;
            // The SELECT has completed with no row. Hold its return until a
            // second process has committed the competing production bootstrap.
            const child = Bun.spawnSync([process.execPath, '--no-env-file',
              join(import.meta.dir, '../helpers/local-workspace-bootstrap-child.ts'), target],
            { env: twoProcessChildEnv(), stdout: 'pipe', stderr: 'pipe', timeout: 15_000 });
            expect(new TextDecoder().decode(child.stderr)).toBe('');
            expect(child.exitCode).toBe(0);
            expect(JSON.parse(new TextDecoder().decode(child.stdout))).toMatchObject({
              id: 'mem_local_local', workspaceId: 'local', userId: 'local', role: 'owner', archivedAt: null,
            });
          }
          return row;
        } };
      }) as typeof db.query;
      try {
        const store = new MultiremiStore(db);
        expect(interleaved).toBe(true);
        expect(store.ensureLocalWorkspace()).toMatchObject({ id: 'local', name: 'Winning workspace',
          description: 'Preserve winner', settings: { bootstrapWinner: true } });
        expect(store.ensureWorkspaceOperator('local').id).toBe('mem_local_local');
        expect(db.query("SELECT id FROM multiremi_workspaces").all()).toEqual([{ id: 'local' }]);
        expect(db.query("SELECT id, role, archived_at FROM multiremi_workspace_members").all())
          .toEqual([{ id: 'mem_local_local', role: 'owner', archived_at: null }]);
      } finally { db.query = query; }
    } finally {
      if (fixture) await fixture.close(); else db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
}
