import type { SchemaMigration } from './schema-migration-runner.js';

/** Explicit maintenance only. Never import this registry from startup.
 * A future contract must follow the release that shipped its expand. */
export const SCHEMA_CONTRACT_MIGRATIONS: readonly SchemaMigration[] = [];
