// Temporary diagnostic only. Never merge into the product branch.
import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test.skipIf(!process.env.MULTIREMI_TEST_POSTGRES_URL)('MUL-182 same-runner real PG comparison', () => {
  const root = resolve(import.meta.dir, '../../..');
  const scratch = mkdtempSync(join(tmpdir(), 'mul182-pg-'));
  const evidence = join(root, 'mul182-pg-evidence');
  mkdirSync(evidence, { recursive: true });
  const command = (args: string[], cwd = root) => {
    const result = spawnSync(args[0]!, args.slice(1), { cwd, env: process.env, encoding: 'utf8', timeout: 300_000, maxBuffer: 32 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`${args[0]} failed: ${result.stderr}`);
    return result;
  };
  const variants = { baseline: '25de5367e613e86c0ab297b4c798566707f5f315', candidate: 'da172057fe85be816be9367bd8d768abf37ef7a1' };
  try {
    for (const [name, sha] of Object.entries(variants)) {
      const cwd = join(scratch, name);
      command(['git', 'worktree', 'add', '--detach', cwd, sha]);
      symlinkSync(join(root, 'node_modules'), join(cwd, 'node_modules'));
      command(['python3', join(root, '.github/diagnostics/mul182-profile.py')], cwd);
    }
    for (const [name, round] of [['baseline', 1], ['candidate', 1], ['candidate', 2], ['baseline', 2], ['baseline', 3], ['candidate', 3]] as const) {
      const result = spawnSync(process.execPath, ['run', 'test', 'tests/unit/multiremi/multiremi-issue-decisions.test.ts', 'tests/unit/multiremi/multiremi-postgres-reconnect.test.ts'], {
        cwd: join(scratch, name), env: process.env, encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024,
      });
      const log = `${result.stdout}\n${result.stderr}`;
      writeFileSync(join(evidence, `${name}-${round}.log`), log);
      console.log(`MUL182_COMPARISON variant=${name} round=${round} exit=${result.status}\n${log}`);
      expect(result.error).toBeUndefined();
    }
  } finally {
    for (const name of Object.keys(variants)) spawnSync('git', ['worktree', 'remove', '--force', join(scratch, name)], { cwd: root });
    rmSync(scratch, { recursive: true, force: true });
  }
}, 600_000);
