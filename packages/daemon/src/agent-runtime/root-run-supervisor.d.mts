import type { RootDeliveryStatusResponse, RootDeliveryTuple, RootExecutionLocator } from '@multiremi/contracts/root-delivery.js';
import type { webcrypto } from 'node:crypto';
import type { RootRunEndpoint } from './root-run-endpoint.mjs';

export type RegisteredRunBinding = Pick<RootDeliveryTuple, 'consumer_id' | 'runtime_id' | 'daemon_id' | 'incarnation' |
  'recipient_key_id' | 'recipient_key_fingerprint' | 'grant_id' | 'grant_generation' | 'execution_config_epoch' | 'execution_digest'> &
  { grant_id: string; grant_generation: number };

export interface RegisteredRunPlan {
  binding: RegisteredRunBinding;
  identities: { uid: number; gid: number }[];
  file: string;
  sha256: string;
  cwd: string;
  args: string[];
}

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
    identities: { uid: number; gid: number }[]; file: string; args: string[]; cwd: string; sha256: string;
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
