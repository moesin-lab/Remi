import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertPort, fingerprint, isolatedEnv, SESSION_ENV, compareSnapshots, processIdentity } from '../../integration/upgrade-harness/isolation.js';

describe('upgrade harness safety', () => {
  it('rejects production ports, invalid ports and ambient credentials', () => {
    for (const port of [0, -1, 65536, 6131, 6132, 6133, 6134, 1.1]) expect(() => assertPort(port)).toThrow();
    expect(() => assertPort(19131)).not.toThrow();
    const env = isolatedEnv('/tmp/owned-upgrade-test');
    for (const key of [...SESSION_ENV, 'MULTIREMI_TOKEN', 'OPENAI_API_KEY', 'SSH_AUTH_SOCK', 'DOCKER_HOST']) expect(env[key]).toBeUndefined();
    expect(env.MULTIREMI_TEST_RUN_ROOT).toBe('/tmp/owned-upgrade-test/locks');
    expect(env.HOME).toBe('/tmp/owned-upgrade-test/home');
  });
  it('detects protected static configuration changes without exposing contents', () => {
    const root = mkdtempSync(join(tmpdir(), 'remi-fingerprint-'));
    try {
      const path = join(root, 'config.json'); writeFileSync(path, 'secret-before'); const before = fingerprint(path);
      writeFileSync(path, 'secret-after'); const after = fingerprint(path);
      expect(after.sha256).not.toBe(before.sha256);
      expect(JSON.stringify(after)).not.toContain('secret-after');
      const base = { observation_errors: [], static_configuration: [before] } as any;
      expect(compareSnapshots(base, { ...base, static_configuration: [after] }).unchanged).toBe(false);
      expect(compareSnapshots(base, base)).toMatchObject({ unchanged: true, fully_observed: true });
      expect(compareSnapshots({ ...base, observation_errors: ['denied'] }, { ...base, observation_errors: ['denied'] }).fully_observed).toBe(false);
    } finally { rmSync(root, { recursive: true }); }
  });
  it.skipIf(process.platform !== 'linux')('records kernel process starttime to detect PID reuse', () => {
    expect(processIdentity(process.pid)).toMatchObject({ pid: process.pid, ppid: process.ppid });
    expect(processIdentity(process.pid).starttime).toMatch(/^\d+$/);
  });
});
