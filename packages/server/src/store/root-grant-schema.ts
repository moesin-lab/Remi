import type { SqlDatabase } from './db/postgres.js';

export function expandRootGrants(db: SqlDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS multiremi_root_grants (
    grant_id TEXT PRIMARY KEY NOT NULL,
    subject_type TEXT NOT NULL CHECK (subject_type IN ('user', 'agent')),
    subject_id TEXT NOT NULL CHECK (length(subject_id) > 0),
    generation INTEGER NOT NULL CHECK (generation > 0),
    scope TEXT NOT NULL CHECK (scope = 'system'),
    authority_node_id TEXT NOT NULL UNIQUE REFERENCES multiremi_authority_nodes(node_id),
    issuer_type TEXT NOT NULL CHECK (issuer_type IN ('user', 'agent', 'deployment')),
    issuer_id TEXT NOT NULL CHECK (length(issuer_id) > 0),
    issuer_credential_id TEXT,
    issuer_attempt_id TEXT,
    origin_family_id TEXT,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
    created_at_ms BIGINT NOT NULL CHECK (created_at_ms > 0),
    expires_at_ms BIGINT CHECK (expires_at_ms > created_at_ms),
    revoked_at_ms BIGINT CHECK (revoked_at_ms >= created_at_ms),
    revoke_reason TEXT,
    CHECK (issuer_type <> 'agent' OR (issuer_attempt_id IS NOT NULL AND issuer_credential_id IS NOT NULL)),
    CHECK ((revoked_at_ms IS NULL AND revoke_reason IS NULL) OR
      (revoked_at_ms IS NOT NULL AND revoke_reason IS NOT NULL AND length(trim(revoke_reason)) > 0)),
    UNIQUE(subject_type, subject_id, generation),
    UNIQUE(subject_type, subject_id, generation, grant_id)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS multiremi_root_subject_state (
    subject_type TEXT NOT NULL CHECK (subject_type IN ('user', 'agent')),
    subject_id TEXT NOT NULL CHECK (length(subject_id) > 0),
    generation_counter INTEGER NOT NULL CHECK (generation_counter >= 0),
    active_grant_id TEXT,
    PRIMARY KEY(subject_type, subject_id),
    FOREIGN KEY(subject_type, subject_id, generation_counter, active_grant_id)
      REFERENCES multiremi_root_grants(subject_type, subject_id, generation, grant_id)
  )`);
}
