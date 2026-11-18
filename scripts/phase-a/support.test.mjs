import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { requireRuntimeUid, requireDirectoryUid, prepareEvidence, scenarioPlan, validateConfig, validateControlDirectory, edgeStatus, edgeDelta, writeDesired, scenarioPass, ProbeSchedule } from './support.mjs';

const config = () => ({ baseUrl: 'http://127.0.0.1:26120', profile: 'remi-a5-test',
  sessions: Array.from({ length: 8 }, (_, i) => ({ id: `session${i}`, agentId: `agent${i}` })),
  probeSessionId: 'probe', releases: { v1: 'v1', v2: 'v2', neverReady: 'bad-ready', activateCrash: 'bad-activate', crash30: 'bad30' },
  controlDir: '/tmp/candidate', chromeExecutable: '/usr/bin/chromium', candidateSha: 'a'.repeat(40), supervisorSha: 'b'.repeat(40) });
test('requires loopback edge, isolated profile, eight distinct lanes and separate write probe', () => {
  validateConfig(config());
  for (const patch of [{ baseUrl: 'https://production.example' }, { baseUrl: 'http://127.0.0.1:16120' }, { profile: 'stable' }, { seconds: 59 }, { seconds: 121 },
    { candidateSha: 'main' }, { releases: { ...config().releases, v2: 'v1' } }, { probeSessionId: 'session0' },
    { sessions: config().sessions.slice(1) }, { sessions: [...config().sessions.slice(1), config().sessions[1]] }]) {
    assert.throws(() => validateConfig({ ...config(), ...patch }));
  }
  const plan = scenarioPlan(config().releases);
  assert.equal(plan.length, 10);
  assert.deepEqual(plan.slice(1, 7).map(p => p[1]), ['v1', 'v2', 'v1', 'v2', 'v1', 'v2']);
  assert.deepEqual(plan.slice(7).map(p => p[2]), [true, true, true]);
});
test('Unix control reads fragmented status and desired is atomically published', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mul172-control-'));
  const server = createServer(socket => socket.once('data', bytes => {
    assert.deepEqual(JSON.parse(String(bytes)), { op: 'status' });
    socket.write('{"ok":true,'); setImmediate(() => socket.end('"result":{"held":false}}\n'));
  }));
  try {
    await new Promise(resolve => server.listen(join(dir, 'edge.sock'), resolve));
    assert.deepEqual(await edgeStatus(dir), { held: false });
    await writeDesired(dir, 'v2', 'unique');
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'desired.json'), 'utf8')), { revision: 'unique', mode: 'run', releaseId: 'v2', strategy: 'switch' });
    assert.equal(await validateControlDirectory(dir), dir);
    const stable = join(dir, 'stable'); await symlink(dir, stable);
    // Canonical paths, rather than the spelling of a symlink, determine scope.
    assert.equal(await validateControlDirectory(stable), dir);
  } finally { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); }
});
test('stable canonical directory and symlink aliases are rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mul172-control-'));
  const { mkdir } = await import('node:fs/promises');
  try {
    await mkdir(join(dir, 'stable')); await symlink(join(dir, 'stable'), join(dir, 'alias'));
    await assert.rejects(validateControlDirectory(join(dir, 'alias')), /Stable/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
const counters = (requests, errors = 0) => ({ metrics: { requests, upstreamErrors: 0, holds: 0, holdMs: 0, errors: { 502: errors, 503: 0, 504: 0 } } });
test('edge deltas retain errors and reject counter reset or missing evidence', () => {
  assert.equal(edgeDelta(counters(10), counters(20, 1)).errors[502], 1);
  assert.throws(() => edgeDelta(counters(20), counters(1)), /reset/);
  assert.throws(() => edgeDelta(counters(0), { metrics: { ...counters(1).metrics, holdMs: undefined } }), /missing/);
});
const passing = () => ({ name: 'v1-v2', rollback: false, previous: 'v1', target: 'v2', switchAt: 2000, switchRequestedAt: 1500,
  edge: edgeDelta(counters(0), counters(30)), sampling: { capacityExceeded: false, missedTicks: 0, lateTicks: 0, tickCount: 100, expectedTicks: 100 },
  client: Array.from({ length: 3 }, () => ({ total: 10, failures: 0 })),
  rounds: Array.from({ length: 8 }, () => ({ turn: { status: 'completed', started_at: new Date(1000).toISOString(), ended_at: new Date(90000).toISOString(), ended_reason: null }, attempts: [{ status: 'completed' }] })),
  browser: { acks: 1, wsFrames: 10, complete: true, errors: [] },
  ready: { state: 'active', term: '2' }, initialReady: { term: '1' },
  observed: { releaseId: 'v2', transition: { phase: 'succeeded', phases: [] } },
});
test('acceptance rejects HTTP errors, retries, lost/recovery, missing browser data and non-overlapping rounds', () => {
  assert.equal(scenarioPass(passing()), true);
  const mutations = [
    s => s.edge.errors[503]++, s => s.edge.upstreamErrors++, s => s.client[1].failures++,
    s => s.rounds[0].attempts.push({ status: 'completed' }), s => s.rounds[0].attempts[0].status = 'lost',
    s => s.rounds[0].turn.ended_reason = 'runtime_recovery', s => s.rounds[0].attempts[0].error = 'daemon_timeout',
    s => s.rounds[0].turn.started_at = new Date(3000).toISOString(), s => s.browser.complete = false,
    s => s.browser.acks = 0, s => s.browser.wsFrames = 0, s => s.observed.releaseId = 'wrong',
    s => s.sampling.capacityExceeded = true, s => s.sampling.missedTicks = 1, s => s.ready.term = '1',
    s => s.rounds[0].turn.ended_at = new Date(5000).toISOString(),
  ];
  for (const mutate of mutations) { const scenario = passing(); mutate(scenario); assert.equal(scenarioPass(scenario), false); }
});
test('bad release needs rollback AND actual fault evidence, including a full 30 seconds live', () => {
  const s = passing(); s.name = 'crash-after-30s'; s.rollback = true;
  s.observed = { releaseId: 'v1', transition: { phase: 'failed', updatedAt: 34000, phases: [{ phase: 'rolling_back' }] } };
  assert.equal(scenarioPass(s), false);
  s.fault = { releaseId: 'v2', event: 'public_live_exit', armedAt: 3000, at: 32999 };
  assert.equal(scenarioPass(s), false);
  s.fault.at++;
  assert.equal(scenarioPass(s), true);
  s.observed.transition.updatedAt = 91000;
  assert.equal(scenarioPass(s), false);
  s.observed.transition.updatedAt = 34000;
  s.observed.transition.phases = [];
  assert.equal(scenarioPass(s), false);
});

test('30s fault and rollback must both overlap all eight running rounds', () => {
  const s = passing(); s.name = 'crash-after-30s'; s.rollback = true; s.switchAt = 50000;
  s.rounds.forEach(r => { r.turn.ended_at = new Date(62000).toISOString(); });
  s.observed = { releaseId: 'v1', transition: { phase: 'failed', updatedAt: 81000, phases: [{ phase: 'rolling_back' }] } };
  s.fault = { releaseId: 'v2', event: 'public_live_exit', armedAt: 50010, at: 80010 };
  assert.equal(scenarioPass(s), false);
});
test('sustained 190ms sampling cannot pass as a complete 100ms schedule', () => {
  const s = passing();
  s.sampling = { capacityExceeded: false, tickCount: 100, expectedTicks: 190, missedTicks: 0 };
  assert.equal(scenarioPass(s), false);
});

test('absolute probe deadlines accept small jitter and reject cumulative drift or missing tail', () => {
  const normal = new ProbeSchedule(0);
  for (let i = 0; i < 100; i++) normal.record(i * 100 + 10);
  assert.equal(normal.snapshot(9999).missedTicks, 0);
  assert.equal(normal.snapshot(9999).lateTicks, 0);
  assert.equal(normal.snapshot(10200).missedTicks, 2);
  const slow = new ProbeSchedule(0);
  for (let i = 0; i < 100; i++) slow.record(i * 190);
  const result = slow.snapshot(19000);
  assert.ok(result.expectedTicks >= 190);
  assert.ok(result.missedTicks >= 90);
  assert.ok(result.lateTicks > 0);
});

test('runtime identity rejects mismatches and private evidence/control require matching ownership', async () => {
  assert.equal(requireRuntimeUid('1000', 1000), 1000);
  assert.equal(requireRuntimeUid('2000', 2000), 2000);
  assert.throws(() => requireRuntimeUid('1000', 2000), /entire init\/driver\/collect workflow/);
  for (const value of ['NaN', '-1', '1.5', '', '4294967295']) assert.throws(() => requireRuntimeUid(value, 1000), /POSIX UID/);
  const dir = await mkdtemp(join(tmpdir(), 'mul172-uid-'));
  try {
    const uid = process.getuid();
    await requireDirectoryUid(dir, uid);
    await assert.rejects(requireDirectoryUid(dir, uid + 1), /must belong to runtime UID/);
    await assert.rejects(prepareEvidence(join(dir, 'rejected'), uid + 1), /must belong to runtime UID/);
    await prepareEvidence(join(dir, 'evidence'), uid);
    await requireDirectoryUid(join(dir, 'evidence'), uid);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
