import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startupSchemaDdl } from '../../scripts/startup-schema-ddl.js';
import { hasDestructiveSchemaSql } from '../../packages/server/src/store/schema-ddl.js';
import historical from './startup-schema-ddl-allowlist.json';

const root = resolve(import.meta.dir, '../..');
describe('startup migration expand discipline', () => {
  it('never grows the historical allowlist relative to the CI base', () => {
    const base = process.env.SCHEMA_DDL_BASE_REF;
    if (!base || /^0+$/.test(base)) return;
    if (!/^[a-f0-9]{40}$/.test(base)) throw new Error('SCHEMA_DDL_BASE_REF must be a commit SHA');
    const path = 'tests/arch/startup-schema-ddl-allowlist.json';
    // The initial protocol PR introduces this file. Every subsequent change
    // must be a multiset subset of the target branch's manifest.
    const files = execFileSync('git', ['ls-tree', '--name-only', base, path], { cwd: root, encoding: 'utf8' });
    if (!files.trim()) return;
    const previous = JSON.parse(execFileSync('git', ['show', `${base}:${path}`], { cwd: root, encoding: 'utf8' })) as typeof historical;
    const counts = new Map<string, number>();
    for (const entry of previous) counts.set(entry.fingerprint, (counts.get(entry.fingerprint) ?? 0) + 1);
    for (const entry of historical) {
      expect(counts.get(entry.fingerprint) ?? 0).toBeGreaterThan(0);
      counts.set(entry.fingerprint, (counts.get(entry.fingerprint) ?? 0) - 1);
    }
  });
  it('rejects new destructive statements anywhere in the startup import chain', () => {
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
  it('finds newly injected DDL in imported helpers and binds template expressions', () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'mul173-arch-'));
    try {
      const store = resolve(fixture, 'packages/server/src/store');
      mkdirSync(store, { recursive: true });
      writeFileSync(resolve(fixture, 'tsconfig.json'), JSON.stringify({ compilerOptions: { moduleResolution: 'bundler', module: 'esnext' } }));
      writeFileSync(resolve(store, 'migrations.ts'), "import './helper.js';\nimport type { T } from './types.js';");
      writeFileSync(resolve(store, 'types.ts'), "export type T = 'DROP TABLE type_only';");
      const helper = resolve(store, 'helper.ts');
      writeFileSync(helper, 'export const sql = `ALTER TABLE ${first} RENAME TO retired`;');
      const first = startupSchemaDdl(fixture);
      expect(first).toHaveLength(1);
      expect(first[0]!.file).toEndWith('helper.ts');
      writeFileSync(helper, 'export const sql = `ALTER TABLE ${second} RENAME TO retired`;');
      expect(startupSchemaDdl(fixture)[0]!.fingerprint).not.toBe(first[0]!.fingerprint);
      writeFileSync(helper, "export const sql = 'ALTER TABLE t ADD COLUMN added TEXT';");
      expect(startupSchemaDdl(fixture)).toEqual([]);
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
