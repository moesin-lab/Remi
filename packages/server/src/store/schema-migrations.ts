import { ensureSystemPrompts } from "./system-prompt-schema.js";
import { ensureDaemonDrainIdentity, ensurePlannedRestarts } from "./planned-restart-schema.js";
import { LIVE_TERM_SCHEMA } from './live-term-fence.js';
import { expandSecurityState } from './security-state-schema.js';
import { expandAuthorityProvenance } from './authority-provenance-schema.js';
import { expandRootGrants } from './root-grant-schema.js';
import { expandRootManagement } from './root-management-schema.js';
import { expandBootstrapAuthorizations } from './root-bootstrap-schema.js';
import { expandRuntimeTrust } from './runtime-trust-schema.js';
import { expandCredentialVersionBindings, expandRootReceipts } from './root-receipt-schema.js';
import { expandJwtMaterials } from './jwt-material-schema.js';
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
  id: '20261124_system_prompt_policy', phase: 'expand', level: 4,
  expandRelease: '0.2.95', release: '0.2.95',
  run: db => { ensureSystemPrompts(db); },
}, {
  id: '20261124_feishu_bot_wake_words', phase: 'expand', level: 5,
  expandRelease: '0.2.95', release: '0.2.95',
  run: db => { db.exec("ALTER TABLE multiremi_feishu_bot_configs ADD COLUMN wake_words_json TEXT NOT NULL DEFAULT '[]'"); },
}, {
  id: '20261125_feishu_command_results', phase: 'expand', level: 6,
  expandRelease: '0.2.95', release: '0.2.95',
  run: db => { db.exec(`CREATE TABLE multiremi_feishu_command_results (
    workspace_id TEXT NOT NULL, domain TEXT NOT NULL, app_id TEXT NOT NULL, external_message_id TEXT NOT NULL,
    bot_id TEXT NOT NULL, sender_open_id TEXT NOT NULL, digest TEXT NOT NULL, command_name TEXT NOT NULL,
    result_json TEXT NOT NULL, completed_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, domain, app_id, external_message_id))`); },
}, {
  id: '20261124_security_state', phase: 'expand', level: 7,
  expandRelease: '0.2.95', release: '0.2.95', run: expandSecurityState,
}, {
  id: '20261124_authority_provenance', phase: 'expand', level: 7,
  expandRelease: '0.2.95', release: '0.2.95', run: expandAuthorityProvenance,
}, {
  id: '20261124_root_grants', phase: 'expand', level: 7,
  expandRelease: '0.2.95', release: '0.2.95', run: expandRootGrants,
}, {
  id: '20261124_root_management', phase: 'expand', level: 7,
  expandRelease: '0.2.95', release: '0.2.95', run: expandRootManagement,
}, {
  id: '20261124_bootstrap_authorizations', phase: 'expand', level: 7,
  expandRelease: '0.2.95', release: '0.2.95', run: expandBootstrapAuthorizations,
}, {
  id: '20261124_runtime_trust', phase: 'expand', level: 7,
  expandRelease: '0.2.95', release: '0.2.95', run: expandRuntimeTrust,
}, {
  id: '20261124_root_receipts', phase: 'expand', level: 7,
  expandRelease: '0.2.95', release: '0.2.95', run: expandRootReceipts,
}, {
  id: '20261124_credential_version_bindings', phase: 'expand', level: 7,
  expandRelease: '0.2.95', release: '0.2.95', run: expandCredentialVersionBindings,
}, {
  id: '20261124_dashboard_jwt_materials', phase: 'expand', level: 7,
  expandRelease: '0.2.95', release: '0.2.95', run: expandJwtMaterials,
}];
