import type { SqlDatabase } from './db/postgres.js';
import { ensureSystemPrompts } from "./system-prompt-schema.js";
import { ensureDaemonDrainIdentity, ensurePlannedRestarts } from "./planned-restart-schema.js";
import { LIVE_TERM_SCHEMA } from './live-term-fence.js';
import { expandSecurityState } from './security-state-schema.js';
import { expandAuthorityProvenance } from './authority-provenance-schema.js';
import { expandRootGrants } from './root-grant-schema.js';
import { expandRootManagement } from './root-management-schema.js';
import { expandBootstrapAuthorizations } from './root-bootstrap-schema.js';
import { expandMachineDeploymentRoots, expandRuntimeTrust } from './runtime-trust-schema.js';
import { expandCredentialVersionBindings, expandRootReceipts } from './root-receipt-schema.js';
import { expandTaskAuthority } from './task-authority-schema.js';
import { expandAgentGrantDependencies } from './agent-grant-dependencies.js';
import { expandDurableDelegations } from './durable-delegation.js';
import { expandJwtMaterials } from './jwt-material-schema.js';
import type { SchemaMigration } from './schema-migration-runner.js';

const historicalScmSteps = ['20261124_scm_link_ownership', '20261124_scm_rollback_review', '20261124_scm_audit_generations'];
const scmTables = [
  { stage: 1, name: 'link_ownership', columns: 'link_id,attribution' },
  { stage: 1, name: 'ownership_cutover', columns: 'singleton,cursor_id,complete' },
  { stage: 2, name: 'rollback_review', columns: 'singleton' },
  { stage: 3, name: 'audit_state', columns: 'singleton,phase,hold_id,initial_digest' },
  { stage: 3, name: 'audit_generations', columns: 'id,version,baseline,baseline_count,legacy_cursor,legacy_complete,legacy_present,anchor_digest,revision,difference_digest,after_digest,finished' },
  { stage: 3, name: 'audit_entries', columns: 'generation,entry_key,identity_json,text_json' },
  { stage: 3, name: 'audit_changes', columns: 'generation,revision,entry_key,old_digest,new_digest,kind,before_json,after_json,reviewed' },
];

export function assertScmInventoryLayout(db: SqlDatabase, stage: number, historicalSource?: boolean): void {
  const query = db.dialect === 'postgres'
    ? "SELECT table_name AS name FROM information_schema.tables WHERE table_schema=current_schema()"
    : "SELECT name FROM sqlite_master WHERE type='table'";
  const tables = new Set(db.query(query).all().map(row => row.name));
  if (historicalSource !== undefined && (tables.has('multiremi_feishu_command_results') === historicalSource || tables.has('multiremi_system_prompt_documents') === historicalSource)) {
    throw new Error('SCM snapshot and main schema disagree');
  }
  for (const { stage: introduced, name, columns } of scmTables) {
    const table = `multiremi_scm_${name}`;
    if (tables.has(table) !== (introduced <= stage)) throw new Error(`Unexpected SCM migration layout: ${table}`);
    if (introduced <= stage) db.query(`SELECT ${columns} FROM ${table} LIMIT 0`).all();
  }
}

