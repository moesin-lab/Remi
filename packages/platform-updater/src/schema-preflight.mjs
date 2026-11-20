import { canonicalSchemaLevel } from './schema-fingerprint.mjs';

// No migration imports: both queries run in read-only transactions, before drain/stop.
export const SCHEMA_INVENTORY_SQL = `BEGIN READ ONLY; SELECT json_build_object(
  'historical', EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'multiremi\\_%' ESCAPE '\\'),
  'metadata', to_regclass('public.multiremi_schema_meta') IS NOT NULL); COMMIT;`;
export const SCHEMA_METADATA_SQL = 'BEGIN READ ONLY; SELECT coalesce(json_agg(t), \'[]\'::json) FROM public.multiremi_schema_meta t; COMMIT;';
export const PREPARE_REQUIRED = 'Historical schema preparation required. Old services have not been stopped. Stop ALL API slots, workers and other database clients; back up; run the TARGET version of remi db prepare offline; then retry deployment. See docs/deploy/b1-schema-upgrade.md. Do not restore database backups.';

export async function readDeploymentSchema(query) {
  const inventory = JSON.parse(await query(SCHEMA_INVENTORY_SQL));
  if (typeof inventory?.historical !== 'boolean' || typeof inventory?.metadata !== 'boolean') throw new Error('Invalid schema inventory');
  if (!inventory.metadata) return { historical: inventory.historical, expandLevel: 0, contractLevel: 0 };
  const rows = JSON.parse(await query(SCHEMA_METADATA_SQL));
  const row = rows?.[0];
  if (!Array.isArray(rows) || rows.length !== 1 || row.singleton !== 1 || ![row.expand_level, row.contract_level].every(n => Number.isSafeInteger(n) && n >= 0) || row.contract_level > row.expand_level) throw new Error('Invalid schema metadata; refusing deployment');
  return { historical: inventory.historical, expandLevel: row.expand_level, contractLevel: row.contract_level };
}

export function assertDeploymentSchema(target, current) {
  if (target === null) return; // Legacy target has no B1 enrollment requirement.
  canonicalSchemaLevel(target);
  if (current.historical && current.expandLevel === 0) throw new Error(PREPARE_REQUIRED);
  if (current.contractLevel > target.maxLevel) throw new Error(`Database contract level ${current.contractLevel} exceeds target maximum ${target.maxLevel}; refusing deployment`);
  // Lower expand levels are handled by additive, versioned startup migrations.
}
