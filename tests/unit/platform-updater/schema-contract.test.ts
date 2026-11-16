import { describe, expect, it } from 'bun:test';
import { isPlatformSchemaContractFailure, PLATFORM_MANUAL_UPGRADE_URL } from '@multiremi/contracts';
import { assertSchemaContract, SchemaContractRefusedError } from '@remi-platform/updater/schema-contract.js';

describe('schema contract diagnostics', () => {
  it('classifies absent tables, absent columns and changed type/nullability separately', () => {
    const before = ['public.gone.id:integer:int4:NO', 'public.gone.name:text:text:YES', 'public.kept.removed:text:text:YES', 'public.kept.changed:integer:int4:NO'];
    try {
      assertSchemaContract(before, ['public.kept.changed:integer:int4:YES'], { stage: 'previous', currentVersion: '0.2.90', targetVersion: 'candidate' });
      throw new Error('expected refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaContractRefusedError);
      const failure = (error as SchemaContractRefusedError).failure;
      expect(failure).toMatchObject({ reason: 'schema_contract_refused', stage: 'previous', affectedColumnCount: 4,
        removedTables: { total: 1, examples: ['public.gone'] }, removedColumns: { total: 1 }, changedColumns: { total: 1 } });
      expect(isPlatformSchemaContractFailure(failure)).toBe(true);
      expect(String(error)).toContain('0.2.90 -> candidate');
      expect(String(error)).toContain(PLATFORM_MANUAL_UPGRADE_URL);
      expect(failure.changedColumns.examples[0]).toContain(' -> public.kept.changed:integer:int4:YES');
    }
    expect(() => assertSchemaContract(before, [...before, 'public.extra.id:integer:int4:NO'], { stage: 'target', currentVersion: 'old', targetVersion: 'new' })).not.toThrow();
  });
  it('bounds examples deterministically while retaining totals', () => {
    const before = Array.from({ length: 50 }, (_, index) => `public.kept.col${index}:text:text:YES`);
    const check = (signatures: string[]) => {
      try { assertSchemaContract(signatures, ['public.kept.id:integer:int4:NO'], { stage: 'target', currentVersion: 'old', targetVersion: 'new' }); }
      catch (error) { return (error as SchemaContractRefusedError).failure; }
      throw new Error('expected refusal');
    };
    const failure = check(before);
    expect(check(before.reverse())).toEqual(failure);
    expect(failure.removedColumns.total).toBe(50);
    expect(failure.removedColumns.examples).toHaveLength(20);
    for (const invalid of [ { ...failure, reason: 'arbitrary' }, { ...failure, stage: 1 }, { ...failure, currentVersion: 'x'.repeat(129) },
      { ...failure, manualUpgradeUrl: 'https://evil.test' }, { ...failure, removedColumns: { total: -1, examples: [] } },
      { ...failure, extra: 'unexpected' }, { ...failure, removedColumns: { total: 50, examples: Array(21).fill('column') } },
      { ...failure, removedColumns: { total: 1, examples: ['x'.repeat(1025)] } } ]) expect(isPlatformSchemaContractFailure(invalid)).toBe(false);
  });
});
