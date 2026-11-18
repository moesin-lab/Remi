import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';

// Follow local imports, including re-exports. Conservatively include any reachable
// module containing DDL, even if only one of its exported helpers is a migration.
export function migrationDdlModules(root) {
  const seen = new Set(), ddl = [];
  const aliases = { '@multiremi/store/': 'packages/server/src/store/', '@multiremi/contracts/': 'packages/contracts/src/',
    '@multiremi/': 'packages/server/src/', '@shared/': 'packages/shared/src/' };
  function visit(path) {
    if (seen.has(path) || !existsSync(path)) return;
    seen.add(path);
    const source = readFileSync(path, 'utf8');
    if (/\b(?:CREATE\s+(?:(?:UNIQUE|TEMP|TEMPORARY)\s+)?(?:TABLE|INDEX|VIEW|TRIGGER)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX|VIEW|TRIGGER)|TRUNCATE\s+TABLE)\b/i.test(source)) ddl.push(relative(root, path).replaceAll('\\', '/'));
    for (const match of source.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)['"]([^'"]+)['"]/g)) {
      const spec = match[1]; let target;
      if (spec.startsWith('.')) target = resolve(dirname(path), spec);
      else for (const [alias, directory] of Object.entries(aliases)) if (spec.startsWith(alias)) { target = resolve(root, directory + spec.slice(alias.length)); break; }
      if (target) visit(target.replace(/\.js$/, '.ts'));
    }
  }
  visit(resolve(root, 'packages/server/src/store/migrations.ts'));
  return ddl.sort();
}
// inputs is the frozen legacy archive list; new modules must be covered by the
// B1 scanner's actual traversal instead of changing old archive fingerprints.
export function missingMigrationInputs(root, inputs, scannedFiles = new Set()) {
  return migrationDdlModules(root).filter(path => !inputs.includes(path) && !scannedFiles.has(path));
}