export function assertHistoricalScmUpgrade(db: SqlDatabase): void {
  const markers = db.query("SELECT id,phase,level,release FROM multiremi_schema_steps WHERE id LIKE '20261124_scm_%' ORDER BY level").all();
  if (!markers.length) return;
  if (markers.some((marker, index) => marker.id !== historicalScmSteps[index] || Number(marker.level) !== 4 + index || marker.phase !== 'expand' || marker.release !== '0.2.95')) {
    throw new Error('Unrecognized historical SCM migration lineage');
  }
  const formal = db.query("SELECT id,level FROM multiremi_schema_steps WHERE id LIKE '20261126_scm_%' ORDER BY level").all();
  if (formal.some((marker, index) => marker.id !== historicalScmSteps[index]?.replace('20261124', '20261126') || Number(marker.level) !== 7 + index)) {
    throw new Error('Unrecognized formal SCM migration lineage');
  }
  assertScmInventoryLayout(db, Math.max(markers.length, formal.length));
}

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
  id: '20261126_scm_link_ownership', phase: 'expand', level: 7,
  expandRelease: '0.2.95', release: '0.2.95',
  run: db => {
    db.exec(`CREATE TABLE IF NOT EXISTS multiremi_scm_link_ownership (
      link_id TEXT PRIMARY KEY REFERENCES multiremi_scm_issue_links(id) ON DELETE CASCADE,
      attribution TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS multiremi_scm_ownership_cutover (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      cursor_id TEXT NOT NULL, complete INTEGER NOT NULL CHECK (complete IN (0, 1))
    )`);
  },
}, {
  id: '20261126_scm_rollback_review', phase: 'expand', level: 8,
  expandRelease: '0.2.95', release: '0.2.95',
  run: db => {
    db.exec(`CREATE TABLE IF NOT EXISTS multiremi_scm_rollback_review (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
    )`);
    db.run(`INSERT INTO multiremi_scm_rollback_review (singleton)
      SELECT singleton FROM multiremi_scm_ownership_cutover WHERE complete = 1
        AND NOT EXISTS (SELECT 1 FROM multiremi_schema_steps WHERE id='20261124_scm_rollback_review')
      ON CONFLICT(singleton) DO NOTHING`);
  },
}, {
  id: '20261126_scm_audit_generations', phase: 'expand', level: 9,
  expandRelease: '0.2.95', release: '0.2.95',
  run: (db, startingExpandLevel, startingExpandSteps) => {
    const firstCut = startingExpandLevel !== undefined && startingExpandLevel < 7 && startingExpandSteps?.length === startingExpandLevel &&
      startingExpandSteps.every((id, index) => id === SCHEMA_MIGRATIONS[index]?.id);
    db.exec(`CREATE TABLE IF NOT EXISTS multiremi_scm_audit_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton=1), phase TEXT NOT NULL, hold_id TEXT, initial_digest TEXT
    );
    CREATE TABLE IF NOT EXISTS multiremi_scm_audit_generations (
      id TEXT PRIMARY KEY, version INTEGER NOT NULL, baseline TEXT, baseline_count INTEGER,
      legacy_cursor TEXT, legacy_complete INTEGER, legacy_present INTEGER, anchor_digest TEXT, revision TEXT, difference_digest TEXT, after_digest TEXT, finished INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS multiremi_scm_audit_entries (
      generation TEXT NOT NULL, entry_key TEXT NOT NULL, identity_json TEXT NOT NULL, text_json TEXT NOT NULL,
      PRIMARY KEY(generation, entry_key)
    );
    CREATE TABLE IF NOT EXISTS multiremi_scm_audit_changes (
      generation TEXT NOT NULL, revision TEXT NOT NULL, entry_key TEXT NOT NULL, old_digest TEXT, new_digest TEXT, kind TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL,
      reviewed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(revision, entry_key)
    )`);
    db.run(`INSERT INTO multiremi_scm_audit_state(singleton,phase)
      VALUES(1,CASE WHEN ?='initial' AND NOT EXISTS (SELECT 1 FROM multiremi_schema_steps WHERE id IN ('20261124_scm_link_ownership','20261124_scm_rollback_review','20261124_scm_audit_generations'))
        AND NOT EXISTS (SELECT 1 FROM multiremi_scm_link_ownership)
        AND NOT EXISTS (SELECT 1 FROM multiremi_scm_audit_generations)
        AND NOT EXISTS (SELECT 1 FROM multiremi_scm_audit_entries)
        AND NOT EXISTS (SELECT 1 FROM multiremi_scm_audit_changes)
        AND NOT EXISTS (SELECT 1 FROM multiremi_scm_ownership_cutover)
        AND NOT EXISTS (SELECT 1 FROM multiremi_scm_rollback_review)
        THEN 'initial' ELSE 'unknown' END) ON CONFLICT(singleton) DO NOTHING`,
      [firstCut ? 'initial' : 'unknown']);
  },
}, {
  id: '20261124_security_state', phase: 'expand', level: 10,
  expandRelease: '0.2.95', release: '0.2.95', run: expandSecurityState,
}, {
  id: '20261124_authority_provenance', phase: 'expand', level: 10,
  expandRelease: '0.2.95', release: '0.2.95', run: expandAuthorityProvenance,
}, {
  id: '20261124_root_grants', phase: 'expand', level: 10,
  expandRelease: '0.2.95', release: '0.2.95', run: expandRootGrants,
}, {
  id: '20261124_root_management', phase: 'expand', level: 10,
  expandRelease: '0.2.95', release: '0.2.95', run: expandRootManagement,
}, {
  id: '20261124_bootstrap_authorizations', phase: 'expand', level: 10,
  expandRelease: '0.2.95', release: '0.2.95', run: expandBootstrapAuthorizations,
}, {
  id: '20261124_runtime_trust', phase: 'expand', level: 10,
  expandRelease: '0.2.95', release: '0.2.95', run: expandRuntimeTrust,
}, {
  id: '20261124_root_receipts', phase: 'expand', level: 10,
  expandRelease: '0.2.95', release: '0.2.95', run: expandRootReceipts,
}, {
  id: '20261124_credential_version_bindings', phase: 'expand', level: 10,
  expandRelease: '0.2.95', release: '0.2.95', run: expandCredentialVersionBindings,
}, {
  id: '20261124_dashboard_jwt_materials', phase: 'expand', level: 10,
  expandRelease: '0.2.95', release: '0.2.95', run: expandJwtMaterials,
}, {
  id: '20261126_task_authority', phase: 'expand', level: 10,
  expandRelease: '0.2.95', release: '0.2.95', run: expandTaskAuthority,
}, {
  id: '20261126_machine_deployment_roots', phase: 'expand', level: 10,
  expandRelease: '0.2.95', release: '0.2.95', run: expandMachineDeploymentRoots,
}, {
  id: '20261126_agent_grant_dependencies', phase: 'expand', level: 10,
  expandRelease: '0.2.95', release: '0.2.95', run: expandAgentGrantDependencies,
}, {
  id: '20261126_durable_delegations', phase: 'expand', level: 10,
  expandRelease: '0.2.95', release: '0.2.95', run: expandDurableDelegations,
}];
