import type { Context, Hono } from 'hono';
import {
  createPublicErrorEnvelope, isRootPublicErrorCode, ROOT_API_PATHS, ROOT_PUBLIC_ERROR_HTTP_STATUS, ROOT_SECURITY_REVOKE_REASONS,
  type CreateRootGrantRequest, type GrantRootRuntimeTrustRequest, type RevokeCredentialFamilyRequest,
  type RevokeRootGrantRequest, type RevokeRootRuntimeTrustRequest,
} from '@multiremi/contracts/root-authority.js';
import type { AuthorityKernel, AuthorityUse } from '@multiremi/store/root-authority-contract.js';
import { JwtMaterialUnavailable } from '@multiremi/store/jwt-materials.js';
import { RootManagementRequestError } from '@multiremi/store/root-management.js';
import { SecurityAbort, type SecurityTx } from '@multiremi/store/security-write.js';
import type { MultiremiStore } from '@multiremi/store/store.js';
import { requireRootProof, type RegisteredProof } from '../helpers/root-access.js';
import { currentAuth } from '../wire/context.js';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RootManagementRequestError(400, 'Expected a JSON object');
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new RootManagementRequestError(400, `Invalid ${field}`);
  return value;
}

function optionalText(value: unknown, field: string): string | null | undefined {
  return value == null ? value : text(value, field);
}

function common(body: Record<string, unknown>) {
  const expectedRevision = body.expected_revision;
  if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new RootManagementRequestError(400, 'Invalid expected_revision');
  }
  return { expected_revision: expectedRevision, reason: text(body.reason, 'reason'), idempotency_key: text(body.idempotency_key, 'idempotency_key') };
}

function revocation(body: Record<string, unknown>): RevokeRootGrantRequest {
  const value = body.reason_code;
  const reasonCode = ROOT_SECURITY_REVOKE_REASONS.find(code => code === value);
  if (value !== undefined && !reasonCode) throw new RootManagementRequestError(400, 'Invalid reason_code');
  return { ...common(body), ...(reasonCode && { reason_code: reasonCode }) };
}

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  return record(await c.req.json().catch(() => null));
}

export function rootError(c: Context, error: unknown): Response | null {
  if (error instanceof RootManagementRequestError) {
    return c.json(createPublicErrorEnvelope({ code: error.status === 404 ? 'not_found' : 'invalid_request', message: error.message, requestId: crypto.randomUUID() }), error.status);
  }
  if (!(error instanceof SecurityAbort) && !(error instanceof JwtMaterialUnavailable)) return null;
  const code = error instanceof SecurityAbort && isRootPublicErrorCode(error.code) ? error.code : 'security_state_unavailable';
  const status = ROOT_PUBLIC_ERROR_HTTP_STATUS[code];
  return c.json(createPublicErrorEnvelope({ code, message: code, requestId: crypto.randomUUID() }), status);
}

function mutate<T>(c: Context, store: MultiremiStore, proof: RegisteredProof, action: string, type: string, id: string,
  operation: (tx: SecurityTx, actor: ReturnType<AuthorityKernel['authorizeWrite']>) => T): Response {
  const use: AuthorityUse = { action, actualTarget: { type, id }, use: 'management' };
  const plan = store.rootManagement.plan(proof, use);
  const result = store.withAuthorizedMutation(proof, use, plan, (tx, actor) => {
    store.rootManagement.requireMutationActor(tx, actor, use);
    return operation(tx, actor);
  });
  return c.json(result);
}

function page(c: Context) {
  const limit = Number(c.req.query('limit') ?? 50);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RootManagementRequestError(400, 'Invalid limit');
  return { limit, cursor: c.req.query('cursor') ?? '' };
}

