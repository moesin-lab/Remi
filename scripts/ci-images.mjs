import { readFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';

export function githubRepository(remote) {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/u.exec(remote.trim());
  if (!match) throw new Error('CI images require a GitHub origin remote');
  return match[1].toLowerCase();
}

export function validateCiImages(manifest, { ref, hostname, repository }) {
  const owner = repository.split('/')[0];
  if (!manifest || manifest.schemaVersion !== 1 || manifest.repository !== repository || manifest.ref !== ref
      || !/^[a-f0-9]{40}$/u.test(ref) || manifest.hostname !== hostname
      || manifest.profile !== 'stable' || manifest.platform !== 'linux/amd64'
      || typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+-stable\.[a-f0-9]{8}$/u.test(manifest.version)) {
    throw new Error('CI manifest repository, commit, profile, platform, version, or baked Web hostname does not match this deployment');
  }
  for (const service of ['api', 'web']) {
    const prefix = `ghcr.io/${owner}/remi-${service}@sha256:`;
    const image = manifest[`${service}Image`];
    if (typeof image !== 'string' || !image.startsWith(prefix) || !/^[a-f0-9]{64}$/u.test(image.slice(prefix.length))) {
      throw new Error(`CI ${service} image must be pinned by digest in this repository owner's registry`);
    }
  }
  return manifest;
}

export function loadCiImages({ deployment, manifestPath, root, capture, execute }) {
  const repository = githubRepository(capture('git', ['remote', 'get-url', 'origin']));
  let path = manifestPath;
  if (!path) {
    const name = `stable-images-${deployment.ref}`;
    const result = JSON.parse(capture('gh', ['api', `repos/${repository}/actions/artifacts?name=${name}&per_page=30`]));
    let selected;
    for (const artifact of result.artifacts ?? []) {
      if (artifact.expired || artifact.name !== name) continue;
      const run = JSON.parse(capture('gh', ['api', `repos/${repository}/actions/runs/${artifact.workflow_run.id}`]));
      if (run.conclusion === 'success' && run.path === '.github/workflows/platform-images.yml') { selected = artifact; break; }
    }
    if (!selected) throw new Error(`No successful CI image build for ${deployment.ref}. Run Platform images in ${repository}; local compilation is disabled by default.`);
    const directory = join(root, 'ci-images');
    mkdirSync(directory, { recursive: true });
    const destination = mkdtempSync(join(directory, `${selected.workflow_run.id}-`));
    execute('gh', ['run', 'download', String(selected.workflow_run.id), '--repo', repository, '--name', name, '--dir', destination]);
    path = join(destination, 'stable-images.json');
  }
  return validateCiImages(JSON.parse(readFileSync(path, 'utf8')), {
    ref: deployment.ref, hostname: deployment.network?.hostname ?? '127.0.0.1', repository,
  });
}
