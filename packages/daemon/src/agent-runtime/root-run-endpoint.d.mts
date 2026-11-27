import type { RootDeliveryStatusResponse } from '@multiremi/contracts/root-delivery.js';
import type { RootRunTarget } from './root-run-supervisor.mjs';

export interface RootRunEndpoint {
  endpoint: string;
  supervisorUid: number;
}

export function verifyRootRunTarget(config: RootRunEndpoint, target: RootRunTarget, status: RootDeliveryStatusResponse): Promise<RootRunTarget>;
