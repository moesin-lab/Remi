import { PLATFORM_FAILURE_EXAMPLE_LIMIT, PLATFORM_MANUAL_UPGRADE_URL, type PlatformSchemaContractFailure } from '@multiremi/contracts/platform-failure';

export class SchemaContractRefusedError extends Error {
  constructor(readonly failure: PlatformSchemaContractFailure) {
    super(`Migration rehearsal removed or changed an existing column; automatic application update refused (${failure.currentVersion} -> ${failure.targetVersion}, ${failure.stage}): ${failure.removedTables.total} missing tables, ${failure.removedColumns.total} missing columns, ${failure.changedColumns.total} changed columns; ${failure.affectedColumnCount} affected old signatures. Examples: ${[...failure.removedTables.examples, ...failure.removedColumns.examples, ...failure.changedColumns.examples].join('; ')}. Manual upgrade: ${PLATFORM_MANUAL_UPGRADE_URL}`);
    this.name = 'SchemaContractRefusedError';
  }
}

/** Compare the same full signatures as the safety gate; classify by table/column identity. */
export function assertSchemaContract(before: string[], after: string[], context: Pick<PlatformSchemaContractFailure, 'stage' | 'currentVersion' | 'targetVersion'>): void {
  const signatures = new Set(after);
  const missing = [...new Set(before)].filter(signature => !signatures.has(signature)).sort();
  if (!missing.length) return;
  const identity = (signature: string) => signature.slice(0, signature.indexOf(':'));
  const table = (column: string) => column.slice(0, column.lastIndexOf('.'));
  const columns = new Map(after.map(signature => [identity(signature), signature]));
  const tables = new Set([...columns.keys()].map(table));
  const removedTables = [...new Set(missing.map(signature => table(identity(signature))).filter(name => !tables.has(name)))].sort();
  const removedColumns = missing.filter(signature => tables.has(table(identity(signature))) && !columns.has(identity(signature)));
  const changedColumns = missing.filter(signature => columns.has(identity(signature))).map(signature => `${signature} -> ${columns.get(identity(signature))}`);
  let remaining = PLATFORM_FAILURE_EXAMPLE_LIMIT;
  const summarize = (values: string[]) => {
    const examples = values.slice(0, remaining).map(value => value.slice(0, 1024));
    remaining -= examples.length;
    return { total: values.length, examples };
  };
  throw new SchemaContractRefusedError({ reason: 'schema_contract_refused', ...context, manualUpgradeUrl: PLATFORM_MANUAL_UPGRADE_URL,
    affectedColumnCount: missing.length, removedTables: summarize(removedTables), removedColumns: summarize(removedColumns), changedColumns: summarize(changedColumns) });
}
