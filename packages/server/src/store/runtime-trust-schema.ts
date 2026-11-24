import type { SqlDatabase } from './db/postgres.js';

export function expandRuntimeTrust(db: SqlDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS multiremi_machine_enrollments (
    incarnation TEXT PRIMARY KEY NOT NULL, deployment_id TEXT NOT NULL, consumer_id TEXT NOT NULL,
    runtime_id TEXT NOT NULL REFERENCES multiremi_runtimes(id), daemon_id TEXT NOT NULL,
    credential_id TEXT NOT NULL REFERENCES multiremi_access_tokens(id), credential_digest TEXT NOT NULL,
    authority_node_id TEXT NOT NULL UNIQUE REFERENCES multiremi_authority_nodes(node_id), generation INTEGER NOT NULL CHECK(generation>0),
    signing_spki TEXT NOT NULL, recipient_spki TEXT NOT NULL, recipient_key_id TEXT NOT NULL,
    key_expires_at_ms BIGINT NOT NULL, isolation_verified_at_ms BIGINT NOT NULL, retired_at_ms BIGINT,
    immutable_carrier_verified_at_ms BIGINT NOT NULL, attestation_expires_at_ms BIGINT NOT NULL, attestation_id TEXT NOT NULL
  )`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_multiremi_current_machine_enrollment ON multiremi_machine_enrollments(runtime_id) WHERE retired_at_ms IS NULL`);
  db.exec(`CREATE TABLE IF NOT EXISTS multiremi_machine_challenges (
    challenge_id TEXT PRIMARY KEY NOT NULL, incarnation TEXT NOT NULL REFERENCES multiremi_machine_enrollments(incarnation),
    purpose TEXT NOT NULL, target_id TEXT NOT NULL, nonce_digest TEXT NOT NULL UNIQUE, binding_digest TEXT NOT NULL,
    expires_at_ms BIGINT NOT NULL, consumed_at_ms BIGINT, proof_digest TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS multiremi_runtime_trusts (
    trust_id TEXT PRIMARY KEY NOT NULL, runtime_id TEXT NOT NULL REFERENCES multiremi_runtimes(id),
    generation INTEGER NOT NULL CHECK(generation>0), incarnation TEXT NOT NULL REFERENCES multiremi_machine_enrollments(incarnation),
    challenge_id TEXT NOT NULL UNIQUE REFERENCES multiremi_machine_challenges(challenge_id),
    authority_node_id TEXT NOT NULL UNIQUE REFERENCES multiremi_authority_nodes(node_id),
    record_json TEXT NOT NULL, revoked_at_ms BIGINT, UNIQUE(runtime_id,generation)
  )`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_multiremi_current_runtime_trust ON multiremi_runtime_trusts(runtime_id) WHERE revoked_at_ms IS NULL`);
}
