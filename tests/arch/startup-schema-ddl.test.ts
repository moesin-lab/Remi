import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startupSchemaDdl, assertStartupContractIsolation } from '../../scripts/startup-schema-ddl.js';
import { hasDestructiveSchemaSql } from '../../packages/server/src/store/schema-ddl.js';
import historical from './startup-schema-ddl-allowlist.json';

const root = resolve(import.meta.dir, '../..');
describe('startup migration expand discipline', () => {
  const base = process.env.SCHEMA_DDL_BASE_REF;
  const hasBase = Boolean(base && !/^0+$/.test(base!));
  (hasBase ? it : it.skip)('never grows the historical allowlist relative to the CI base'
    + (hasBase ? '' : ' (SCHEMA_DDL_BASE_REF unset or zero; CI base comparison unavailable)'), () => {
    if (!/^[a-f0-9]{40}$/.test(base!)) throw new Error('SCHEMA_DDL_BASE_REF must be a commit SHA');
    const path = 'tests/arch/startup-schema-ddl-allowlist.json';
    // The initial protocol PR introduces this file. Every subsequent change
    // must be a multiset subset of the target branch's manifest.
    const files = execFileSync('git', ['ls-tree', '--name-only', base!, path], { cwd: root, encoding: 'utf8' });
    if (!files.trim()) return;
    const previous = JSON.parse(execFileSync('git', ['show', `${base}:${path}`], { cwd: root, encoding: 'utf8' })) as typeof historical;
    const counts = new Map<string, number>();
    for (const entry of previous) counts.set(entry.fingerprint, (counts.get(entry.fingerprint) ?? 0) + 1);
    for (const entry of historical) {
      expect(counts.get(entry.fingerprint) ?? 0).toBeGreaterThan(0);
      counts.set(entry.fingerprint, (counts.get(entry.fingerprint) ?? 0) - 1);
    }
  });
  it('keeps explicit contract modules outside the API startup dependency graph', () => {
    assertStartupContractIsolation(root);
  });
  it('rejects new destructive statements anywhere in non-test server source', () => {
    const allowed = new Map<string, number>();
    for (const entry of historical) allowed.set(entry.fingerprint, (allowed.get(entry.fingerprint) ?? 0) + 1);
    const unexpected = startupSchemaDdl(root).filter(entry => {
      const count = allowed.get(entry.fingerprint) ?? 0;
      if (!count) return true;
      allowed.set(entry.fingerprint, count - 1);
      return false;
    });
    expect(unexpected.map(entry => `${entry.file}:${entry.line}: ${entry.sql}`)).toEqual([]);
  });
  it('finds DDL in new and unimported jobs and binds template expressions', () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'mul173-arch-'));
    try {
      const store = resolve(fixture, 'packages/server/src/store');
      mkdirSync(store, { recursive: true });
      writeFileSync(resolve(fixture, 'tsconfig.json'), JSON.stringify({ compilerOptions: { moduleResolution: 'bundler', module: 'esnext' } }));
      writeFileSync(resolve(store, 'migrations.ts'), "import './helper.js';\nimport type { T } from './types.js';");
      writeFileSync(resolve(store, 'types.ts'), "export type T = 'type_only';");
      const helper = resolve(store, 'helper.ts');
      writeFileSync(helper, 'export const sql = `ALTER TABLE ${first} RENAME TO retired`;');
      const first = startupSchemaDdl(fixture);
      expect(first).toHaveLength(1);
      expect(first[0]!.file).toEndWith('helper.ts');
      writeFileSync(helper, 'export const sql = `ALTER TABLE ${second} RENAME TO retired`;');
      expect(startupSchemaDdl(fixture)[0]!.fingerprint).not.toBe(first[0]!.fingerprint);
      writeFileSync(helper, "export const sql = 'ALTER TABLE t ADD COLUMN added TEXT';");
      expect(startupSchemaDdl(fixture)).toEqual([]);
      writeFileSync(resolve(store, 'new-background-job.ts'), 'export const run = db => db.exec("ALTER TABLE t RENAME c TO d");');
      expect(startupSchemaDdl(fixture).map(entry => entry.file)).toEqual(['packages/server/src/store/new-background-job.ts']);
      for (const sql of ['dRoP tAbLe [retained]', 'aLtEr TaBlE [retained] ReNaMe To [replacement]',
        'TRUNCATE TABLE U&"retained"',
        `DROP TABLE U&"ret!0061ined" UESCAPE '!'`,
        String.raw`ALTER TABLE U&"ret\0061ined" ALTER U&"c" TYPE bigint`, 'DROP TABLE `retained`', 'ALTER TABLE "retained" RENAME TO "replacement"']) {
        writeFileSync(resolve(store, 'new-background-job.ts'), `export const sql = ${JSON.stringify(sql)};`);
        expect(startupSchemaDdl(fixture).map(entry => entry.sql)).toEqual([sql]);
      }
      const shared = resolve(fixture, 'packages/shared/src');
      mkdirSync(shared, { recursive: true });
      writeFileSync(resolve(fixture, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
        moduleResolution: 'bundler', module: 'esnext', paths: { '@fixture/*': ['./packages/shared/src/*'] },
      } }));
      writeFileSync(resolve(store, 'indirect.ts'), "export { run } from '@fixture/barrel.js';");
      writeFileSync(resolve(shared, 'barrel.ts'), "export async function run() { return import('./helper.js'); }");
      writeFileSync(resolve(shared, 'helper.ts'), 'export const sql = "ALTER TABLE t DROP c";');
      expect(startupSchemaDdl(fixture).map(e => e.file)).toContain('packages/shared/src/helper.ts');
      writeFileSync(resolve(shared, 'helper.ts'), "import type { T } from './missing.js'; export const sql = 'SELECT 1';");
      expect(startupSchemaDdl(fixture)).toHaveLength(1);
      writeFileSync(resolve(shared, 'helper.ts'), "export { value } from './missing.js';");
      expect(() => startupSchemaDdl(fixture)).toThrow('Unresolved runtime dependency');
      writeFileSync(resolve(shared, 'helper.ts'), "export const sql = 'SELECT 1';");
      const api = resolve(fixture, 'packages/server/src/api');
      mkdirSync(api, { recursive: true });
      writeFileSync(resolve(api, 'server.ts'), "import '../store/indirect.js';");
      writeFileSync(resolve(shared, 'helper.ts'), "import '../../server/src/store/schema-contracts.js';");
      writeFileSync(resolve(store, 'schema-contracts.ts'), 'export const marker = true;');
      expect(() => assertStartupContractIsolation(fixture)).toThrow('Explicit contract module reachable');
      writeFileSync(resolve(shared, 'helper.ts'), "export const sql = 'SELECT 1';");
      expect(() => assertStartupContractIsolation(fixture)).not.toThrow();
      writeFileSync(resolve(store, 'schema-contracts.ts'), 'export const run = db => db.exec("DROP TABLE retired");');
      writeFileSync(resolve(store, 'ignored.test.ts'), 'const sql = "DROP TABLE test_table";');
      expect(startupSchemaDdl(fixture)).toHaveLength(1);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });
  it('recognizes destructive DDL, including multiline and quoted columns', () => {
    for (const sql of [
      'DROP TABLE old_rows', 'ALTER TABLE t DROP COLUMN c', 'ALTER TABLE t RENAME TO old_t',
      'ALTER TABLE t RENAME COLUMN c TO old_c', 'ALTER TABLE t ALTER COLUMN "c" TYPE bigint',
      'ALTER TABLE t ALTER COLUMN c SET\nNOT NULL', 'ALTER TABLE t ALTER COLUMN c SET DATA TYPE bigint', 'TRUNCATE t',
    ]) expect(hasDestructiveSchemaSql(sql)).toBe(true);
    expect(hasDestructiveSchemaSql('ALTER TABLE t ADD COLUMN c TEXT NOT NULL DEFAULT \'\'' )).toBe(false);
    expect(hasDestructiveSchemaSql('-- DROP TABLE t\nCREATE TABLE t (id INTEGER)')).toBe(false);
  });
});
