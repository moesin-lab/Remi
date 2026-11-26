import { lstatSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readFrame } from './root-run-supervisor.mjs';

export function checkServiceDirectory(directory, supervisorUid) {
  if (realpathSync(directory) !== directory) throw Error('untrusted supervisor directory');
  for (let current = directory; ; current = dirname(current)) {
    const stat = lstatSync(current);
    const stickyAncestor = current !== directory && (stat.mode & 0o1000);
    if (!stat.isDirectory() || (stat.uid !== supervisorUid && (stat.uid !== 0 || current === directory)) ||
        ((stat.mode & 0o022) && !stickyAncestor)) throw Error('untrusted supervisor directory');
    if (current === dirname(current)) break;
  }
}

export async function serviceRequest({ endpoint, supervisorUid }, request) {
  checkServiceDirectory(dirname(endpoint), supervisorUid);
  const stat = lstatSync(endpoint);
  if (!stat.isSocket() || stat.uid !== supervisorUid || (stat.mode & 0o007)) throw Error('untrusted supervisor endpoint');
  const socket = connect(endpoint);
  const nonce = randomUUID();
  try {
    const response = readFrame(socket);
    socket.write(JSON.stringify({ ...request, nonce }) + '\n');
    const body = await response;
    if (body.nonce !== nonce || body.ok !== true) throw Error('supervisor rejected request');
    return body.value;
  } finally { socket.destroy(); }
}

export async function verifyRootRunTarget(config, target, status) {
  const actual = await serviceRequest(config, { op: 'attest', tuple: target.tuple, lease: status.lease_id, term: status.fence_term });
  if (!isDeepStrictEqual(actual, target)) throw Error('unverified receiver target');
  return actual;
}
