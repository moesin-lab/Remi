import ts from 'typescript';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { hasDestructiveSchemaSql } from '../packages/server/src/store/schema-ddl.js';

export interface StartupDdl { file: string; line: number; sql: string; fingerprint: string }

/** Follow runtime static imports (not type-only imports) from startup. Literal
 * SQL is checked even inside helper functions; function allowlists could hide
 * a newly appended destructive statement in an old helper. */
export function startupSchemaDdl(root: string): StartupDdl[] {
  const configPath = resolve(root, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile).config;
  const options = ts.parseJsonConfigFileContent(config, ts.sys, root).options;
  const pending = [resolve(root, 'packages/server/src/store/migrations.ts')];
  const visited = new Set<string>();
  const found: StartupDdl[] = [];
  while (pending.length) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const filename = relative(root, file).replaceAll('\\', '/');
    if (filename.startsWith('..') || filename.includes('node_modules/') || !/\.[cm]?tsx?$/.test(filename)) continue;
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    function dependency(specifier: string) {
      const resolved = ts.resolveModuleName(specifier, file, options, ts.sys).resolvedModule?.resolvedFileName;
      if (resolved) pending.push(resolved);
    }
    function visit(node: ts.Node) {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.importClause;
        const onlyTypes = clause?.isTypeOnly || (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
          && !clause.name && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every(binding => binding.isTypeOnly));
        if (!onlyTypes) dependency(node.moduleSpecifier.text);
      }
      if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) dependency(node.moduleSpecifier.text);
      // A frozen generic DROP helper must not acquire new startup callers.
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'dropColumnIfExists') {
        const sql = node.getText(source).replace(/\r\n/g, '\n');
        found.push({ file: filename, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, sql,
          fingerprint: createHash('sha256').update(filename + '\n' + sql).digest('hex') });
      }
      // A dynamic import in startup is still a startup dependency.
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) dependency(node.arguments[0].text);
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
