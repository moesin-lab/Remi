import { expect, test } from 'bun:test';
import { SCHEMA_MIGRATIONS } from '../../packages/server/src/store/schema-migrations.ts';
import { validateSchemaMigrations } from '../../packages/server/src/store/schema-migration-runner.ts';
import { SCHEMA_COMPATIBILITY, SCHEMA_EXPAND_LEVEL, validateSchemaCompatibility } from '../../packages/server/src/store/schema-levels.ts';
import declaration from '../../packages/server/src/store/schema-compatibility.json';

test('release schema identity covers every declared startup expansion', () => {
  validateSchemaMigrations(SCHEMA_MIGRATIONS);
  validateSchemaCompatibility(SCHEMA_COMPATIBILITY);
  expect(declaration.format).toBe(1);
  expect(declaration.contractLevel).toBe(0); // First protocol release never contracts.
  expect(Math.max(...SCHEMA_MIGRATIONS.filter(step => step.phase === 'expand').map(step => step.level))).toBe(SCHEMA_EXPAND_LEVEL);
  // Enrollment's identity must not follow the mutable current target level.
  expect(SCHEMA_MIGRATIONS.find(step => step.id === '20261118_schema_level_protocol')?.level).toBe(1);
});
