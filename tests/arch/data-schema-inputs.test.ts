import { test, expect } from 'bun:test';
import { resolve, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startupSchemaDdl } from '../../scripts/startup-schema-ddl.js';
import inputs from '../../packages/platform-updater/src/data-schema-inputs.json';
import { missingMigrationInputs } from '../../packages/platform-updater/src/schema-input-coverage.mjs';

// Frozen pre-B1 main (80f749990): legacy /app archives have only these paths.
const frozenLegacyInputs = [
  "packages/server/src/store/migrations.ts",
  "packages/server/src/store/inbox/member-records.ts",
  "packages/server/src/store/inbox/questions.ts",
  "packages/server/src/store/repos/workspaces-repo.ts",
  "packages/server/src/store/daemon-routing.ts",
  "packages/server/src/store/db/postgres.ts",
  "packages/server/src/store/db/pg-worker.ts",
  "packages/contracts/src/attachments.ts",
  "packages/shared/src/db/index.ts",
  "packages/server/src/store/autopilot-run-records.ts",
  "packages/server/src/store/inbox/attempt-counters.ts",
  "packages/server/src/store/inbox/attempt-input.ts",
  "packages/server/src/store/inbox/decision-migration.ts",
  "packages/server/src/store/inbox/decision-records.ts",
  "packages/server/src/store/inbox/lane-migration.ts",
  "packages/server/src/store/inbox/question-indexes.ts",
  "packages/server/src/store/live-term-fence.ts",
  "packages/server/src/store/lock-order-sentinel.ts",
  "packages/server/src/store/pending-turns.ts",
  "packages/server/src/store/turn-execution-records.ts",
  "packages/server/src/store/turn-list-indexes.ts",
  "packages/server/src/store/unified-model-migration.ts",
  "packages/server/src/store/unified-model-schema.ts",
  "packages/server/src/store/usage-accounting.ts",
  "packages/server/src/store/usage-migration.ts"
];
test('keeps legacy archive fingerprint inputs frozen', () => {
  expect(inputs).toEqual(frozenLegacyInputs);
});
test('legacy inputs or B1 scanner cover transitive migration DDL', () => {
  const root = resolve(import.meta.dir, '../..');
  const scanned = new Set<string>();
  startupSchemaDdl(root, scanned);
  expect(scanned.has('packages/server/src/store/schema-levels.ts')).toBe(true);
  expect(scanned.has('packages/server/src/store/schema-compatibility.json')).toBe(true);
  expect(scanned.has('package.json')).toBe(true);
  expect(scanned.has('packages/server/src/store/planned-restart-schema.ts')).toBe(true);
  expect(scanned.has('packages/server/src/store/security-state-schema.ts')).toBe(true);
  expect(scanned.has('packages/server/src/store/authority-provenance-schema.ts')).toBe(true);
  expect(scanned.has('packages/server/src/store/root-grant-schema.ts')).toBe(true);
  expect(missingMigrationInputs(root, inputs, scanned)).toEqual([]);
});
test('detects a missing DDL helper through a re-export', () => {
  const root = mkdtempSync(join(tmpdir(), 'schema-inputs-'));
  try {
    const store = join(root, 'packages/server/src/store'); mkdirSync(store, { recursive: true });
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { moduleResolution: 'bundler', module: 'esnext' } }));
    writeFileSync(join(store, 'migrations.ts'), "import { migrate } from './exports.js'; migrate();");
    writeFileSync(join(store, 'exports.ts'), "export { migrate } from './hidden.js';");
    writeFileSync(join(store, 'hidden.ts'), 'export function migrate() { return `ALTER TABLE tasks ADD COLUMN x TEXT`; }');
    expect(missingMigrationInputs(root, ['packages/server/src/store/migrations.ts'])).toEqual(['packages/server/src/store/exports.ts', 'packages/server/src/store/hidden.ts']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rejects new DDL reachable only through a scanner-exempt module', () => {
  const root = mkdtempSync(join(tmpdir(), 'schema-unscanned-'));
  try {
    const store = join(root, 'packages/server/src/store'); mkdirSync(store, { recursive: true });
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { moduleResolution: 'bundler', module: 'esnext' } }));
    writeFileSync(join(store, 'migrations.ts'), "import './schema-contracts.js';");
    // An external module is reached by the migration graph only through the
    // exempt contract file; it is not in the server scanner's default roots.
    mkdirSync(join(root, 'packages/shared/src'), { recursive: true });
    writeFileSync(join(store, 'schema-contracts.ts'), "export { migrate } from '../../../shared/src/hidden.js';");
    for (const sql of ['CREATE TABLE new_module(id int)', 'CREATE SEQUENCE hidden_seq', 'CREATE /* marker */ TABLE hidden(id int)', 'TRUNCATE retained']) {
      writeFileSync(join(root, 'packages/shared/src/hidden.ts'), `export const migrate = ${JSON.stringify(sql)};`);
      const scanned = new Set<string>(); startupSchemaDdl(root, scanned);
      expect(scanned.has('packages/shared/src/hidden.ts')).toBe(false);
      expect(missingMigrationInputs(root, ['packages/server/src/store/migrations.ts'], scanned)).toEqual([
        'packages/server/src/store/schema-contracts.ts', 'packages/shared/src/hidden.ts',
      ]);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
