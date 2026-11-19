import ts from 'typescript';
import { builtinModules } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
/** Resolve repository runtime imports with the repository's actual tsconfig. */
export function dependencyGraph(root) {
  const configPath = resolve(root, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error)
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  if (parsed.errors.length)
    throw new Error(parsed.errors.map(e => ts.flattenDiagnosticMessageText(e.messageText, '\n')).join('\n'));
  const cache = new Map();
  function read(file) {
    const cached = cache.get(file);
    if (cached)
      return cached;
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const dependencies = [];
    function add(specifier) {
      if (specifier.startsWith('node:') || specifier.startsWith('bun:') || builtinModules.includes(specifier))
        return;
      const result = ts.resolveModuleName(specifier, file, parsed.options, ts.sys).resolvedModule;
      if (!result) {
        throw new Error(`Unresolved runtime dependency ${specifier} from ${relative(root, file)}`);
      }
      const target = resolve(result.resolvedFileName);
      const path = relative(root, target).replaceAll('\\', '/');
      if (!path.startsWith('..') && !path.includes('node_modules/') && !target.endsWith('.d.ts'))
        dependencies.push(target);
    }
    function visit(node) {
      if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) {
        const bindings = node.importClause?.namedBindings;
        if (!(bindings && ts.isNamedImports(bindings) && !node.importClause?.name && bindings.elements.length && bindings.elements.every(e => e.isTypeOnly)))
          add(node.moduleSpecifier.text);
      }
      if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        if (!(node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length && node.exportClause.elements.every(e => e.isTypeOnly)))
          add(node.moduleSpecifier.text);
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]))
        add(node.arguments[0].text);
      ts.forEachChild(node, visit);
    }
    visit(source);
    const result = { source, dependencies };
    cache.set(file, result);
    return result;
  }
  return read;
}
export function reachableModules(root, roots, excluded = new Set(), read = dependencyGraph(root)) {
  const visited = new Set(), pending = roots.map(file => resolve(root, file));
  while (pending.length) {
    const file = pending.pop(), path = relative(root, file).replaceAll('\\', '/');
    if (visited.has(path) || excluded.has(path) || !/\.(?:[cm]?[jt]sx?|json)$/.test(path))
      continue;
    visited.add(path);
    pending.push(...read(file).dependencies);
  }
  return [...visited].sort();
}
