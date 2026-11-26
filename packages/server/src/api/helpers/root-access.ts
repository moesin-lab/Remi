import type { Context } from 'hono';
import type { AuthorityUse, CredentialProof } from '@multiremi/store/root-authority-contract.js';
import { SecurityAbort } from '@multiremi/store/security-write.js';
import type { MultiremiStore } from '@multiremi/store/store.js';
import { currentJwtSigningDomain } from './jwt.js';

export type RegisteredProof = Extract<CredentialProof, { proofVersion: unknown }>;

declare module 'hono' {
  interface ContextVariableMap {
    multiremiMasterRootTransport: boolean;
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

export function requireRootProof(c: Context): RegisteredProof {
  const proof = c.get('multiremiRootProof')?.();
  if (!proof) throw new SecurityAbort('root_required');
  return proof;
}

export function requestHasRootRead(c: Context, store: MultiremiStore, action: string, type: string, id: string): boolean {
  const proof = c.get('multiremiRootProof')?.();
  if (!proof) return false;
  const use: AuthorityUse = { action, actualTarget: { type, id }, use: 'read' };
  try {
    return store.rootManagement.resolveCurrent(proof, use).effectiveRoot;
  } catch (error) {
    if (error instanceof SecurityAbort && (error.code === 'root_authority_revoked' || error.code === 'credential_version_conflict')) return false;
    throw error;
  }
}
