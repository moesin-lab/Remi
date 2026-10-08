import type { MultiremiPlatformDeploymentDriver, MultiremiPlatformSourceCapabilities } from '@multiremi/contracts';
import { parseApplicationManifest } from './application-manifest.js';
import { assertHttpsUrl } from './release-feed.js';

const SHA256 = /^[a-f0-9]{64}$/i;
const IMAGE = /^[a-z0-9][a-z0-9.:-]*\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/i;
const VERSION = /^\d+\.\d+\.\d+$/;

/** Inspect the fetched manifest, never the URL's name or an advertised list of modes. */
export function releaseCapabilities(
  manifest: Record<string, unknown>, arch: string, driver: MultiremiPlatformDeploymentDriver,
): MultiremiPlatformSourceCapabilities['modes'] {
  const identity = /^v?\d+\.\d+\.\d+$/.test(String(manifest.version))
    && typeof manifest.ref === 'string' && manifest.ref.trim().length > 0;
  const common = identity ? [] : ['release_identity'];
  const source = [...common];
  if (!https(manifest.sourceUrl) || !SHA256.test(String(manifest.sourceSha256 ?? ''))) source.push('source_archive');
  const images = [...common];
  if (!IMAGE.test(String(manifest.apiImage ?? ''))) images.push('api_image');
  if (!IMAGE.test(String(manifest.webImage ?? ''))) images.push('web_image');
  // The legacy local-profile driver stages its host tools from the source archive.
  if (driver === 'local_profile') {
    images.push(...source.filter(issue => !images.includes(issue)));
    if (!/^[a-f0-9]{40}$/i.test(String(manifest.ref))) images.push('release_identity');
    if (https(manifest.sourceUrl) && new URL(String(manifest.sourceUrl)).search) images.push('source_archive');
  }
  const application = [...common];
  let app: ReturnType<typeof parseApplicationManifest>['application'] | null = null;
  if (!manifest.application) application.push('application_bundle');
  else {
    try { app = parseApplicationManifest(manifest).application; }
    catch { application.push('application_metadata'); }
  }
  if (app && !app.assets[`linux-${arch}`]) application.push('architecture_bundle');
  const internal = [...application];
  if (app) {
    if (app.supervisor !== 1) internal.push('supervisor');
    if (!VERSION.test(app.node ?? '') || Number(app.node?.split('.')[0]) !== app.nodeMajor) internal.push('bundled_runtimes');
    if (!SHA256.test(app.nativeTools ?? '')) internal.push('native_tools');
  }
  return [
    { mode: 'images', missing: [...new Set(images)] },
    { mode: 'host_application', missing: application },
    { mode: 'internal_application', missing: internal },
    { mode: 'systemd_release', missing: source },
  ].map(item => ({ ...item, available: item.missing.length === 0 })) as MultiremiPlatformSourceCapabilities['modes'];
}

function https(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try { assertHttpsUrl(value, 'archive URL'); return true; } catch { return false; }
}
