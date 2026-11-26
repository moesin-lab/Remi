import type { Context } from 'hono';
import type { AuthorityKernel, AuthorityUse, CredentialProof, CurrentAuthority } from '@multiremi/store/root-authority-contract.js';
import { SecurityAbort, type SecurityTx } from '@multiremi/store/security-write.js';
import type { MultiremiStore } from '@multiremi/store/store.js';
import { RootManagementRequestError } from '@multiremi/store/root-management.js';
import type { RootAttemptApproval } from '@multiremi/store/root-attempt-inputs.js';
import { currentJwtSigningDomain } from './jwt.js';

export type RegisteredProof = Extract<CredentialProof, { proofVersion: unknown }>;

declare module 'hono' {
  interface ContextVariableMap {
    multiremiMasterRootTransport: boolean;
    multiremiDelegatedPatTransport: boolean;
    multiremiRootProof: () => RegisteredProof | null;
  }
}

export function registeredRootProof(store: MultiremiStore, token: string, jwt: boolean): RegisteredProof | null {
  if (!store.jwtMaterials.isActive()) return null;
  const credentials = store.rootManagement.registeredCredentials;
  const signing = jwt ? currentJwtSigningDomain() : null;
  const proof = jwt ? signing && credentials.verifyJwt(token, signing) : credentials.verify(token);
  return proof?.kind === 'dependent' ? proof : null;
}

export function bindRootProof(c: Context, store: MultiremiStore, token: string, jwt: boolean): void {
  c.set('multiremiRootProof', () => registeredRootProof(store, token, jwt));
}

export function bindDelegatedPatForRootControl(c: Context, store: MultiremiStore, token: string): boolean {
  if (!token.startsWith('mul_') || !(c.req.path.startsWith('/api/root/') || c.req.path === '/api/cli/capabilities')) return false;
  const proof = registeredRootProof(store, token, false);
  if (!proof) return false;
  try {
    const authority = store.rootManagement.resolveCurrent(proof, { action: 'credential.pat.authenticate', use: 'read',
      actualTarget: { type: 'credential', id: proof.proofVersion.id } });
    if (authority.transport !== 'agent_pat' || !authority.effectiveRoot) return false;
  } catch (error) {
    if (error instanceof SecurityAbort && ['root_authority_revoked', 'credential_version_conflict'].includes(error.code)) return false;
    throw error;
  }
  c.set('multiremiDelegatedPatTransport', true);
  c.set('multiremiRootProof', () => proof);
  return true;
}

export function requireRootProof(c: Context): RegisteredProof {
  const proof = c.get('multiremiRootProof')?.();
  if (!proof) throw new SecurityAbort('root_required');
  return proof;
}

export function readRootAttemptApproval(value: unknown, includeSubmittedPrompt = false): RootAttemptApproval {
  if (value === undefined) return { messages: [], includeSubmittedPrompt };
  if (!Array.isArray(value)) throw new RootManagementRequestError(400, 'approved_input_messages must be an array');
  const messages = value.map(entry => {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).some(key => key !== 'id' && key !== 'version')
      || typeof entry.id !== 'string' || !entry.id.trim() || !Number.isSafeInteger(entry.version) || entry.version < 1) {
      throw new RootManagementRequestError(400, 'Invalid approved input message reference');
    }
    return { id: entry.id as string, version: entry.version as number };
  });
  if (new Set(messages.map(entry => entry.id)).size !== messages.length) throw new RootManagementRequestError(400, 'Duplicate approved input message');
  return { messages, includeSubmittedPrompt };
}

export function requestHasRootRead(c: Context, store: MultiremiStore, action: string, type: string, id: string): boolean {
  return !!effectiveRootProof(c, store, { action, actualTarget: { type, id }, use: 'read' });
}

export function effectiveRootProof(c: Context, store: MultiremiStore, use: AuthorityUse): RegisteredProof | null {
  const proof = c.get('multiremiRootProof')?.();
  if (!proof) return null;
  try {
    return store.rootManagement.resolveCurrent(proof, use).effectiveRoot ? proof : null;
  } catch (error) {
    if (error instanceof SecurityAbort && (error.code === 'root_authority_revoked' || error.code === 'credential_version_conflict')) return null;
    throw error;
  }
}

export function runRootMutation<T>(store: MultiremiStore, proof: RegisteredProof, use: AuthorityUse,
  operation: (tx: SecurityTx, actor: ReturnType<AuthorityKernel['authorizeWrite']>, current: CurrentAuthority) => T,
  workspaceIds: readonly string[] = []): T {
  const plan = store.rootManagement.plan(proof, use);
  return store.withAuthorizedMutation(proof, use, { ...plan, workspaceIds: [...new Set([...plan.workspaceIds, ...workspaceIds])].sort() }, (tx, actor) => {
    const current = store.rootManagement.requireMutationActor(tx, actor, use);
    return operation(tx, actor, current);
  });
}

export function guardRootResourceWrite<T>(c: Context, store: MultiremiStore, workspaceId: string,
  type: string, id: string, operation: () => T,
  options?: { version?: number; proof?: RegisteredProof | null; didWrite?: (result: T) => boolean }): T {
  if (!options?.proof && !store.jwtMaterials.isActive()) return operation();
  const root = store.rootManagement;
  const use: AuthorityUse = { action: 'protected-resource.write', use: 'write', actualTarget: { type, id } };
  const proof = c.req.method === 'GET' ? null : options?.proof ?? effectiveRootProof(c, store, use);
  const match = c.req.header('If-Match')?.match(/^"(0|[1-9]\d*)"$/);
  const expectedVersion = options?.version ?? (match ? Number(match[1]) : Number.NaN);
  const skipped: { result?: T } = {};
  const mutate = (tx: SecurityTx, actor: ReturnType<AuthorityKernel['authorizeWrite']> | null) => {
    root.guardProtectedMutation(tx, actor, use, expectedVersion);
    const result = operation();
    if (options?.didWrite && !options.didWrite(result)) {
      skipped.result = result;
      throw skipped;
    }
    return result;
  };
  try {
    if (proof) return runRootMutation(store, proof, use, mutate, [workspaceId]);
    const expectedRevision = root.readContext(null, 'open_local').security_revision;
    return store.withSecurityWrite(undefined, { expectedRevision, workspaceIds: [workspaceId], numberKeys: [],
      domainTargets: [`management:${type}:${id}`] }, tx => mutate(tx, null));
  } catch (error) {
    if (error === skipped) return skipped.result as T;
    throw error;
  }
}
