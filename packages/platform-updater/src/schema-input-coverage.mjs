import { reachableModules } from '../../../scripts/schema-module-graph.mjs';

// Conservatively cover EVERY runtime dependency: no source-text DDL filter.
export function migrationDdlModules(root) {
  return reachableModules(root, ['packages/server/src/store/migrations.ts']);
}
// inputs is the frozen legacy archive list; new modules must be covered by the
// B1 scanner's actual traversal instead of changing old archive fingerprints.
export function missingMigrationInputs(root, inputs, scannedFiles = new Set()) {
  return migrationDdlModules(root).filter(path => !inputs.includes(path) && !scannedFiles.has(path));
}
