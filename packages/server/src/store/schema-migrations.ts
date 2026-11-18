import { SCHEMA_EXPAND_LEVEL } from "./schema-levels.js";
import type { SchemaMigration } from './schema-migration-runner.js';

/** Historical bootstrap is frozen at level 0. New DDL belongs in this list;
 * every step has an identity, phase, level and release, never ad hoc startup. */
export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [{
  id: '20261118_schema_level_protocol', phase: 'expand', level: SCHEMA_EXPAND_LEVEL,
  expandRelease: '0.2.95', release: '0.2.95',
  run: () => {}, // ensureSchemaMeta creates the additive protocol tables.
}];
