import type { SqlDatabase } from './db/postgres.js';

export function expandAuthorityProvenance(db: SqlDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS multiremi_authority_nodes (
    node_id TEXT PRIMARY KEY NOT NULL,
    issued_seq BIGINT NOT NULL UNIQUE CHECK (issued_seq > 0),
    generation INTEGER NOT NULL CHECK (generation > 0),
    kind TEXT NOT NULL,
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    expires_at_ms BIGINT NOT NULL CHECK (expires_at_ms > 0),
    revoked_at_ms BIGINT,
    continuous_parent_count INTEGER NOT NULL CHECK (continuous_parent_count >= 0),
    UNIQUE(node_id, generation, issued_seq)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS multiremi_authority_edges (
    child_id TEXT NOT NULL, child_generation INTEGER NOT NULL, child_seq BIGINT NOT NULL,
    parent_id TEXT NOT NULL, parent_generation INTEGER NOT NULL, parent_seq BIGINT NOT NULL,
    dependency TEXT NOT NULL CHECK (dependency IN ('continuous','evidence')),
    PRIMARY KEY(child_id, parent_id, dependency),
    CHECK (parent_seq < child_seq),
    FOREIGN KEY(child_id, child_generation, child_seq) REFERENCES multiremi_authority_nodes(node_id, generation, issued_seq),
    FOREIGN KEY(parent_id, parent_generation, parent_seq) REFERENCES multiremi_authority_nodes(node_id, generation, issued_seq)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_multiremi_authority_edges_parent ON multiremi_authority_edges(parent_id, dependency)`);
}
