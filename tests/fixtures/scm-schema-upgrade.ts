import type { SqlDatabase } from '../../packages/server/src/store/db/postgres.js';

export function removeScmSchema(db: SqlDatabase) {
  db.exec(`DROP TABLE multiremi_scm_audit_changes; DROP TABLE multiremi_scm_audit_entries;
    DROP TABLE multiremi_scm_audit_generations; DROP TABLE multiremi_scm_audit_state;
    DROP TABLE multiremi_scm_rollback_review; DROP TABLE multiremi_scm_link_ownership;
    DROP TABLE multiremi_scm_ownership_cutover`);
}
