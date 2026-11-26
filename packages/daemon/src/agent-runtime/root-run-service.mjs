import { chmodSync, chownSync, lstatSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.umask(0o077);
const entry = fileURLToPath(import.meta.url);
for (let current = entry; ; current = dirname(current)) {
  const stat = lstatSync(current);
  if (realpathSync(current) !== current || stat.uid !== 0 || (stat.mode & 0o022)) throw Error('untrusted service installation');
  if (current === dirname(current)) break;
}
for (const module of ['approved', 'endpoint', 'supervisor', 'relay', 'controller', 'receiver', 'host', 'carrier']) {
  const stat = lstatSync(join(dirname(entry), `root-run-${module}.mjs`));
  if (stat.uid !== 0 || !stat.isFile() || (stat.mode & 0o022)) throw Error('untrusted supervisor module');
}
const { approvedJson, trustedPath } = await import('./root-run-approved.mjs');
const { RootRunSupervisor, birth, readFrame } = await import('./root-run-supervisor.mjs');
const config = approvedJson(process.argv[2]);
if ('hostModule' in config) throw Error('host module override forbidden');
const { publicDirectory, daemonUid, daemonGid, keyServiceUid, keyServiceGid } = config;
if (process.getuid() !== 0 || ![daemonUid, daemonGid, keyServiceUid, keyServiceGid].every(id => Number.isSafeInteger(id) && id > 0) ||
    daemonUid === keyServiceUid || daemonGid === keyServiceGid) throw Error('separate service identities required');
trustedPath(publicDirectory, true);
trustedPath(config.directory, true);
trustedPath(config.approvedPlansFile);
const python = trustedPath(realpathSync('/usr/bin/python3'));
const supervisor = new RootRunSupervisor({ directory: config.directory, hostSocket: config.hostSocket, approvedPlansFile: config.approvedPlansFile, node: trustedPath(process.execPath),
  daemonUid, daemonGid, keyServiceUid, keyServiceGid });

async function listen(name, uid, group, dispatch) {
  const endpoint = join(publicDirectory, name);
  const server = createServer(socket => {
    readFrame(socket).then(async request => {
      try {
        const fd = socket._handle?.fd;
        if (!Number.isInteger(fd) || fd < 0) throw Error();
        const peer = execFileSync(python, ['-I', '-S', '-c',
          'import socket,struct; s=socket.socket(fileno=3); print(*struct.unpack("3i",s.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12)))'],
          { stdio: ['ignore', 'pipe', 'ignore', fd], env: {}, timeout: 5000, maxBuffer: 128 }).toString().trim().split(/\s+/).map(Number);
        if (peer.length !== 3 || peer[0] <= 0 || peer[1] !== uid || peer[2] !== group) throw Error();
        socket.end(JSON.stringify({ nonce: request.nonce, ok: true, value: await dispatch(request, peer[0]) }) + '\n');
      }
      catch { socket.end(JSON.stringify({ nonce: request.nonce, ok: false }) + '\n'); }
    }).catch(() => socket.destroy());
  });
  server.listen(endpoint);
  await once(server, 'listening');
  chownSync(endpoint, 0, group);
  chmodSync(endpoint, 0o660);
}

await listen('target.sock', keyServiceUid, keyServiceGid, async request => {
  if (request.op !== 'attest') throw Error();
  return supervisor.request(request.tuple, { op: 'attest', lease: request.lease, term: request.term });
});
await listen('control.sock', daemonUid, daemonGid, async (request, pid) => {
  if (!['install', 'attach', 'start'].includes(request.op) || request.pid !== pid || birth(pid) !== request.birth) throw Error();
  if (request.op === 'install') await supervisor.ensureHost(request.tuple, request.lease, request.term);
  return supervisor.request(request.tuple, request);
});
process.stdout.write('root run supervisor ready\n');
