import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { assertDeploymentSchema, readDeploymentSchema } from '../../../packages/platform-updater/src/schema-preflight.mjs';

const target = { format: 1, expandLevel: 3, contractLevel: 0, minLevel: 3, maxLevel: 3 };
async function read(inventory: unknown, rows?: unknown) {
  const responses = [JSON.stringify(inventory), JSON.stringify(rows)];
  return readDeploymentSchema(() => responses.shift()!);
}
test('empty databases bootstrap; historical databases require explicit enrollment', async () => {
  assertDeploymentSchema(target, await read({ historical: false, metadata: false }));
  const current = await read({ historical: true, metadata: false });
  assert.throws(() => assertDeploymentSchema(target, current), /remi db prepare/);
  assertDeploymentSchema(null, current);
});
test('lower expand may migrate and higher expand remains compatible', async () => {
  for (const expand_level of [1, 3, 5]) {
    const current = await read({ historical: true, metadata: true }, [{ singleton: 1, expand_level, contract_level: 0 }]);
    assertDeploymentSchema(target, current);
  }
  assert.throws(() => assertDeploymentSchema(target, { historical: true, expandLevel: 4, contractLevel: 4 }), /exceeds target maximum/);
});
test('malformed metadata and declarations fail closed', async () => {
  for (const rows of [[], [{ singleton: 2, expand_level: 1, contract_level: 0 }], [{ singleton: 1, expand_level: null, contract_level: 0 }], [{ singleton: 1, expand_level: 1, contract_level: 2 }], [{ singleton: 1, expand_level: 1, contract_level: 0 }, { singleton: 1, expand_level: 1, contract_level: 0 }]]) {
    await assert.rejects(read({ historical: true, metadata: true }, rows), /Invalid schema metadata/);
  }
  await assert.rejects(read({ historical: 'yes', metadata: false }), /Invalid schema inventory/);
  assert.throws(() => assertDeploymentSchema({}, { historical: false, expandLevel: 0, contractLevel: 0 }), /Invalid schema compatibility/);
});
