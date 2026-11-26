/** Shared candidate boundary checks, loaded only from the private fixed clone. */
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCandidateContext, verifyCandidate as verifySnapshot } from './run-schema-rollback.mjs';

const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function loadCandidateContext(contextPath, root = process.cwd()) {
  return readCandidateContext(contextPath, root, moduleRoot);
}
export async function verifyCandidate(context) {
  // Re-read and bind the control bytes on every boundary, including boundaries
  // after asynchronous work. The parent supplies their digest through its
  // whitelisted environment, not through the mutable context itself.
  const bound = await loadCandidateContext(resolve(context.runRoot, 'control/run-context.json'), context.candidateRoot);
  assert.deepEqual(bound, context, 'Candidate context changed after loading');
  return verifySnapshot(context);
}
