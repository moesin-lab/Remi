import type { SqlDatabase } from './db/postgres.js';

export function expandTaskAuthority(db: SqlDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS multiremi_attempt_input_approvals (
    manifest_id TEXT NOT NULL, manifest_version INTEGER NOT NULL CHECK(manifest_version>0), manifest_digest TEXT NOT NULL,
    manifest_snapshot TEXT NOT NULL, attempt_id TEXT NOT NULL, subject_id TEXT NOT NULL, grant_id TEXT NOT NULL REFERENCES multiremi_root_grants(grant_id),
    grant_generation INTEGER NOT NULL, runtime_trust_id TEXT NOT NULL REFERENCES multiremi_runtime_trusts(trust_id), runtime_trust_version INTEGER NOT NULL,
    invocation_digest TEXT NOT NULL, execution_digest TEXT NOT NULL, config_epoch INTEGER NOT NULL,
    provider_trust_json TEXT NOT NULL, checkpoint_trust_json TEXT NOT NULL,
    authority_node_id TEXT NOT NULL REFERENCES multiremi_authority_nodes(node_id), authority_generation INTEGER NOT NULL,
    issuer_grant_id TEXT NOT NULL REFERENCES multiremi_root_grants(grant_id), issuer_grant_generation INTEGER NOT NULL,
    invoker_node_id TEXT NOT NULL REFERENCES multiremi_authority_nodes(node_id), invoker_node_generation INTEGER NOT NULL,
    invoker_grant_id TEXT NOT NULL REFERENCES multiremi_root_grants(grant_id), invoker_grant_generation INTEGER NOT NULL,
    PRIMARY KEY(manifest_id,manifest_version)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS multiremi_attempt_eligibility (
    attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES multiremi_turn_attempts(id) ON DELETE CASCADE,
    eligibility TEXT NOT NULL CHECK (eligibility IN ('none','root')),
    subject_type TEXT, subject_id TEXT, grant_id TEXT, grant_generation INTEGER,
    runtime_trust_id TEXT, runtime_trust_version INTEGER, invocation_json TEXT, manifest_json TEXT,
    runtime_id TEXT, daemon_id TEXT, incarnation TEXT, execution_digest TEXT, config_epoch INTEGER,
    provider_trust_json TEXT, checkpoint_trust_json TEXT, admission_revision BIGINT,
    CHECK (eligibility='none' OR (subject_type='agent' AND subject_type IS NOT NULL AND subject_id IS NOT NULL
      AND grant_id IS NOT NULL AND grant_generation IS NOT NULL AND runtime_trust_id IS NOT NULL
      AND runtime_trust_version IS NOT NULL AND invocation_json IS NOT NULL AND manifest_json IS NOT NULL
      AND runtime_id IS NOT NULL AND daemon_id IS NOT NULL AND incarnation IS NOT NULL AND execution_digest IS NOT NULL
      AND config_epoch IS NOT NULL AND provider_trust_json IS NOT NULL AND admission_revision IS NOT NULL)),
    FOREIGN KEY(subject_type,subject_id,grant_generation,grant_id)
      REFERENCES multiremi_root_grants(subject_type,subject_id,generation,grant_id),
    FOREIGN KEY(runtime_id,runtime_trust_version) REFERENCES multiremi_runtime_trusts(runtime_id,generation)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS multiremi_current_task_leases (
    attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES multiremi_attempt_eligibility(attempt_id) ON DELETE CASCADE,
    lease_version BIGINT NOT NULL CHECK (lease_version>0), lease_id TEXT NOT NULL CHECK(length(lease_id)>0),
    fence_term TEXT NOT NULL CHECK(length(fence_term)>0), consumer_id TEXT NOT NULL, run_generation INTEGER NOT NULL CHECK(run_generation>=0),
    runtime_id TEXT NOT NULL, daemon_id TEXT NOT NULL, incarnation TEXT NOT NULL, expires_at_ms BIGINT NOT NULL CHECK(expires_at_ms>0),
    state TEXT NOT NULL CHECK(state IN ('dispatched','running')),
    FOREIGN KEY(attempt_id,consumer_id) REFERENCES multiremi_usage_runs(task_id,run_id)
  )`);
}