export function registerRootRoutes(app: Hono, store: MultiremiStore): void {
  const root = store.rootManagement;
  app.use('/api/root/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });

  app.get(ROOT_API_PATHS.context, c => {
    const auth = currentAuth(c);
    const proof = c.get('multiremiRootProof')?.() ?? null;
    return c.json(root.readContext(proof, auth.accessToken?.type === 'task' ? 'task'
      : auth.accessToken?.type === 'daemon' ? 'daemon' : auth.userId ? 'human' : c.get('multiremiMasterRootTransport') ? 'master' : 'open_local'));
  });

  app.get(ROOT_API_PATHS.grants, c => c.json(root.listRootGrants(requireRootProof(c), {
    ...page(c), subjectType: c.req.query('subject_type') ?? '', subjectId: c.req.query('subject_id') ?? '', status: c.req.query('status') ?? '',
  })));
  app.get(ROOT_API_PATHS.runtimeTrustList, c => c.json(root.listRootRuntimeTrust(requireRootProof(c), {
    ...page(c), runtimeId: c.req.query('runtime_id') ?? '', status: c.req.query('status') ?? '',
  })));
  app.get('/api/root/runtime-trust/:runtimeId', c => c.json(root.readRootRuntimeTrust(requireRootProof(c), c.req.param('runtimeId'))));
  app.get(ROOT_API_PATHS.audit, c => {
    const proof = requireRootProof(c);
    const { limit, cursor } = page(c);
    const revision = cursor === '' ? Number.MAX_SAFE_INTEGER : Number(cursor);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new RootManagementRequestError(400, 'Invalid cursor');
    return c.json(root.listRootAudit(proof, { limit, cursor: revision, action: c.req.query('action') ?? '',
      targetId: c.req.query('target_id') ?? '', actorId: c.req.query('actor_id') ?? '' }));
  });

  app.post(ROOT_API_PATHS.grants, async c => {
    const proof = requireRootProof(c);
    const body = await jsonBody(c);
    const subject = record(body.subject);
    if (subject.type !== 'user') throw new SecurityAbort('root_required');
    if (body.runtime_trust_ids !== undefined || body.accepted_dependency_digest != null) {
      throw new RootManagementRequestError(400, 'Human grants do not accept execution dependencies');
    }
    const input: CreateRootGrantRequest = {
      ...common(body), subject: { type: 'user', id: text(subject.id, 'subject.id') }, expires_at: optionalText(body.expires_at, 'expires_at'),
    };
    return mutate(c, store, proof, 'root.grant.create', 'user', input.subject.id, (tx, actor) => root.grant(tx, actor, input));
  });

  app.post('/api/root/grants/:id/revoke', async c => {
    const proof = requireRootProof(c);
    const id = c.req.param('id');
    const input = revocation(await jsonBody(c));
    return mutate(c, store, proof, 'root.grant.revoke', 'grant', id, (tx, actor) => root.revokeGrant(tx, actor, id, input));
  });

  app.post(ROOT_API_PATHS.runtimeTrustGrant, async c => {
    const proof = requireRootProof(c);
    const body = await jsonBody(c);
    const input: GrantRootRuntimeTrustRequest = {
      ...common(body), runtime_id: text(body.runtime_id, 'runtime_id'), daemon_id: text(body.daemon_id, 'daemon_id'),
      incarnation: text(body.incarnation, 'incarnation'), recipient_key_id: text(body.recipient_key_id, 'recipient_key_id'),
      recipient_key_fingerprint: text(body.recipient_key_fingerprint, 'recipient_key_fingerprint'),
      recipient_key_expires_at: optionalText(body.recipient_key_expires_at, 'recipient_key_expires_at'),
      challenge_id: text(body.challenge_id, 'challenge_id'), challenge_response: text(body.challenge_response, 'challenge_response'),
      isolation_note: optionalText(body.isolation_note, 'isolation_note'), expires_at: optionalText(body.expires_at, 'expires_at'),
    };
    return mutate(c, store, proof, 'root.runtime-trust.grant', 'runtime', input.runtime_id, (tx, actor) => root.grantRuntimeTrust(tx, actor, input));
  });

  app.post('/api/root/runtime-trust/:id/revoke', async c => {
    const proof = requireRootProof(c);
    const id = c.req.param('id');
    const input: RevokeRootRuntimeTrustRequest = revocation(await jsonBody(c));
    return mutate(c, store, proof, 'root.runtime-trust.revoke', 'runtime_trust', id, (tx, actor) => root.revokeRuntimeTrust(tx, actor, id, input));
  });

  app.post('/api/root/credential-families/:familyId/revoke', async c => {
    const proof = requireRootProof(c);
    const id = c.req.param('familyId');
    const fields = revocation(await jsonBody(c));
    if (!fields.reason_code) throw new RootManagementRequestError(400, 'Missing reason_code');
    const input: RevokeCredentialFamilyRequest = { ...fields, reason_code: fields.reason_code };
    return mutate(c, store, proof, 'root.credential-family.revoke', 'credential_family', id, (tx, actor) => root.revokeFamily(tx, actor, id, input));
  });
}
