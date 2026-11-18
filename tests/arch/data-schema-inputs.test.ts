import { test, expect } from 'bun:test';
import { resolve, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import inputs from '../../packages/platform-updater/src/data-schema-inputs.json';
import { migrationDdlModules, missingMigrationInputs } from '../../packages/platform-updater/src/schema-input-coverage.mjs';

test('schema fingerprint covers transitive migration DDL', () => {
  const root = resolve(import.meta.dir, '../..');
  expect(migrationDdlModules(root)).toContain('packages/server/src/store/unified-model-migration.ts');
  expect(missingMigrationInputs(root, inputs)).toEqual([]);
});
test('detects a missing DDL helper through a re-export', () => {
  const root = mkdtempSync(join(tmpdir(), 'schema-inputs-'));
  try {
    const store = join(root, 'packages/server/src/store'); mkdirSync(store, { recursive: true });
    writeFileSync(join(store, 'migrations.ts'), "import { migrate } from './exports.js'; migrate();");
    writeFileSync(join(store, 'exports.ts'), "export { migrate } from './hidden.js';");
    writeFileSync(join(store, 'hidden.ts'), 'export function migrate() { return `ALTER TABLE tasks ADD COLUMN x TEXT`; }');
    expect(missingMigrationInputs(root, ['packages/server/src/store/migrations.ts'])).toEqual(['packages/server/src/store/hidden.ts']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
