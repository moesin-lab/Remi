import type { SqlDatabase } from './db/postgres.js';

export function expandJwtMaterials(db: SqlDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS multiremi_jwt_signing_domains (
    domain_id TEXT PRIMARY KEY NOT NULL, key_epoch TEXT NOT NULL, key_digest TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS multiremi_jwt_materials (
    compact_digest TEXT PRIMARY KEY NOT NULL,
    credential_id TEXT NOT NULL, material_version INTEGER NOT NULL CHECK (material_version > 0),
    subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, purpose TEXT NOT NULL,
    claims_json TEXT NOT NULL, header_json TEXT NOT NULL,
    expires_at_ms BIGINT NOT NULL CHECK (expires_at_ms > 0),
    domain_id TEXT NOT NULL REFERENCES multiremi_jwt_signing_domains(domain_id), key_epoch TEXT NOT NULL,
    family_id TEXT NOT NULL REFERENCES multiremi_credential_families(family_id),
    authority_node_id TEXT NOT NULL UNIQUE, authority_generation INTEGER NOT NULL, authority_seq BIGINT NOT NULL,
    revoked_at_ms BIGINT,
    UNIQUE(credential_id,material_version),
    FOREIGN KEY(authority_node_id,authority_generation,authority_seq)
      REFERENCES multiremi_authority_nodes(node_id,generation,issued_seq)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS multiremi_jwt_current (
    credential_id TEXT PRIMARY KEY NOT NULL, current_material_version INTEGER NOT NULL CHECK (current_material_version > 0),
    FOREIGN KEY(credential_id,current_material_version) REFERENCES multiremi_jwt_materials(credential_id,material_version)
  )`);
}
