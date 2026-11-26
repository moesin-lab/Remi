import { readFileSync } from 'node:fs';

export function linuxProcessBirth(pid, requireBootId) {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid Linux process');
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const end = stat.lastIndexOf(')');
  const startTicks = stat.slice(end + 1).trim().split(/\s+/)[19];
  if (end < 0 || !/^\d+$/.test(startTicks ?? '')) throw new Error('Invalid process start ticks');
  let bootId;
  try { bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); }
  catch (error) { if (requireBootId) throw error; }
  if (requireBootId && !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(bootId ?? '')) throw new Error('Invalid boot ID');
  return {bootId:bootId || 'unknown-boot', startTicks};
}
