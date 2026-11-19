import ts from 'typescript';
import { dependencyGraph, reachableModules } from './schema-module-graph.mjs';
import legacyInputs from '../packages/platform-updater/src/data-schema-inputs.json';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { resolve, relative, extname } from 'node:path';
import { hasDestructiveSchemaSql, hasLegacyDestructiveSchemaSql } from '../packages/server/src/store/schema-ddl.js';

export interface StartupDdl { file: string; line: number; sql: string; fingerprint: string }

const contracts = new Set([
  'packages/server/src/store/schema-contracts.ts',
  'packages/server/src/store/schema-contract-migrations.ts',
]);


function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    if (entry.name === '__tests__' || entry.name === 'tests') return [];
    return entry.isDirectory() ? sources(path) : /\.[cm]?[jt]sx?$/.test(entry.name)
      && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

/** The API server owns startup, standby preparation and active background jobs. */
export function assertStartupContractIsolation(root: string): void {
  const read = dependencyGraph(root);
  const pending = [resolve(root, 'packages/server/src/api/server.ts')];
  const visited = new Set<string>();
  while (pending.length) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    if (contracts.has(relative(root, file).replaceAll('\\', '/'))) throw new Error(`Explicit contract module reachable from API startup: ${relative(root, file)}`);
    if (/\.[cm]?[jt]sx?$/.test(extname(file))) pending.push(...read(file).dependencies);
  }
}

/** All non-test server source plus its transitive repository runtime imports. */
export function startupSchemaDdl(root: string, scannedFiles?: Set<string>): StartupDdl[] {
  const read = dependencyGraph(root);
  const pending = reachableModules(root, sources(resolve(root, 'packages/server/src')), contracts, read).map(file => resolve(root, file));
  const visited = new Set<string>();
  const found: StartupDdl[] = [];
  while (pending.length) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const filename = relative(root, file).replaceAll('\\', '/');
    if (contracts.has(filename) || filename.startsWith('..') || filename.includes('node_modules/') || !/\.(?:[cm]?[jt]sx?|json)$/.test(filename)) continue;
    const { source } = read(file);
    scannedFiles?.add(filename);

    function visit(node: ts.Node) {
      // A frozen generic DROP helper must not acquire new startup callers.
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'dropColumnIfExists') {
        const sql = node.getText(source).replace(/\r\n/g, '\n');
        found.push({ file: filename, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, sql,
          fingerprint: createHash('sha256').update(filename + '\n' + sql).digest('hex') });
      }
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
        const sql = ts.isTemplateExpression(node) ? [node.head.text, ...node.templateSpans.map(span => '${…}' + span.literal.text)].join('') : node.text;
        if ((legacyInputs.includes(filename) ? hasLegacyDestructiveSchemaSql : hasDestructiveSchemaSql)(sql)) {
          const normalized = sql.replace(/\r\n/g, '\n');
          const expression = node.getText(source).replace(/\r\n/g, '\n');
          found.push({ file: filename, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, sql: normalized,
            fingerprint: createHash('sha256').update(filename + '\n' + expression).digest('hex') });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
