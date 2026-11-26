import { chmodSync, chownSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { join } from 'node:path';
import { checkServiceDirectory } from './root-run-endpoint.mjs';
import { RootRunSupervisor, birth, readFrame } from './root-run-supervisor.mjs';

process.umask(0o077);
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { publicDirectory, daemonUid, daemonGid, keyServiceUid, keyServiceGid } = config;
if (process.getuid() !== 0 || ![daemonUid, daemonGid, keyServiceUid, keyServiceGid].every(id => Number.isSafeInteger(id) && id > 0) ||
    daemonUid === keyServiceUid || daemonGid === keyServiceGid) throw Error('separate service identities required');
checkServiceDirectory(publicDirectory, 0);
checkServiceDirectory(config.directory, 0);
const supervisor = new RootRunSupervisor({ directory: config.directory, hostModule: config.hostModule, node: process.execPath,
  daemonUid, daemonGid, keyServiceUid, keyServiceGid });

async function listen(name, group, dispatch) {
  const endpoint = join(publicDirectory, name);
  const server = createServer(socket => {
    readFrame(socket).then(async request => {
      try { socket.end(JSON.stringify({ nonce: request.nonce, ok: true, value: await dispatch(request) }) + '\n'); }
      catch { socket.end(JSON.stringify({ nonce: request.nonce, ok: false }) + '\n'); }
    }).catch(() => socket.destroy());
  });
  server.listen(endpoint);
  await once(server, 'listening');
  chownSync(endpoint, 0, group);
  chmodSync(endpoint, 0o660);
}

await listen('target.sock', keyServiceGid, async request => {
  if (request.op !== 'attest') throw Error();
  return supervisor.request(request.tuple, { op: 'attest', lease: request.lease, term: request.term });
});
await listen('control.sock', daemonGid, async request => {
  if (!['install', 'attach', 'start'].includes(request.op) || birth(request.pid) !== request.birth) throw Error();
  const ids = readFileSync(`/proc/${request.pid}/status`, 'utf8').match(/^Uid:\s+(.+)$/m)?.[1].trim().split(/\s+/);
  if (ids?.length !== 4 || ids.some(id => Number(id) !== daemonUid)) throw Error();
  if (request.op === 'install') await supervisor.ensureHost(request.tuple, request.lease, request.term);
  return supervisor.request(request.tuple, request);
});
