#!/usr/bin/env node
// Operates a PREPARED isolated candidate; never creates or addresses stable.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { scenarioPlan, validateConfig, validateControlDirectory, readJson, writeDesired, edgeStatus, edgeDelta, scenarioPass } from './phase-a/support.mjs';
import { openTraceBrowser } from './phase-a/browser.mjs';

export async function run(config, output) {
  validateConfig(config);
  const control = await validateControlDirectory(config.controlDir);
  const token = process.env.MUL172_TOKEN;
  if (!token) throw new Error('MUL172_TOKEN must be a candidate human credential');
  await mkdir(output, { recursive: true, mode: 0o700 });
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' }).trim();
  const report = { issue: 'MUL-172', scriptSha: revision, scope: 'supervisor-direct; excludes updater verification/backup/current.json/Web',
    phaseAAccepted: false, supervisorScenariosPassed: false, profile: config.profile,
    declaredCandidateSha: config.candidateSha, declaredSupervisorSha: config.supervisorSha,
    baseline: { sourceComment: 'cmt_nyrok52lrwo3', deployedSha: 'ca654768f',
      failures: ['tsk_g9xb5353762j: daemon_timeout', 'tsk_elwh9tq1t7t5: input_gap/platform_input_rejected'] },
    startedAt: new Date().toISOString(), scenarios: [], errors: [] };
  const save = () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const request = async (path, body) => {
    const response = await fetch(config.baseUrl + path, { method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(360000) });
    if (response.status !== 200) { await response.body?.cancel(); throw new Error('HTTP ' + response.status); }
    return response.json();
  };
  const status = async () => {
    const s = await readJson(join(control, 'status.json'));
    if (Date.now() - s.heartbeatAt > 5000 || !s.slotSwitch) throw new Error('Candidate supervisor heartbeat/slotSwitch invalid');
    return s;
  };
  const poll = async (action, predicate, timeout = 240000) => {
    const deadline = Date.now() + timeout;
    do { const result = await action(); if (predicate(result)) return result; await sleep(100); } while (Date.now() < deadline);
    throw new Error('Timed out awaiting candidate evidence');
  };
  let signalReceived = false;
  const interrupt = () => { signalReceived = true; };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    if ((await status()).releaseId !== config.releases.v1 || !(await status()).childPid) throw new Error('Candidate must start on v1');
    for (const [name, target, rollback] of scenarioPlan(config.releases)) {
      if (signalReceived) throw new Error('Interrupted');
      const previous = (await status()).releaseId;
      const scenario = { name, target, previous, rollback, client: ['readyz', 'read', 'write'].map(name => ({ name, total: 0, failures: 0, maxLatencyMs: 0 })),
        rounds: [], browser: null, observed: null, edge: null, holdSamples: [], passed: false };
      report.scenarios.push(scenario); await save();
      scenario.initialReady = await request('/readyz');
      const before = await edgeStatus(control);
      const pending = new Set();
      let tickCount = 0, missedTicks = 0, maxTickGapMs = 0, lastTick = performance.now(), tickError = false;
      const tick = () => {
        const now = performance.now(); missedTicks += Math.max(0, Math.floor((now - lastTick) / 100) - 1); maxTickGapMs = Math.max(maxTickGapMs, now - lastTick); lastTick = now; tickCount++;
        const paths = ['/readyz', `/api/sessions/${encodeURIComponent(config.probeSessionId)}/messages?limit=1`,
          `/api/sessions/${encodeURIComponent(config.probeSessionId)}/messages`];
        for (let i = 0; i < 3; i++) {
          const counter = scenario.client[i]; counter.total++;
          if (pending.size >= 12000) { counter.failures++; tickError = true; continue; }
          const started = performance.now();
          const work = request(paths[i], i === 2 ? { body_md: `MUL-172 probe ${randomUUID()}`, to: { type: 'none' },
            wake_requested: 'inbox_only', message_kind: 'request' } : undefined)
            .catch(() => { counter.failures++; }).finally(() => { counter.maxLatencyMs = Math.max(counter.maxLatencyMs, performance.now() - started); pending.delete(work); });
          pending.add(work);
        }
      };
      const timer = setInterval(tick, 100); tick();
      let browser;
      try {
        const turns = await Promise.all(config.sessions.map(async s => {
          const sent = await request(`/api/sessions/${encodeURIComponent(s.id)}/messages`, {
            body_md: `MUL-172/STREAM/${config.seconds ?? 90} MUL-493/PROBE/mul172-${randomUUID()}`, to: { type: 'agent', ref: s.agentId },
            wake_requested: 'now', message_kind: 'request', dedupe_key: `mul172-${randomUUID()}` });
          if (!sent.turn_id) throw new Error('Workload did not create a Turn');
          return sent.turn_id;
        }));
        if (new Set(turns).size !== turns.length) throw new Error('Workload returned duplicate Turns');
        const getRounds = () => Promise.all(turns.map(async id => {
          const r = await request(`/api/turns/${encodeURIComponent(id)}?attempts=true`);
          return {
            turn: Object.fromEntries(['id', 'status', 'started_at', 'ended_at', 'ended_reason'].map(k => [k, r.turn[k]])),
            attempts: r.attempts.map(a => ({ ...Object.fromEntries(['id', 'status', 'started_at', 'ended_at', 'failure_reason'].map(k => [k, a[k]])),
              error: a.error ? String(a.error).match(/runtime_recovery|lost|daemon_timeout|input_gap|platform_input_rejected/)?.[0] ?? 'present' : null })),
          };
        }));
        const running = await poll(getRounds, rows => rows.every(r => r.turn.status === 'running' && r.attempts.length === 1 && r.attempts[0].status === 'running'), 60000);
        browser = await openTraceBrowser(config, token, running[0].attempts[0].id, turns[0]);
        // Recheck immediately before issuing the switch, after browser startup.
        if (!(await getRounds()).every(r => r.turn.status === 'running')) throw new Error('Workload ended before switch');
        const desiredRevision = `mul172-${randomUUID()}`;
        scenario.revision = desiredRevision; scenario.switchRequestedAt = Date.now();
        await writeDesired(control, target, desiredRevision);
        let heldSince = null;
        scenario.observed = await poll(async () => {
          if (signalReceived) throw new Error('Interrupted');
          const [s, e] = await Promise.all([status(), edgeStatus(control)]);
          if (e.held && heldSince === null) heldSince = Date.now();
          if (!e.held && heldSince !== null) { scenario.holdSamples.push({ start: heldSince, end: Date.now(), durationMs: Date.now() - heldSince }); heldSince = null; }
          return s;
        }, s => s.transition?.revision === desiredRevision && ['succeeded', 'failed'].includes(s.transition.phase), 900000);
        // Use the actual promotion phase, not the later confirmation terminal time.
        const phases = scenario.observed.transition.phases;
        scenario.switchAt = phases.find(p => p.phase === (name === 'never-ready' || name === 'activate-crash' ? 'activating' : 'confirming'))?.updatedAt
          ?? phases.find(p => p.phase === 'standby')?.updatedAt;
        scenario.rounds = await poll(getRounds, rows => rows.every(r => ['completed', 'failed', 'cancelled'].includes(r.turn.status)), 180000);
        scenario.browser = await browser.finish();
        if (rollback) scenario.fault = await readJson(join(control, `mul172-fault-${target}.json`));
        const ready = await request('/readyz');
        if (!scenario.observed.childPid || ready.version !== scenario.observed.version) throw new Error('Candidate final readiness mismatch');
        scenario.ready = { slot: ready.slot, state: ready.state, version: ready.version, term: ready.term };
      } finally {
        clearInterval(timer);
        await Promise.allSettled([...pending]);
        await browser?.close();
        scenario.edge = edgeDelta(before, await edgeStatus(control));
        scenario.sampling = { intervalMs: 100, tickCount, missedTicks, maxTickGapMs, capacityExceeded: tickError };
        // Hold observations are sampled to ~100 ms; A1 holdMs is request wait sum.
        scenario.holdMeasurement = 'sampled wall time; edge.holdMs is cumulative per-request waiting time';
        await save();
      }
      scenario.passed = scenarioPass(scenario);
      await save();
      if (!scenario.passed) throw new Error('Scenario acceptance failed: ' + name);
    }
    report.supervisorScenariosPassed = report.scenarios.length === 10 && report.scenarios.every(s => s.passed);
  } catch (error) {
    // Never copy response bodies, credentials, provider inputs or arbitrary logs.
    report.errors.push(error instanceof Error && /^(HTTP \d+|Scenario acceptance failed: [a-z0-9-]+|Interrupted|Candidate must start on v1|Candidate supervisor heartbeat\/slotSwitch invalid|Workload ended before switch|Workload did not create a Turn|Timed out awaiting candidate evidence)$/.test(error.message) ? error.message : 'Driver failed; inspect candidate locally');
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    report.finishedAt = new Date().toISOString(); await save();
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) { console.error('Usage: node scripts/phase-a-acceptance.mjs candidate.json output-directory'); process.exitCode = 2; }
  else {
    try {
      const report = await run(await readJson(process.argv[2]), resolve(process.argv[3]));
      console.log(`Supervisor scenarios: ${report.supervisorScenariosPassed ? 'PASS' : 'NOT PASSED'}; Phase A full acceptance: NOT ESTABLISHED. Report saved.`);
      process.exitCode = report.supervisorScenariosPassed ? 0 : 1;
    } catch { console.error('Candidate preflight failed; check configuration and local prerequisites.'); process.exitCode = 1; }
  }
}
