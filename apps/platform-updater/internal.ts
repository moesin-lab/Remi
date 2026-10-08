import { mkdir } from 'node:fs/promises';
import { InternalApplicationDriver } from '@remi-platform/updater/internal-driver.js';
import { PlatformUpdaterClient } from '@remi-platform/updater/client.js';
import { PlatformUpdateWorker } from '@remi-platform/updater/worker.js';
import { resolveDrainTimeoutMs } from '@remi-platform/updater/drain.js';

const required = (name: string) => { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; };
const state = process.env.REMI_INTERNAL_UPDATE_STATE || '/remi-state';
const control = process.env.REMI_SUPERVISOR_CONTROL || '/remi-control';
const api = required('MULTIREMI_API_URL');
const driver = new InternalApplicationDriver({
  root: process.env.REMI_APPLICATION_ROOT || '/remi-program', control, state,
  seeds: process.env.REMI_SUPERVISOR_SEEDS || '/remi-seeds',
  dataPaths: (process.env.REMI_INTERNAL_BACKUP_PATHS || '/remi-data').split(',').filter(Boolean),
  databaseUrl: required('MULTIREMI_DATABASE_URL'), apiHealthUrl: api + '/readyz',
  webHealthUrl: process.env.MULTIREMI_PLATFORM_WEB_HEALTH_URL || 'http://web:3000/login',
  minimumFreeBytes: Number(process.env.MULTIREMI_PLATFORM_MIN_FREE_BYTES) || undefined,
  verificationTimeoutMs: Number(process.env.MULTIREMI_PLATFORM_VERIFY_TIMEOUT_MS) || undefined,
});
const client = new PlatformUpdaterClient(api, required('MULTIREMI_TOKEN'), required('MULTIREMI_PLATFORM_UPDATER_TOKEN'));
const worker = new PlatformUpdateWorker(client, driver, required('MULTIREMI_PLATFORM_RELEASE_FEED_URL'), resolveDrainTimeoutMs(process.env.MULTIREMI_PLATFORM_DRAIN_TIMEOUT_MS));
await mkdir(state, { recursive: true });
// Only one updater service is supported; flock belongs to this process and is
// released by the kernel even when a container dies. The image entrypoint holds
// that lock before starting Bun, so container-local PID reuse is irrelevant.
console.info('Internal application updater started (no Docker socket)');
await driver.recoverInterrupted();
let heartbeatPending = false;
setInterval(() => {
  if (heartbeatPending) return;
  heartbeatPending = true;
  client.keepAlive(driver.kind).catch(() => { /* API child can be stopped during a switch. */ })
    .finally(() => { heartbeatPending = false; });
}, 30_000);
for (;;) {
  try { await worker.tick(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); }
  await Bun.sleep(1000);
}
