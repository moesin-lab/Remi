import { expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

it('keeps fake upgrade entries out of the production source graph', async () => {
  const root = join(import.meta.dir, '../..');
  for (const directory of ['apps', 'packages', 'scripts']) {
    for await (const file of new Bun.Glob('**/*.{ts,tsx,js,mjs,json}').scan({ cwd: join(root, directory), onlyFiles: true })) {
      if (file.includes('node_modules/')) continue;
      expect(readFileSync(join(root, directory, file), 'utf8')).not.toMatch(/fake-steering-agent|upgrade-harness\/(?:daemon|api)-entry/);
    }
  }
  const entry = readFileSync(join(root, 'tests/integration/upgrade-harness/daemon-entry.ts'), 'utf8');
  expect(entry).toContain('providerFactory:');
  expect(entry).toContain("process.env.MULTIREMI_UPGRADE_HARNESS !== '1'");
});
