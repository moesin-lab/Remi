/** Fixed recovery documentation; updater reports cannot supply arbitrary links. */
export const PLATFORM_MANUAL_UPGRADE_URL = 'https://github.com/moesin-lab/Remi/blob/main/docs/deploy/manual-schema-boundary-upgrade.md';
export const PLATFORM_FAILURE_EXAMPLE_LIMIT = 20;
export interface PlatformSchemaChangeSummary {
  total: number;
  examples: string[];
}
export interface PlatformSchemaContractFailure {
  reason: 'schema_contract_refused';
  stage: 'target' | 'previous';
  currentVersion: string;
  targetVersion: string;
  manualUpgradeUrl: typeof PLATFORM_MANUAL_UPGRADE_URL;
  /** Old signatures absent after migration, including columns of missing tables. */
  affectedColumnCount: number;
  removedTables: PlatformSchemaChangeSummary;
  removedColumns: PlatformSchemaChangeSummary;
  changedColumns: PlatformSchemaChangeSummary;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
/** Validate at both report ingress and durable receipt replay. Reject unknown fields. */
export function isPlatformSchemaContractFailure(value: unknown): value is PlatformSchemaContractFailure {
  if (!record(value) || Object.keys(value).some(key => !['reason', 'stage', 'currentVersion', 'targetVersion', 'manualUpgradeUrl', 'affectedColumnCount', 'removedTables', 'removedColumns', 'changedColumns'].includes(key))
    || value.reason !== 'schema_contract_refused' || (value.stage !== 'target' && value.stage !== 'previous')
    || ![value.currentVersion, value.targetVersion].every(version => typeof version === 'string' && version.length > 0 && version.length <= 128)
    || value.manualUpgradeUrl !== PLATFORM_MANUAL_UPGRADE_URL || !count(value.affectedColumnCount)) return false;
  let exampleCount = 0;
  for (const key of ['removedTables', 'removedColumns', 'changedColumns']) {
    const group = value[key];
    if (!record(group) || Object.keys(group).some(key => !['total', 'examples'].includes(key)) || !count(group.total)
      || !Array.isArray(group.examples) || group.examples.length > group.total
      || !group.examples.every(example => typeof example === 'string' && example.length > 0 && example.length <= 1024)) return false;
    exampleCount += group.examples.length;
  }
  return exampleCount <= PLATFORM_FAILURE_EXAMPLE_LIMIT;
}
