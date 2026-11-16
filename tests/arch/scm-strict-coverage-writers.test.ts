import { expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const root = join(import.meta.dir, '../..');
const repo = 'packages/server/src/store/repos/scm-repo.ts';
const migration = 'packages/server/src/store/migrations.ts';
// Every SQL writer needs review. URL refreshes in the default helper are covered
// by reconciliation's append; createConnection has no pre-existing bindings,
// and updateConnection refreshes the already reconciled workspace URL. New
// bindings in either path go through upsert, transfers through demoteAndTransfer.
const writers: Record<string, { appends?: true; caller?: string }> = {
  upsertRepositoryBindingLocked: { appends: true },
  reconcileRepositoryBindingsWithinTransaction: { appends: true },
  demoteAndTransferDefaultBindingsLocked: { appends: true },
  reconcileDefaultBindingsLocked: { caller: 'reconcileRepositoryBindingsWithinTransaction' },
};
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory()
    ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []);
}
function inspect(path: string, source: string) {
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const methods = new Map<string, ts.MethodDeclaration>();
  const writes: string[] = [], errors: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isMethodDeclaration(node)) methods.set(node.name.getText(tree), node);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const sql = ts.isTemplateExpression(node) ? node.getText(tree) : node.text;
      const insert = /\bINSERT\s+INTO\s+multiremi_scm_repository_bindings\b/i.test(sql);
      const assignments = /\bUPDATE\s+multiremi_scm_repository_bindings\s+SET\b([\s\S]*?)(?:\bWHERE\b|\bRETURNING\b|$)/i.exec(sql)?.[1];
      if (insert || assignments && /\b(?:connection_id|repository_url)\s*=/i.test(assignments)) {
        let owner: ts.Node | undefined = node.parent;
        while (owner && !ts.isMethodDeclaration(owner) && !ts.isFunctionDeclaration(owner)) owner = owner.parent;
        const name = owner && (ts.isMethodDeclaration(owner) || ts.isFunctionDeclaration(owner)) ? owner.name?.getText(tree) ?? '<anonymous>' : '<outside method>';
        writes.push(name);
        // Legacy bootstrap only: runs once before merge-policy tables exist.
        // Runtime coverage is owned by subsequent strict policy PUT/append.
        const bootstrap = path === migration && name === 'backfillSingleScmDefaults';
        if (!bootstrap && (path !== repo || !writers[name])) errors.push(`${path}:${name}: unregistered binding writer`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  if (path === repo) for (const [name, rule] of Object.entries(writers)) {
    const method = methods.get(name), body = method?.body?.getText(tree) ?? '';
    if (!writes.includes(name)) errors.push(`${name}: registered writer disappeared`);
    if (rule.appends && !/\.appendStrictCoverage\(/.test(body)) errors.push(`${name}: missing coverage append`);
    if (rule.caller) {
      const caller = methods.get(rule.caller)?.body?.getText(tree) ?? '';
      if (!caller.includes(`this.${name}(`) || !/\.appendStrictCoverage\(/.test(caller)) errors.push(`${name}: missing responsible caller ${rule.caller}`);
    }
  }
  return errors;
}
it('registers every binding insert and remote/connection update with its transactional coverage owner', () => {
  expect(files(join(root, 'packages/server/src')).flatMap(file => inspect(relative(root, file), readFileSync(file, 'utf8')))).toEqual([]);
});
it('keeps the sole legacy bootstrap writer behind the one-time pre-policy migration', () => {
  const source = readFileSync(join(root, migration), 'utf8');
  expect(source).toContain('runMigrationOnce(db, SCM_DEFAULT_SCOPE_MIGRATION, () => backfillSingleScmDefaults(db))');
  expect(inspect(migration, 'function unexpected() { db.run("INSERT INTO multiremi_scm_repository_bindings (id) VALUES (?)"); }')).toEqual([`${migration}:unexpected: unregistered binding writer`]);
});
it('rejects an unregistered binding writer, including an UPDATE after unrelated SET columns', () => {
  for (const sql of [
    'INSERT INTO multiremi_scm_repository_bindings (id) VALUES (?)',
    'UPDATE multiremi_scm_repository_bindings SET updated_at=?, connection_id=? WHERE id=?',
    'UPDATE multiremi_scm_repository_bindings SET repository_url=? WHERE id=?',
  ]) expect(inspect('fixture.ts', `class FutureRepo { bypass() { db.run(\`${sql}\`); } }`)).toEqual(['fixture.ts:bypass: unregistered binding writer']);
  expect(inspect('fixture.ts', 'class Repo { touch() { db.run("UPDATE multiremi_scm_repository_bindings SET updated_at=? WHERE connection_id=?"); } }')).toEqual([]);
});
it('rejects removing an append from a registered writer', () => {
  const source = readFileSync(join(root, repo), 'utf8');
  expect(inspect(repo, source.replaceAll('.appendStrictCoverage(', '.removedAppend(')).some(error => error.includes('missing coverage append'))).toBe(true);
});
