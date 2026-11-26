import { spawn } from 'node:child_process';
import { createHash, randomUUID, verify } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { serviceRequest } from './root-run-endpoint.mjs';

export function runPaths(directory, tuple) {
  const stat = lstatSync(directory);
  if (process.platform !== 'linux' || realpathSync(directory) !== directory || !stat.isDirectory() ||
      stat.uid !== process.getuid() || (stat.mode & 0o077)) throw Error('unsafe supervisor directory');
  const id = createHash('sha256').update(JSON.stringify([tuple.receipt_id, tuple.attempt_id, tuple.run_generation])).digest('hex');
  return { journal: join(directory, id + '.json') };
}

export function birth(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw Error('invalid pid');
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const ticks = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19];
  const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  if (!/^[0-9a-f-]{36}$/.test(boot) || !/^\d+$/.test(ticks)) throw Error('unknown process birth');
  return `${boot}:${pid}:${ticks}`;
}

export function readFrame(socket) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    socket.on('error', reject).once('close', () => reject(Error('supervisor disconnected')));
    socket.setTimeout(30000, () => socket.destroy(Error('supervisor timeout')));
    function receive(chunk) {
      bytes += chunk.length;
      if (bytes > 128 * 1024) return socket.destroy(Error('oversized frame'));
      chunks.push(chunk);
      if (!chunk.includes(10)) return;
      socket.off('data', receive);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (error) { reject(error); }
    }
    socket.on('data', receive);
  });
}

export class RootRunSupervisor {
  constructor(config, controllerId = randomUUID()) {
    this.config = config;
    this.controllerId = controllerId;
  }
  async request(tuple, fields) {
    const request = { controller: this.controllerId, pid: process.pid, birth: birth(process.pid), ...fields, tuple };
    if (this.config.endpoint) return serviceRequest(this.config, request);
    const paths = runPaths(this.config.directory, tuple);
    const record = JSON.parse(readFileSync(paths.journal, 'utf8'));
    if (!isDeepStrictEqual(record.tuple, tuple) || record.endpoint !== join(this.config.directory, record.execution + '.sock')) throw Error('journal mismatch');
    if (birth(record.pid) !== record.birth) throw Error('supervisor birth mismatch');
    const socket = connect(record.endpoint);
    const nonce = randomUUID();
    try {
      const response = readFrame(socket);
      socket.write(JSON.stringify({ ...request, nonce }) + '\n');
      const { body, signature } = await response;
      if (body.nonce !== nonce || !verify(null, Buffer.from(JSON.stringify(body)), record.publicKey, Buffer.from(signature, 'base64url'))) {
        throw Error('supervisor challenge failed');
      }
      if (!body.ok) throw Error('stale or unverified execution');
      return body.value;
    } finally { socket.destroy(); }
  }
  async ensureHost(tuple, lease, term) {
    const paths = runPaths(this.config.directory, tuple);
    try { lstatSync(paths.journal); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await new Promise((resolve, reject) => {
        const child = spawn(this.config.node, [fileURLToPath(new URL('./root-run-host.mjs', import.meta.url)),
          JSON.stringify({ ...this.config, tuple, lease, term })], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: {} });
        child.once('error', reject);
        child.stdout.once('data', () => resolve());
        child.once('exit', code => code === 2 ? resolve() : reject(Error('supervisor launch failed')));
        child.unref();
      });
    }
  }
  async ensureInstalled(tuple, lease, term) {
    if (!this.config.endpoint) await this.ensureHost(tuple, lease, term);
    return this.request(tuple, { op: 'install', lease, term });
  }
  async attach(tuple, locator, lease, term) {
    const generation = await this.request(tuple, { op: 'attach', locator, lease, term });
    return { tuple, locator, lease, term, generation };
  }
  async startOnce(handle) {
    return this.request(handle.tuple, { ...handle, op: 'start' });
  }
}
