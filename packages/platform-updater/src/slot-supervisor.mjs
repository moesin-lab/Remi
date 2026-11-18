// Image-owned two-slot controller. All lifecycle requests stay on loopback.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export class SlotSupervisor {
  constructor(edge, launch, options = {}) {
    this.edge = edge; this.launch = launch;
    this.waits = { standbyWait: 120000, releaseWait: 30000, activateWait: 60000, confirmWait: 180000, ...options };
    this.slots = [null, null]; this.live = null; this.revision = null; this.transition = null;
    this.supportsSwitch = false; this.failures = 0; this.healthySince = null; this.closing = false; this.abort = new AbortController();
    edge.hold();
  }
  snapshot() {
    const slot = this.slots[this.live];
    return { childPid: slot?.dead ? null : slot?.child.pid ?? null, releaseId: slot?.id ?? null,
      version: slot?.version, revision: this.revision, stopped: !slot, slotSwitch: this.supportsSwitch, transition: this.transition };
  }
  phase(phase, extra = {}) {
    const updatedAt = Date.now();
    this.transition = { ...this.transition, phase, ...extra, updatedAt,
      phases: [...(this.transition?.phases || []), { phase, updatedAt }] };
  }
  async request(slot, action, timeout) {
    const response = await fetch(slot.url + '/internal/slot/' + action, {
      method: action === 'status' ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + slot.token }, signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(timeout)]),
    });
    if (!response.ok) throw new Error(`${action}: HTTP ${response.status}`);
    return response.json();
  }
  async wait(slot, active, timeout) {
    const deadline = Date.now() + timeout;
    while (!this.closing && Date.now() < deadline) {
      if (slot.dead) throw new Error('Slot exited before readiness');
      try {
        if (active) {
          const response = await fetch(slot.url + '/readyz', { signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(Math.max(1, Math.min(1000, deadline - Date.now())))]) });
          const body = await response.text();
          if (response.status === 200) {
            try { return JSON.parse(body); } catch { return {}; }
          }
        } else if ((await this.request(slot, 'status', Math.max(1, Math.min(1000, deadline - Date.now())))).state === 'standby') return;
      } catch {}
      await sleep(100);
    }
    throw new Error(active ? 'Activation readiness timed out' : 'Standby readiness timed out');
  }
  async start(index, id) {
    const config = await this.launch(id);
    const token = randomUUID(), port = this.waits.ports?.[index] ?? this.waits.port + index + 1;
    const slot = { id, version: config.version, token, url: `http://127.0.0.1:${port}`, dead: false };
    const child = slot.child = spawn(config.executable, config.args, { cwd: config.cwd, detached: true, stdio: 'inherit',
      env: { ...config.env, PATH: dirname(config.executable) + ':' + process.env.PATH,
        MULTIREMI_HOST: '127.0.0.1', MULTIREMI_PORT: String(port), MULTIREMI_SLOT: `slot-${index}`,
        MULTIREMI_SLOT_START: 'standby', MULTIREMI_SLOT_CONTROL_TOKEN: token,
        MULTIREMI_TRUSTED_PROXY_IPS: [config.env.MULTIREMI_TRUSTED_PROXY_IPS, '127.0.0.1', '::1'].filter(Boolean).join(','),
      } });
    slot.exit = new Promise(resolve => {
      const died = () => { slot.dead = true; if (this.slots[this.live] === slot) this.edge.hold(); resolve(); };
      child.once('exit', died); child.once('error', died);
    });
    this.slots[index] = slot;
    const backend = this.edge.status().backends?.find(b => b.id === `slot-${index}`);
    if (backend) this.edge.setState(`slot-${index}`, 'standby');
    else this.edge.addBackend({ id: `slot-${index}`, url: slot.url, state: 'standby' });
    return slot;
  }
  async terminate(index) {
    const slot = this.slots[index];
    if (!slot) return;
    if (!slot.dead && slot.child.pid) {
      try { process.kill(-slot.child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      await Promise.race([slot.exit, sleep(30000, undefined, { ref: false })]);
    }
    await this.kill(index);
  }
  async kill(index) {
    const slot = this.slots[index]; if (!slot) return;
    if (slot.child.pid) { try { process.kill(-slot.child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    await slot.exit;
    this.edge.setState(`slot-${index}`, 'down'); this.slots[index] = null;
  }
  async activate(index, requireTerm = false) {
    const slot = this.slots[index];
    const deadline = Date.now() + this.waits.activateWait;
    await this.request(slot, 'activate', this.waits.activateWait);
    const ready = await this.wait(slot, true, Math.max(1, deadline - Date.now()));
    const hasTerm = (typeof ready.term === 'string' && /^[1-9]\d*$/.test(ready.term))
      || (Number.isSafeInteger(ready.term) && ready.term > 0);
    if (requireTerm && !hasTerm) throw new Error('Candidate lacks live term fencing');
    this.supportsSwitch = hasTerm;
    this.edge.setState(`slot-${index}`, 'live'); this.live = index; this.edge.unhold();
  }
  async change(id, revision) {
    const oldIndex = this.live, old = this.slots[oldIndex], index = oldIndex === 0 ? 1 : 0;
    this.transition = { revision, target: id, previous: old?.id ?? null };
    let held = false;
    if (old && !this.supportsSwitch) {
      this.phase('failed', { error: 'Current release lacks live term fencing; use the offline update path' });
      this.revision = revision; return;
    }
    try {
      this.phase('standby'); const next = await this.start(index, id);
      await this.wait(next, false, this.waits.standbyWait);
      this.phase('releasing'); this.edge.hold(); held = true;
      if (old) { this.edge.setState(`slot-${oldIndex}`, 'draining'); await this.request(old, 'release', this.waits.releaseWait); }
      this.phase('activating'); await this.activate(index, Boolean(old));
      if (old) {
        await this.request(old, 'exit', 1000).catch(() => {});
        await Promise.race([old.exit, sleep(30000, undefined, { ref: false })]);
        await this.kill(oldIndex);
      }
      this.phase('confirming');
      const deadline = Date.now() + (old ? this.waits.confirmWait : 0);
      let unhealthySince = null;
      while (!this.closing && Date.now() < deadline) {
        if (next.dead) throw new Error('Live slot crashed during confirmation');
        try {
          const response = await fetch(next.url + '/readyz', { signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(1000)]) });
          await response.arrayBuffer();
          if (response.status !== 200) throw new Error('Not ready');
          unhealthySince = null;
        } catch { unhealthySince ??= Date.now(); if (Date.now() - unhealthySince >= 3000) throw new Error('Live slot readiness failed during confirmation'); }
        await sleep(100);
      }
      if (this.closing) throw new Error('Supervisor stopping');
      this.phase('succeeded'); this.failures = 0; this.healthySince = null;
    } catch (error) {
      this.phase('rolling_back', { error: error.message });
      if (held) this.edge.hold();
      await this.kill(index);
      if (old && !this.closing) {
        if (!this.slots[oldIndex] || old.dead) { await this.kill(oldIndex); await this.start(oldIndex, old.id); await this.wait(this.slots[oldIndex], false, this.waits.standbyWait); }
        if (held) await this.activate(oldIndex);
      } else if (!old) throw error;
      this.phase('failed');
    }
    this.revision = revision;
  }
  async reconcile(desired) {
    if (this.closing) return;
    if (desired?.mode === 'stop') {
      this.edge.hold(); await Promise.all([this.terminate(0), this.terminate(1)]); this.live = null; this.revision = desired.revision; return;
    }
    const slot = this.slots[this.live];
    if (slot?.dead) {
      this.edge.hold();
      const id = slot.id, index = this.live;
      this.healthySince = null;
      await sleep(Math.min(30000, 1000 * 2 ** this.failures), undefined, { signal: this.abort.signal });
      if (++this.failures >= 5) throw new Error('Live slot failed five consecutive restarts');
      await this.kill(index);
      try { await this.start(index, id); await this.wait(this.slots[index], false, this.waits.standbyWait); await this.activate(index); }
      catch { this.slots[index].dead = true; }
      return;
    }
    if (slot) { this.healthySince ??= Date.now(); if (Date.now() - this.healthySince >= 60000) this.failures = 0; }
    if (desired?.revision === this.revision && slot) return;
    const id = desired?.releaseId ?? null;
    if (slot && desired?.strategy !== 'switch') {
      this.edge.hold(); await this.terminate(this.live); this.live = null;
    }
    await this.change(id, desired?.revision ?? null);
  }
  cancel() { this.closing = true; this.abort.abort(); }
  async stop() { this.cancel(); this.edge.hold(); await Promise.all([this.terminate(0), this.terminate(1)]); this.edge.stop(); }
}
