import type { RootDeliveryStatusResponse, RootDeliveryTuple, RootExecutionLocator } from '@multiremi/contracts/root-delivery.js';
import type { webcrypto } from 'node:crypto';
import type { RootRunEndpoint } from './root-run-endpoint.mjs';

export interface RootRunTarget {
  tuple: RootDeliveryTuple;
  locator: RootExecutionLocator;
  pid: number;
  birth: string;
  uid: number;
  publicKey: webcrypto.JsonWebKey;
}

export interface RootRunHost {
  readStatus(tuple: RootDeliveryTuple): Promise<RootDeliveryStatusResponse>;
  planRun(tuple: RootDeliveryTuple, status: RootDeliveryStatusResponse): Promise<{
    uid: number; gid: number; file: string; args: string[]; cwd: string;
  }>;
  sealInstallation(target: RootRunTarget, status: RootDeliveryStatusResponse): Promise<{ envelope: string; verificationId: string }>;
  verifyInstallation(target: RootRunTarget, sealed: { envelope: string; verificationId: string }, proof: string): Promise<boolean>;
}

export interface RootRunHandle {
  tuple: RootDeliveryTuple;
  locator: RootExecutionLocator;
  lease: string;
  term: string;
  generation: string;
}

export function birth(pid: number): string;

export class RootRunSupervisor {
  constructor(config: RootRunEndpoint, controllerId?: string);
  ensureInstalled(tuple: RootDeliveryTuple, lease: string, term: string): Promise<RootExecutionLocator>;
  attach(tuple: RootDeliveryTuple, locator: RootExecutionLocator, lease: string, term: string): Promise<RootRunHandle>;
  startOnce(handle: RootRunHandle): Promise<string>;
}
