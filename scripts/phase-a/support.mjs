import { connect } from 'node:net';
import { readFile, rename, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const scenarioPlan = r => [
  ['v1-v2', r.v2, false],
  ...Array.from({ length: 6 }, (_, i) => [`alternation-${i + 1}`, i % 2 ? r.v2 : r.v1, false]),
  ['never-ready', r.neverReady, true], ['activate-crash', r.activateCrash, true], ['crash-after-30s', r.crash30, true],
];
export function validateConfig(c) {
  const url = new URL(c.baseUrl);
  if (url.origin !== 'http://127.0.0.1:16120' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('Use isolated loopback edge http://127.0.0.1:16120');
  if (!/^mul172-candidate-[a-z0-9-]+$/.test(c.profile)) throw new Error('An explicit mul172-candidate-* profile is required');
  if (!Array.isArray(c.sessions) || c.sessions.length < 8 || c.sessions.some(s => !s.id || !s.agentId)
    || new Set(c.sessions.map(s => s.id)).size !== c.sessions.length
    || new Set(c.sessions.map(s => s.agentId)).size !== c.sessions.length) throw new Error('At least eight separate Sessions and Agents required');
  if (!c.probeSessionId || c.sessions.some(s => s.id === c.probeSessionId)) throw new Error('Separate non-waking probe Session required');
  for (const key of ['v1', 'v2', 'neverReady', 'activateCrash', 'crash30']) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(c.releases?.[key] ?? '')) throw new Error(`Invalid release ${key}`);
  }
  if (new Set(Object.values(c.releases)).size !== 5) throw new Error('Five distinct releases required');
  if (!c.controlDir || !c.chromeExecutable || !/^[a-f0-9]{40}$/.test(c.candidateSha ?? '')
    || !/^[a-f0-9]{40}$/.test(c.supervisorSha ?? '')) throw new Error('Control mount, Chromium and full candidate/supervisor SHAs required');
  if (!Number.isInteger(c.seconds ?? 90) || (c.seconds ?? 90) < 60 || (c.seconds ?? 90) > 120) throw new Error('Streaming duration must be 60–120 seconds');
}
export async function validateControlDirectory(path) {
  const canonical = await realpath(path);
  if (/(^|[\/\\])stable([\/\\]|$)/i.test(canonical)) throw new Error('Stable control directory is prohibited');
  return canonical;
}
export const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
export async function writeDesired(directory, releaseId, revision) {
  const temp = join(directory, `.mul172-${randomUUID()}.tmp`);
  await writeFile(temp, JSON.stringify({ revision, mode: 'run', releaseId, strategy: 'switch' }), { mode: 0o600 });
  await rename(temp, join(directory, 'desired.json'));
}
export function edgeStatus(directory) {
  return new Promise((resolve, reject) => {
    const socket = connect(join(directory, 'edge.sock'));
    let buffer = '';
    const finish = (error, value) => { socket.destroy(); error ? reject(error) : resolve(value); };
    socket.setTimeout(5000, () => finish(new Error('edge control timeout')));
    socket.once('error', reject);
    socket.once('connect', () => socket.write('{"op":"status"}\n'));
    socket.on('data', data => {
      buffer += data;
      if (buffer.length > 1024 * 1024) return finish(new Error('edge status too large'));
      if (!buffer.includes('\n')) return;
      try { const result = JSON.parse(buffer.split('\n')[0]); if (!result.ok) throw new Error('edge status rejected'); finish(null, result.result); }
      catch (error) { finish(error); }
    });
    socket.once('end', () => { if (!buffer.includes('\n')) finish(new Error('edge status truncated')); });
  });
}
export function edgeDelta(before, after) {
  const result = {};
  for (const key of ['requests', 'upstreamErrors', 'holds', 'holdMs']) result[key] = after.metrics[key] - before.metrics[key];
  result.errors = Object.fromEntries(['502', '503', '504'].map(code => [code, after.metrics.errors[code] - before.metrics.errors[code]]));
  if ([...Object.values(result.errors), ...['requests', 'upstreamErrors', 'holds', 'holdMs'].map(k => result[k])].some(n => !Number.isFinite(n) || n < 0)) throw new Error('Edge counters missing/reset: evidence is invalid');
  return result;
}
export function roundPass(r, switchAt) {
  return r.turn?.status === 'completed' && r.attempts?.length === 1 && r.attempts[0].status === 'completed'
    && !/runtime_recovery|lost|daemon_timeout|input_gap|platform_input_rejected/.test(JSON.stringify(r))
    && Date.parse(r.turn.ended_at) - Date.parse(r.turn.started_at) >= 60000
    && Date.parse(r.turn.started_at) <= switchAt && Date.parse(r.turn.ended_at) > switchAt;
}
export function faultPass(s) {
  if (!s.rollback) return true;
  const f = s.fault;
  if (!f || f.releaseId !== s.target || !Number.isSafeInteger(f.at) || f.at < s.switchRequestedAt) return false;
  return s.name === 'never-ready' ? f.event === 'active_ready_denied'
    : s.name === 'activate-crash' ? f.event === 'activate_exit'
    : f.event === 'public_live_exit' && Number.isSafeInteger(f.armedAt) && f.armedAt >= s.switchRequestedAt && f.at - f.armedAt >= 30000;
}
export function scenarioPass(s) {
  return faultPass(s) && s.edge.requests > 0 && s.edge.upstreamErrors === 0 && Object.values(s.edge.errors).every(n => n === 0)
    && !s.sampling.capacityExceeded && s.sampling.missedTicks === 0 && s.client.length === 3 && s.client.every(p => p.total > 0 && p.failures === 0) && s.rounds.length >= 8 && s.rounds.every(r => roundPass(r, s.switchAt))
    && s.browser.acks > 0 && s.browser.wsFrames > 0 && s.browser.complete && s.browser.errors.length === 0
    && s.ready?.state === 'active' && /^[1-9]\d*$/.test(String(s.ready.term))
    && /^[1-9]\d*$/.test(String(s.initialReady?.term)) && BigInt(s.ready.term) >= BigInt(s.initialReady.term)
    && (s.rollback || BigInt(s.ready.term) > BigInt(s.initialReady.term))
    && s.observed.releaseId === (s.rollback ? s.previous : s.target)
    && s.observed.transition.phase === (s.rollback ? 'failed' : 'succeeded')
    && (!s.rollback || s.observed.transition.phases.some(p => p.phase === 'rolling_back'));
}
