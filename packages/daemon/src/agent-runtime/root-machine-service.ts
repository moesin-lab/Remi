import { dlopen, ptr } from 'bun:ffi';
import { createPrivateKey } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, writeSync } from 'node:fs';
import { RootMachineKeys } from './root-machine-keys.js';

const maxRequestSize = 8192;

export function unixPeerUid(fd: number): number {
  if (process.platform !== 'linux') throw new Error('Linux peer credentials required');
  const libc = dlopen('libc.so.6', {getsockopt:{args:['int','int','int','ptr','ptr'],returns:'int'}});
  try {
    const option = (name: number, words: number) => {
      const buffer = new Uint32Array(words);
      const length = new Uint32Array([buffer.byteLength]);
      if (libc.symbols.getsockopt(fd, 1, name, ptr(buffer), ptr(length)) !== 0 || length[0] !== buffer.byteLength) {
        throw new Error('Unavailable Unix peer identity');
      }
      return buffer;
    };
    if (option(39, 1)[0] !== 1 || option(3, 1)[0] !== 1) throw new Error('Expected Unix stream socket');
    const [pid, uid] = option(17, 3);
    if (!pid || !Number.isSafeInteger(uid) || uid === 65534 || uid === 0xffffffff) throw new Error('Unmapped Unix peer');
    return uid;
  } finally { libc.close(); }
}

function servePeer(directory: string, owner: number, peer: number, request: Buffer) {
  const dir = openSync(directory, constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_RDONLY);
  try {
    const stat = fstatSync(dir);
    if (stat.uid !== owner || (stat.mode & 0o077) !== 0) throw new Error('Invalid machine key directory');
    const read = (name: string) => {
      const fd = openSync(`/proc/self/fd/${dir}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const file = fstatSync(fd);
        if (!file.isFile() || file.uid !== owner || file.nlink !== 1 || (file.mode & 0o077) !== 0 || file.size > 32768) {
          throw new Error('Invalid machine identity file');
        }
        return readFileSync(fd);
      } finally { closeSync(fd); }
    };
    const config = JSON.parse(read('binding.json').toString('utf8'));
    const uids = [owner, config.daemonUid, config.executionUid];
    if (new Set(uids).size !== 3 || uids.some(uid => !Number.isSafeInteger(uid) || uid < 1 || uid >= 0xffffffff || uid === 65534) ||
        config.daemonUid !== peer) throw new Error('Unauthorized machine peer');
    const operation = JSON.parse(request.toString('utf8'));
    if (operation.method !== 'publicBinding' && operation.method !== 'answerChallenge') throw new Error('Unknown machine operation');
    const readKey = (file: string) => {
      const bytes = read(file);
      try { return createPrivateKey(bytes); } finally { bytes.fill(0); }
    };
    const keys = new RootMachineKeys(config.identity, readKey('recipient.pem'), readKey('signing.pem'));
    return operation.method === 'publicBinding' ? keys.publicBinding() : keys.answerChallenge(operation.challenge);
  } finally { closeSync(dir); }
}

export function serveMachineConnection(fd: number, directory: string): void {
  const peer = unixPeerUid(fd);
  const libc = dlopen('libc.so.6', {poll:{args:['ptr','usize','int'],returns:'int'}});
  const pollfd = new Int32Array(2);
  pollfd[0] = fd;
  const events = new Int16Array(pollfd.buffer, 4);
  events[0] = 1;
  const deadline = performance.now() + 5000;
  const buffer = Buffer.alloc(maxRequestSize + 1);
  let length = 0;
  let reply: string;
  try {
    for (;;) {
      const remaining = Math.ceil(deadline - performance.now());
      if (remaining <= 0 || libc.symbols.poll(ptr(pollfd), 1, remaining) !== 1) throw new Error('Machine request timed out');
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
      if (length > maxRequestSize) throw new Error('Machine request too large');
    }
    const result = servePeer(directory, process.geteuid!(), peer, buffer.subarray(0, length));
    reply = JSON.stringify({ok:true,result});
  } catch { reply = JSON.stringify({ok:false}); }
  finally { libc.close(); }
  const response = Buffer.from(reply);
  for (let offset = 0; offset < response.length;) {
    const sent = writeSync(fd, response, offset, response.length - offset);
    if (sent <= 0) throw new Error('Machine peer disconnected');
    offset += sent;
  }
}

if (import.meta.main) {
  const directory = process.argv[2];
  if (!directory?.startsWith('/')) throw new Error('Expected private machine key directory');
  serveMachineConnection(0, directory);
}
