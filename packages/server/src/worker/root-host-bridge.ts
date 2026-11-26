import { randomUUID } from 'node:crypto';
import { chmod, lstat, realpath, rename, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { once } from 'node:events';
import { isDeepStrictEqual } from 'node:util';
import type { RootDeliveryTuple } from '@multiremi/contracts/root-delivery.js';
import type { RootMachineClient } from '@daemon/agent-runtime/root-machine-client.js';
import type { RootRunTarget } from '@daemon/agent-runtime/root-run-supervisor.mjs';
import type { RootReceiptClient } from './root-receipt-client.js';

export class RootHostBridge {
  constructor(private readonly directory: string, private readonly receipts: RootReceiptClient,
    private readonly keys: RootMachineClient, private readonly lookup: (tuple: RootDeliveryTuple) => string) {}

  private readonly server = createServer(socket => {
    const chunks: Buffer[] = [];
    let size = 0;
    socket.setTimeout(15000, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 16384) { socket.destroy(); return; }
      chunks.push(chunk);
      if (!chunk.includes(10)) return;
      socket.pause();
      void this.respond(Buffer.concat(chunks)).then(response => socket.end(response), () => socket.destroy());
    });
  });

  private async respond(frame: Buffer) {
    const request = JSON.parse(frame.toString('utf8'));
    const {nonce} = request;
    if (typeof nonce !== 'string' || nonce.length > 128) throw new Error('Invalid supervisor request');
    try {
      const target: RootRunTarget = request.target;
      const tuple: RootDeliveryTuple = request.op === 'seal' ? target.tuple : request.tuple;
      if (request.op !== 'status' && request.op !== 'seal') throw new Error('Invalid supervisor operation');
      const status = await this.receipts.status(tuple,this.lookup(tuple));
      let value;
      if (request.op === 'status') value = status;
      else {
        if (!isDeepStrictEqual(status,request.status) || status.allowed_recovery_action !== 'replay_envelope') throw new Error('stale_execution');
        const delivery = await this.receipts.replay(tuple,status);
        value = await this.keys.installEnvelope(delivery,status,target);
      }
      return `${JSON.stringify({nonce,ok:true,value})}\n`;
    } catch { return `${JSON.stringify({nonce,ok:false})}\n`; }
  }

  async listen() {
    const uid = process.geteuid?.();
    const stat = await lstat(this.directory);
    if (!uid || uid === 65534 || await realpath(this.directory) !== this.directory || !stat.isDirectory() ||
        stat.uid !== uid || (stat.mode & 0o077) !== 0) throw new Error('Unsafe supervisor bridge directory');
    const endpoint = join(this.directory,'host.sock');
    const staging = join(this.directory,`${randomUUID()}.sock`);
    const previous = await lstat(endpoint).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (previous && (!previous.isSocket() || previous.uid !== uid)) throw new Error('Unexpected supervisor bridge endpoint');
    this.server.listen(staging);
    await once(this.server,'listening');
    try {
      await chmod(staging,0o600);
      await rename(staging,endpoint);
    } catch (error) {
      this.close();
      await unlink(staging).catch(() => {});
      throw error;
    }
  }

  close() { if (this.server.listening) this.server.close(); }
}
