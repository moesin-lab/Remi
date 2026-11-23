import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { schemaLevelFingerprint } from '../packages/platform-updater/src/schema-fingerprint.mjs';

export interface PreviousReleaseManifest {
  version: string;
  ref: string;
  dataSchema: string;
}

export interface RewrittenReleaseRef {
  readonly version: string;
  readonly publishedRef: string;
  readonly rewrittenRef: string;
}

/**
 * Known published platform releases whose Git history was later rewritten while
 * the immutable GitHub Release manifest retained the pre-rewrite commit SHA.
 * Ref verification only accepts an exact (version, publishedRef, rewrittenRef)
 * match and still enforces schemaLevelFingerprint(previousRoot) === dataSchema.
 */
export const KNOWN_REWRITTEN_RELEASE_REFS: readonly RewrittenReleaseRef[] = Object.freeze([
  Object.freeze({
    version: '0.2.95',
    publishedRef: 'b45ce8e764a83a755ec288f4ab404095ff4915eb',
    rewrittenRef: '7f81fbf4e6c6c0430f43864720bc4cfe53ed653e',
  }),
]);

export function verifyPreviousReleaseRef(
  previous: Pick<PreviousReleaseManifest, 'version' | 'ref'>,
  actualHead: string,
  actualTagRef: string,
): { expectedRef: string; rewritten: boolean } {
  assert.match(previous.ref, /^[a-f0-9]{40}$/);
  assert.match(previous.version, /^\d+\.\d+\.\d+$/);
  if (actualHead === previous.ref && actualTagRef === previous.ref) {
    return { expectedRef: previous.ref, rewritten: false };
  }
  const rewritten = KNOWN_REWRITTEN_RELEASE_REFS.find(
    (entry) =>
      entry.version === previous.version &&
      entry.publishedRef === previous.ref &&
      entry.rewrittenRef === actualHead &&
      entry.rewrittenRef === actualTagRef,
  );
  if (rewritten) {
    return { expectedRef: rewritten.rewrittenRef, rewritten: true };
  }
  assert.equal(actualHead, previous.ref);
  assert.equal(actualTagRef, previous.ref);
  return { expectedRef: previous.ref, rewritten: false };
}

export async function verifyPreviousReleaseCheckout(
  previousRoot: string,
  previous: PreviousReleaseManifest,
  options: {
    git?: (cwd: string, ...args: string[]) => string;
    checkClean?: (cwd: string) => void;
    fingerprint?: (root: string) => Promise<string>;
  } = {},
): Promise<{ expectedRef: string; rewritten: boolean; dataSchema: string }> {
  const runGit = options.git ?? ((cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim());
  const checkClean = options.checkClean ?? ((cwd: string) => { execFileSync('git', ['diff', '--quiet', 'HEAD'], { cwd }); });
  const computeFingerprint = options.fingerprint ?? schemaLevelFingerprint;

  assert.match(previous.ref, /^[a-f0-9]{40}$/);
  assert.match(previous.dataSchema, /^[a-f0-9]{64}$/);
  assert.match(previous.version, /^\d+\.\d+\.\d+$/);
  checkClean(previousRoot);
  const actualHead = runGit(previousRoot, 'rev-parse', 'HEAD');
  const actualTagRef = runGit(previousRoot, 'rev-parse', `v${previous.version}^{commit}`);
  const refCheck = verifyPreviousReleaseRef(previous, actualHead, actualTagRef);
  assert.equal(JSON.parse(await readFile(join(previousRoot, 'package.json'), 'utf8')).version, previous.version);
  const dataSchema = await computeFingerprint(previousRoot);
  assert.equal(dataSchema, previous.dataSchema);
  return { ...refCheck, dataSchema };
}
