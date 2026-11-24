import { ensureDaemonDrainIdentity, ensurePlannedRestarts } from "./planned-restart-schema.js";
import { LIVE_TERM_SCHEMA } from './live-term-fence.js';
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
  id: '20261124_scm_link_ownership', phase: 'expand', level: 4,
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
  id: '20261124_scm_rollback_review', phase: 'expand', level: 5,
  expandRelease: '0.2.95', release: '0.2.95',
  run: db => {
    db.exec(`CREATE TABLE IF NOT EXISTS multiremi_scm_rollback_review (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
    )`);
    db.run(`INSERT INTO multiremi_scm_rollback_review (singleton)
      SELECT singleton FROM multiremi_scm_ownership_cutover WHERE complete = 1
      ON CONFLICT(singleton) DO NOTHING`);
  },
}, {
  id: '20261124_scm_audit_generations', phase: 'expand', level: 6,
  expandRelease: '0.2.95', release: '0.2.95',
  run: (db, startingExpandLevel) => {
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
    db.run(`INSERT INTO multiremi_scm_audit_state(singleton,phase) VALUES(1,CASE WHEN ?='initial' AND NOT EXISTS (SELECT 1 FROM multiremi_scm_ownership_cutover) AND NOT EXISTS (SELECT 1 FROM multiremi_scm_rollback_review) THEN 'initial' ELSE 'unknown' END) ON CONFLICT(singleton) DO NOTHING`,
      [startingExpandLevel !== undefined && startingExpandLevel < 4 ? 'initial' : 'unknown']);
  },
}];
