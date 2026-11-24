import type { AuthorityKernel, AuthorityUse, CredentialProof, FinalExecution, InputManifest } from '../../packages/server/src/store/root-authority-contract.js';
import type { SecurityTx } from '../../packages/server/src/store/security-write.js';

export function checkProtectedWrite(kernel: AuthorityKernel, tx: SecurityTx, proof: CredentialProof, request: AuthorityUse): ReturnType<AuthorityKernel['authorizeWrite']> {
  return kernel.authorizeWrite(tx, proof, request);
}

export function recordAdmission(kernel: AuthorityKernel, tx: SecurityTx, subject: Parameters<AuthorityKernel['admitAttempt']>[1],
  invocation: Parameters<AuthorityKernel['admitAttempt']>[2], execution: FinalExecution, manifest: InputManifest,
  insert: () => FinalExecution): void {
  const admission = kernel.admitAttempt(tx, subject, invocation, execution, manifest);
  const inserted = insert();
  if (admission.eligibility === 'root') kernel.consumeAdmission(tx, admission.ticket, inserted, manifest);
}
