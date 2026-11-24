import type { SqlDatabase } from './db/postgres.js';

export function expandRootReceipts(db: SqlDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS multiremi_credential_materials (
    credential_id TEXT PRIMARY KEY NOT NULL REFERENCES multiremi_access_tokens(id),
    material_version INTEGER NOT NULL CHECK(material_version > 0),
    family_id TEXT NOT NULL REFERENCES multiremi_credential_families(family_id),
    authority_node_id TEXT NOT NULL UNIQUE, authority_generation INTEGER NOT NULL, authority_seq BIGINT NOT NULL,
    expires_at_ms BIGINT NOT NULL CHECK(expires_at_ms > 0),
    UNIQUE(credential_id, material_version),
    FOREIGN KEY(authority_node_id,authority_generation,authority_seq) REFERENCES multiremi_authority_nodes(node_id,generation,issued_seq)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS multiremi_delivery_receipts (
    receipt_id TEXT PRIMARY KEY NOT NULL, attempt_id TEXT NOT NULL REFERENCES multiremi_turn_attempts(id),
    handoff_id TEXT, run_generation INTEGER NOT NULL CHECK(run_generation >= 0), consumer_id TEXT NOT NULL,
    receipt_version INTEGER NOT NULL CHECK(receipt_version > 0), delivery_version INTEGER NOT NULL CHECK(delivery_version > 0),
    material_version INTEGER NOT NULL, credential_id TEXT NOT NULL UNIQUE,
    binding_json TEXT NOT NULL, envelope TEXT NOT NULL, envelope_digest TEXT NOT NULL, business_payload_json TEXT NOT NULL,
    start_deadline TEXT NOT NULL, lease_id TEXT NOT NULL, fence_term TEXT NOT NULL,
    ack_state TEXT NOT NULL CHECK(ack_state IN ('pending','confirmed')), execution_locator_json TEXT,
    run_state TEXT NOT NULL CHECK(run_state IN ('pending_start','running','terminal','revoked','expired')),
    CHECK((ack_state='pending' AND execution_locator_json IS NULL) OR (ack_state='confirmed' AND execution_locator_json IS NOT NULL)),
    CHECK(run_state<>'running' OR ack_state='confirmed'),
    UNIQUE(attempt_id,run_generation),
    FOREIGN KEY(attempt_id,consumer_id) REFERENCES multiremi_usage_runs(task_id,run_id),
    FOREIGN KEY(credential_id,material_version) REFERENCES multiremi_credential_materials(credential_id,material_version)
  )`);
}
