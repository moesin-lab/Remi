import { assertHttpsUrl } from './release-feed.js';
import type { MultiremiPlatformRelease } from '@multiremi/contracts';

export const API_BASE_INPUTS = ['deploy/docker/Dockerfile.api', 'deploy/docker/api-entrypoint.sh'];

export interface ApplicationManifest extends MultiremiPlatformRelease {
  dataSchema: string;
  application: {
    format: 1;
    bun: string;
    nodeMajor: number;
    /** Present on releases usable by the socket-free in-container supervisor. */
    node?: string;
    supervisor?: 1;
    nativeTools?: string;
    apiLibc: string;
    webLibc: string;
    /** Fingerprint of the image-owned API Dockerfile and entrypoint. */
    apiBase: string;
    /** Every listed source schema was reviewed for code-only rollback. */
    rollbackSafeFrom: string[];
    assets: Record<string, { url: string; sha256: string }>;
  };
}

export function parseApplicationManifest(input: unknown, options: { allowPrerelease?: boolean } = {}): ApplicationManifest {
  if (!input || typeof input !== 'object') throw new Error('Application release manifest is required');
  const value = input as ApplicationManifest;
  const versionPattern = options.allowPrerelease ? /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/ : /^v?\d+\.\d+\.\d+$/;
  if (!versionPattern.test(value.version) || !/^[a-f0-9]{40}$/.test(value.ref) || !/^[a-f0-9]{64}$/.test(value.dataSchema)) throw new Error('Invalid application release identity');
  const app = value.application;
  if (!app || app.format !== 1 || !/^\d+\.\d+\.\d+$/.test(app.bun) || !Number.isSafeInteger(app.nodeMajor) || app.nodeMajor < 22) throw new Error('This release has no supported application bundle; image-only releases cannot be applied in application mode');
  if (!/^glibc \d+\.\d+$/.test(app.apiLibc) || !/^glibc \d+\.\d+$/.test(app.webLibc)) throw new Error('Application libc requirements are missing');
  if (!/^[a-f0-9]{64}$/.test(app.apiBase)) throw new Error('Application base requirements are missing');
  if (!Array.isArray(app.rollbackSafeFrom) || app.rollbackSafeFrom.some(schema => !/^[a-f0-9]{64}$/.test(schema))) throw new Error('Invalid migration compatibility declaration');
  if (!app.assets || typeof app.assets !== 'object') throw new Error('Application assets are missing');
  for (const [platform, asset] of Object.entries(app.assets)) {
    if (!['linux-x64', 'linux-arm64'].includes(platform) || !asset || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('Invalid application asset');
    assertHttpsUrl(asset.url, 'application bundle URL');
  }
  return value;
}

export function assertApplicationCompatible(previous: MultiremiPlatformRelease | null, next: ApplicationManifest): void {
  if (!previous?.dataSchema || !/^[a-f0-9]{64}$/.test(previous.dataSchema)) throw new Error('Current application schema is unknown');
  if (previous.dataSchema !== next.dataSchema && !next.application.rollbackSafeFrom.includes(previous.dataSchema)) {
    throw new Error('This migration has no reviewed code-rollback compatibility declaration');
  }
}
