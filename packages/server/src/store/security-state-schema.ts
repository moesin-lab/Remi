import type { SqlDatabase } from './db/postgres.js';

export function expandSecurityState(db: SqlDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS multiremi_security_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    security_revision INTEGER NOT NULL DEFAULT 0 CHECK (security_revision >= 0),
    bootstrap_completed INTEGER NOT NULL DEFAULT 0 CHECK (bootstrap_completed IN (0, 1)),
    feature_activation INTEGER NOT NULL DEFAULT 0 CHECK (feature_activation IN (0, 1)),
    minimum_enforcement_version TEXT,
    CHECK (feature_activation = 0 OR (bootstrap_completed = 1 AND minimum_enforcement_version IS NOT NULL))
  )`);
  db.run('INSERT INTO multiremi_security_state(singleton) VALUES(1) ON CONFLICT(singleton) DO NOTHING');
}
