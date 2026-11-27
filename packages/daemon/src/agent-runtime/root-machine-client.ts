import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { connect } from 'node:net';
import { isAbsolute } from 'node:path';
import { type MachineChallenge, type MachinePublicBinding } from '@shared/machine-challenge.js';
import type { RootDeliveryMachineProof, RootDeliveryStatusResponse, RootDeliveryEnvelopePayload } from '@multiremi/contracts/root-delivery.js';
import type { RootRunTarget } from './root-run-supervisor.mjs';

export class RootMachineClient {
  constructor(private readonly directory: string, private readonly serviceUid: number) {
    if (!isAbsolute(directory) || !Number.isSafeInteger(serviceUid) || serviceUid <= 0 || serviceUid === 65534 ||
        serviceUid >= 0xffffffff || serviceUid === process.geteuid?.()) throw new Error('Invalid machine service identity');
  }

  publicBinding(): Promise<MachinePublicBinding> { return this.request({method:'publicBinding'}); }

  answerChallenge(challenge: MachineChallenge): Promise<RootDeliveryMachineProof> {
    return this.request({method:'answerChallenge', challenge});
  }

  installEnvelope(delivery: RootDeliveryEnvelopePayload, status: RootDeliveryStatusResponse, target: RootRunTarget): Promise<{envelope:string; verificationId:string}> {
    return this.request({method:'installEnvelope',delivery,status,target});
  }

  private async request<Result>(operation: object): Promise<Result> {
    const directory = await open(this.directory, constants.O_DIRECTORY | constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await directory.stat();
      if (stat.uid !== this.serviceUid || (stat.mode & 0o022) !== 0) throw new Error('Invalid machine service directory');
      return await new Promise<Result>((resolve, reject) => {
        const socket = connect({path:`/proc/self/fd/${directory.fd}/machine.sock`, allowHalfOpen:true});
        const timer = setTimeout(() => socket.destroy(new Error('Machine request timed out')), 5500);
        const chunks: Buffer[] = [];
        let size = 0;
        socket.once('connect', () => socket.write(`${JSON.stringify(operation)}\n`));
        socket.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 16384) socket.destroy(new Error('Oversized machine reply'));
          else chunks.push(chunk);
        });
        socket.once('error', reject);
        socket.once('end', () => {
          socket.end();
          try {
            const reply = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (reply?.ok !== true || !reply.result) throw new Error('Machine operation denied');
            resolve(reply.result);
          } catch (error) { reject(error); }
        });
        socket.once('close', () => {
          clearTimeout(timer);
          reject(new Error('Machine service disconnected'));
        });
      });
    } finally { await directory.close(); }
  }
}
