import ts from 'typescript';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { hasDestructiveSchemaSql } from '../packages/server/src/store/schema-ddl.js';

export interface StartupDdl { file: string; line: number; sql: string; fingerprint: string }

/** Scan every non-test server source, including unimported/new background jobs.
 * Only the dedicated explicit-contract modules are exempt; no caller allowlist. */
export function startupSchemaDdl(root: string): StartupDdl[] {
  function sources(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const path = resolve(directory, entry.name);
      if (entry.name === '__tests__' || entry.name === 'tests') return [];
      return entry.isDirectory() ? sources(path) : /\.[cm]?tsx?$/.test(entry.name)
        && !/\.(?:test|spec)\.[cm]?tsx?$/.test(entry.name) ? [path] : [];
    });
  }
  const contracts = new Set([
    'packages/server/src/store/schema-contracts.ts',
    'packages/server/src/store/schema-contract-migrations.ts',
  ]);
  const pending = sources(resolve(root, 'packages/server/src'));
  const visited = new Set<string>();
  const found: StartupDdl[] = [];
  while (pending.length) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const filename = relative(root, file).replaceAll('\\', '/');
    if (contracts.has(filename) || filename.startsWith('..') || filename.includes('node_modules/') || !/\.[cm]?tsx?$/.test(filename)) continue;
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      // A frozen generic DROP helper must not acquire new startup callers.
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'dropColumnIfExists') {
        const sql = node.getText(source).replace(/\r\n/g, '\n');
        found.push({ file: filename, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, sql,
          fingerprint: createHash('sha256').update(filename + '\n' + sql).digest('hex') });
      }
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
        const sql = ts.isTemplateExpression(node) ? [node.head.text, ...node.templateSpans.map(span => '${…}' + span.literal.text)].join('') : node.text;
        if (hasDestructiveSchemaSql(sql)) {
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
