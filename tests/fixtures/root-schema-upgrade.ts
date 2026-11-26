import type { SqlDatabase } from '../../packages/server/src/store/db/postgres.js';

export function removeRootSchema(db: SqlDatabase): void {
  db.exec(`DROP TABLE multiremi_security_state;
    DROP TABLE multiremi_current_task_leases;
    DROP TABLE multiremi_attempt_eligibility;
    DROP TABLE multiremi_attempt_input_approvals;
    DROP TABLE multiremi_jwt_current;
    DROP TABLE multiremi_jwt_materials;
    DROP TABLE multiremi_jwt_signing_domains;
    DROP TABLE multiremi_delivery_receipts;
    DROP TABLE multiremi_credential_materials;
    DROP TABLE multiremi_credential_version_bindings;
    DROP TABLE multiremi_runtime_trusts;
    DROP TABLE multiremi_machine_challenges;
    DROP TABLE multiremi_machine_enrollments;
    DROP TABLE multiremi_root_bootstrap_authorizations;
    DROP TABLE multiremi_root_management_events;
    DROP TABLE multiremi_credential_families;
    DROP TABLE multiremi_password_authority_versions;
    DROP TABLE multiremi_root_subject_state;
    DROP TABLE multiremi_root_grants;
    DROP TABLE multiremi_authority_edges;
    DROP TABLE multiremi_authority_nodes;`);
}
