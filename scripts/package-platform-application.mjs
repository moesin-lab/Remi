// CI creates application archives from the verified API/Web build outputs.
// Updating clients download these files; they do not pull either image.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import inputs from '../packages/platform-updater/src/data-schema-inputs.json' with { type: 'json' };
import { API_BASE_INPUTS, extractArchive } from '../packages/platform-updater/src/container-runtime.mjs';
import { baseFingerprints } from '../packages/platform-updater/src/supervisor.mjs';

const [manifestPath, outputDirectory = '.'] = process.argv.slice(2);
if (!manifestPath || process.platform !== 'linux') throw new Error('Usage on Linux: node scripts/package-platform-application.mjs <platform-release.json> [output-directory]');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(manifest.version) || !/^[a-f0-9]{40}$/.test(manifest.ref)) throw new Error('Invalid release identity');
for (const image of [manifest.apiImage, manifest.webImage]) if (!/@sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Bundle builds require immutable API/Web image digests');
const policy = JSON.parse(await readFile(new URL('../deploy/platform-application-compatibility.json', import.meta.url), 'utf8'));
if (policy.dataSchema !== manifest.dataSchema || !Array.isArray(policy.rollbackSafeFrom) || policy.rollbackSafeFrom.some(value => !/^[a-f0-9]{64}$/.test(value))) throw new Error('Review and update the application migration compatibility policy for this release');
const application = { format: 1, supervisor: 1, rollbackSafeFrom: policy.rollbackSafeFrom, assets: {} };
const output = resolve(outputDirectory);
await mkdir(output, { recursive: true });
function run(command, args) {
  const child = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024 });
  if (child.status !== 0) throw new Error(`${command} ${args[0]} failed: ${child.stderr}`);
  return child.stdout.trim();
}
for (const [arch, dockerArch] of [['x64', 'amd64'], ['arm64', 'arm64']]) {
  const temporary = await mkdtemp(join(tmpdir(), 'remi-application-package-'));
  try {
    await mkdir(join(temporary, 'runtime'));
    for (const [role, image] of [['api', manifest.apiImage], ['web', manifest.webImage]]) {
      run('docker', ['pull', '--platform', `linux/${dockerArch}`, image]);
      const libc = run('docker', ['run', '--rm', '--platform', `linux/${dockerArch}`, '--entrypoint', 'getconf', image, 'GNU_LIBC_VERSION']);
      if (application[role + 'Libc'] && application[role + 'Libc'] !== libc) throw new Error('Architecture builds have different libc requirements');
      application[role + 'Libc'] = libc;
      const container = run('docker', ['create', '--platform', `linux/${dockerArch}`, '--entrypoint', '/bin/true', image]);
      try {
        await mkdir(join(temporary, role));
        run('docker', ['cp', `${container}:/app/.`, join(temporary, role)]);
        const binary = role === 'api' ? 'bun' : 'node';
        const version = run('docker', ['run', '--rm', '--platform', `linux/${dockerArch}`, '--entrypoint', '/usr/local/bin/' + binary, image, '--version']).replace(/^v/, '');
        if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid bundled runtime version');
        if (application[binary] && application[binary] !== version) throw new Error('Architecture runtime versions differ');
        application[binary] = version;
        if (binary === 'node') application.nodeMajor = Number(version.split('.')[0]);
        run('docker', ['cp', '-L', `${container}:/usr/local/bin/${binary}`, join(temporary, 'runtime', binary)]);
      } finally { run('docker', ['rm', container]); }
    }
    const source = (await Promise.all(inputs.map(path => readFile(join(temporary, 'api', path), 'utf8')))).join('').replaceAll('\r\n', '\n');
    if (createHash('sha256').update(source).digest('hex') !== manifest.dataSchema) throw new Error('Published API source differs from the release schema');
    const baseSource = (await Promise.all(API_BASE_INPUTS.map(path => readFile(join(temporary, 'api', path), 'utf8')))).join('').replaceAll('\r\n', '\n');
    const apiBase = createHash('sha256').update(baseSource).digest('hex');
    if (application.apiBase && application.apiBase !== apiBase) throw new Error('Architecture builds have different API base requirements');
    application.apiBase = apiBase;
    application.nativeTools = (await baseFingerprints(join(temporary, 'api'))).nativeTools;
    await readFile(join(temporary, 'web/frontend/apps/web/server.js'));
    await writeFile(join(temporary, 'application.json'), JSON.stringify({ ...manifest, arch, application: { ...application, assets: {} } }) + '\n');
    const name = `platform-application-v${manifest.version}-linux-${arch}.tar.gz`;
    const archive = join(output, name);
    run('tar', ['--format=posix', '-czf', archive, '-C', temporary, 'application.json', 'api', 'web', 'runtime']);
    // Validate the exact downloadable layout with the client extractor before
    // publishing, including Bun workspace and Next standalone symlinks. Free
    // the staging copies first so verification does not double disk usage.
    for (const role of ['api', 'web', 'runtime']) await rm(join(temporary, role), { recursive: true });
    const verified = join(temporary, 'verified');
    await extractArchive(archive, verified);
    const extractedSource = (await Promise.all(inputs.map(path => readFile(join(verified, 'api', path), 'utf8')))).join('').replaceAll('\r\n', '\n');
    if (createHash('sha256').update(extractedSource).digest('hex') !== manifest.dataSchema) throw new Error('Extracted application source differs from the release schema');
    await readFile(join(verified, 'web/frontend/apps/web/server.js'));
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    application.assets[`linux-${arch}`] = { url: new URL(name, manifest.manifestUrl).href, sha256: hash.digest('hex') };
    console.log(`Packaged ${name}`);
  } finally {
    if (relative(tmpdir(), temporary).startsWith('..') || !temporary.includes('remi-application-package-')) throw new Error('Invalid packaging directory');
    await rm(temporary, { recursive: true, force: true });
  }
}
await writeFile(manifestPath, JSON.stringify({ ...manifest, application }, null, 2) + '\n');
