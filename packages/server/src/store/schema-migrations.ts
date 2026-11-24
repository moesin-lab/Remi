import { ensureDaemonDrainIdentity, ensurePlannedRestarts } from "./planned-restart-schema.js";
import { LIVE_TERM_SCHEMA } from './live-term-fence.js';
import { expandSecurityState } from './security-state-schema.js';
import { expandAuthorityProvenance } from './authority-provenance-schema.js';
import type { SchemaMigration } from './schema-migration-runner.js';

/** Historical bootstrap is frozen at level 0. New DDL belongs in this list;
 * every step has an identity, phase, level and release, never ad hoc startup. */
export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [{
  id: '20261118_schema_level_protocol', phase: 'expand', level: 1,
  expandRelease: '0.2.95', release: '0.2.95',
  run: () => {}, // ensureSchemaMeta creates the additive protocol tables.
}, {
  id: '20261118_live_term_fence', phase: 'expand', level: 2,
  expandRelease: '0.2.95', release: '0.2.95',
  run: db => { db.exec(LIVE_TERM_SCHEMA); },
}, {
  id: '20261119_planned_restarts', phase: 'expand', level: 3,
  expandRelease: '0.2.95', release: '0.2.95',
  run: db => { ensureDaemonDrainIdentity(db); ensurePlannedRestarts(db); },
}, {
  id: '20261124_security_state', phase: 'expand', level: 4,
  expandRelease: '0.2.95', release: '0.2.95', run: expandSecurityState,
}, {
  id: '20261124_authority_provenance', phase: 'expand', level: 4,
  expandRelease: '0.2.95', release: '0.2.95', run: expandAuthorityProvenance,
}];
