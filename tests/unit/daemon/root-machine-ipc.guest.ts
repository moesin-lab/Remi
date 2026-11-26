import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('machine IPC authenticates the daemon and isolates execution from private files', async () => {
  const child = Bun.spawn(['python3', join(import.meta.dir, 'root-machine-ipc-guest.py')], {
    stdout: 'inherit', stderr: 'inherit',
  });
  expect(await child.exited).toBe(0);
}, 120_000);
