import ts from 'typescript';
import { builtinModules } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative, extname } from 'node:path';
import { hasDestructiveSchemaSql } from '../packages/server/src/store/schema-ddl.js';

export interface StartupDdl { file: string; line: number; sql: string; fingerprint: string }

const contracts = new Set([
  'packages/server/src/store/schema-contracts.ts',
  'packages/server/src/store/schema-contract-migrations.ts',
]);

/** Resolve repository runtime imports with the repository's actual tsconfig. */
function dependencyGraph(root: string) {
  const configPath = resolve(root, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  if (parsed.errors.length) throw new Error(parsed.errors.map(e => ts.flattenDiagnosticMessageText(e.messageText, '\n')).join('\n'));
  const cache = new Map<string, { source: ts.SourceFile; dependencies: string[] }>();
  function read(file: string) {
    const cached = cache.get(file);
    if (cached) return cached;
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const dependencies: string[] = [];
    function add(specifier: string) {
      if (specifier.startsWith('node:') || specifier.startsWith('bun:') || builtinModules.includes(specifier)) return;
      const result = ts.resolveModuleName(specifier, file, parsed.options, ts.sys).resolvedModule;
      if (!result) {
        throw new Error(`Unresolved runtime dependency ${specifier} from ${relative(root, file)}`);
      }
      const target = resolve(result.resolvedFileName);
      const path = relative(root, target).replaceAll('\\', '/');
      if (!path.startsWith('..') && !path.includes('node_modules/') && !target.endsWith('.d.ts')) dependencies.push(target);
    }
    function visit(node: ts.Node) {
      if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) {
        const bindings = node.importClause?.namedBindings;
        if (!(bindings && ts.isNamedImports(bindings) && !node.importClause?.name && bindings.elements.length && bindings.elements.every(e => e.isTypeOnly))) add(node.moduleSpecifier.text);
      }
      if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        if (!(node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length && node.exportClause.elements.every(e => e.isTypeOnly))) add(node.moduleSpecifier.text);
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) add(node.arguments[0].text);
      ts.forEachChild(node, visit);
    }
    visit(source);
    const result = { source, dependencies };
    cache.set(file, result);
    return result;
  }
  return read;
}

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
export function startupSchemaDdl(root: string): StartupDdl[] {
  const read = dependencyGraph(root);
  const pending = sources(resolve(root, 'packages/server/src'));
  const visited = new Set<string>();
  const found: StartupDdl[] = [];
  while (pending.length) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const filename = relative(root, file).replaceAll('\\', '/');
    if (contracts.has(filename) || filename.startsWith('..') || filename.includes('node_modules/') || !/\.[cm]?[jt]sx?$/.test(filename)) continue;
    const { source, dependencies } = read(file);
    pending.push(...dependencies);
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
