import { describe, expect, it } from 'bun:test';
import { releaseCapabilities } from '@remi-platform/updater/release-capabilities.js';

const manifest = () => ({
  version: '1.2.3', ref: 'a'.repeat(40), dataSchema: 'b'.repeat(64),
  apiImage: `ghcr.io/remi/api@sha256:${'c'.repeat(64)}`, webImage: `ghcr.io/remi/web@sha256:${'d'.repeat(64)}`,
  sourceUrl: 'https://releases.example/source.tar.gz', sourceSha256: 'e'.repeat(64),
  application: { format: 1, bun: '1.3.14', node: '22.23.3', nodeMajor: 22, supervisor: 1,
    nativeTools: 'f'.repeat(64), apiBase: 'a'.repeat(64), apiLibc: 'glibc 2.36', webLibc: 'glibc 2.36', rollbackSafeFrom: [],
    assets: { 'linux-x64': { url: 'https://releases.example/application.tar.gz', sha256: 'b'.repeat(64) } } },
});

describe('release mode artifacts', () => {
  it('recognizes a unified source from actual manifest contents', () => {
    expect(releaseCapabilities(manifest(), 'x64', 'docker_compose').every(mode => mode.available)).toBe(true);
  });
  it('does not treat an image-only release or its advertised modes as an application bundle', () => {
    const { application, ...images } = manifest();
    const modes = releaseCapabilities({ ...images, modes: ['internal_application'] }, 'x64', 'docker_compose');
    expect(modes.find(mode => mode.mode === 'images')?.available).toBe(true);
    expect(modes.find(mode => mode.mode === 'internal_application')).toMatchObject({ available: false, missing: ['application_bundle'] });
  });
  it('distinguishes host application bundles from bundles with internal supervisor/runtime support', () => {
    const release = manifest();
    Object.assign(release.application, { node: undefined, supervisor: undefined, nativeTools: undefined });
    const modes = releaseCapabilities(release, 'x64', 'docker_compose');
    expect(modes.find(mode => mode.mode === 'host_application')?.available).toBe(true);
    expect(modes.find(mode => mode.mode === 'internal_application')?.missing).toEqual(['supervisor', 'bundled_runtimes', 'native_tools']);
  });
  it('requires an application archive for the actual container CPU', () => {
    const modes = releaseCapabilities(manifest(), 'arm64', 'docker_compose');
    expect(modes.find(mode => mode.mode === 'internal_application')?.missing).toEqual(['architecture_bundle']);
  });
  it('rejects mutable image tags, inconsistent runtimes and unsafe download metadata', () => {
    const release = manifest();
    release.apiImage = 'ghcr.io/remi/api:latest';
    release.application.node = '24.0.0';
    release.sourceUrl = 'http://releases.example/source.tar.gz';
    const modes = releaseCapabilities(release, 'x64', 'docker_compose');
    expect(modes.find(mode => mode.mode === 'images')?.missing).toEqual(['api_image']);
    expect(modes.find(mode => mode.mode === 'internal_application')?.missing).toEqual(['bundled_runtimes']);
    expect(modes.find(mode => mode.mode === 'systemd_release')?.missing).toEqual(['source_archive']);
    release.application.assets['linux-x64'].url = 'https://user:secret@releases.example/file';
    expect(releaseCapabilities(release, 'x64', 'docker_compose').find(mode => mode.mode === 'host_application')?.missing).toEqual(['application_metadata']);
  });
  it('accounts for the legacy local-profile driver needing host source tools', () => {
    const release = { ...manifest(), sourceSha256: '' };
    expect(releaseCapabilities(release, 'x64', 'local_profile').find(mode => mode.mode === 'images')?.missing).toEqual(['source_archive']);
    expect(releaseCapabilities(release, 'x64', 'docker_compose').find(mode => mode.mode === 'images')?.available).toBe(true);
  });
});
