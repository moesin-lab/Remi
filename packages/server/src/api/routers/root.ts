import { createHash } from 'node:crypto';
import type { Context, Hono } from 'hono';
import {
  createPublicErrorEnvelope, isRootPublicErrorCode, ROOT_API_PATHS, ROOT_PUBLIC_ERROR_HTTP_STATUS, ROOT_SECURITY_REVOKE_REASONS,
  type CreateRootGrantRequest, type GrantRootRuntimeTrustRequest, type RevokeCredentialFamilyRequest,
  type RevokeRootGrantRequest, type RevokeRootRuntimeTrustRequest,
} from '@multiremi/contracts/root-authority.js';
import type { AuthorityKernel, AuthorityUse } from '@multiremi/store/root-authority-contract.js';
import type { AgentDependencyRef } from '@multiremi/store/agent-dependencies.js';
import { PreparedAgentPat, type DelegationUse } from '@multiremi/store/durable-delegation.js';
import { JwtMaterialUnavailable } from '@multiremi/store/jwt-materials.js';
import { RootManagementRequestError } from '@multiremi/store/root-management.js';
import { SecurityAbort, type SecurityTx } from '@multiremi/store/security-write.js';
import type { MultiremiStore } from '@multiremi/store/store.js';
import { requireRootProof, runRootMutation, type RegisteredProof } from '../helpers/root-access.js';
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

function array<T>(value: unknown, field: string, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new RootManagementRequestError(400, `Invalid ${field}`);
  return value.map(parse);
}

function revision(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RootManagementRequestError(400, `Invalid ${field}`);
  }
  return value;
}

function dependencyRef(value: unknown): AgentDependencyRef {
  const ref = record(value);
  return { kind: text(ref.kind, 'kind'), id: text(ref.id, 'id'), use: text(ref.use, 'use'),
    version: revision(ref.version, 'version'), digest: text(ref.digest, 'digest') };
}

function trustIds(value: unknown): string[] {
  const ids = array(value, 'runtime_trust_ids', id => text(id, 'trust ID'));
  if (!ids.length || new Set(ids).size !== ids.length) throw new RootManagementRequestError(400, 'Expected distinct runtime trust IDs');
  return ids;
}

function common(body: Record<string, unknown>) {
  return { expected_revision: revision(body.expected_revision, 'expected_revision'), reason: text(body.reason, 'reason'), idempotency_key: text(body.idempotency_key, 'idempotency_key') };
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
  return c.json(runRootMutation(store, proof, use, operation));
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

  app.get('/api/root/agents/:agentId/grant-preview', c => {
    const proof = requireRootProof(c);
    const agentId = c.req.param('agentId');
    const use: AuthorityUse = { action: 'root.grant.preview', use: 'read', actualTarget: { type: 'agent', id: agentId } };
    const authority = root.resolveCurrent(proof, use);
    if (!authority.effectiveRoot) throw new SecurityAbort('root_required');
    const snapshot = root.previewAgentGrant(proof, agentId, trustIds(c.req.queries('runtime_trust_id') ?? []));
    return c.json({ ...snapshot, expected_revision: authority.checkedRevision });
  });

  app.post('/api/root/agents/:agentId/configuration/approve', async c => {
    const proof = requireRootProof(c);
    const agentId = c.req.param('agentId');
    const body = await jsonBody(c);
    const expectedEpoch = body.expected_epoch === null ? null : revision(body.expected_epoch, 'expected_epoch');
    const sources = array(body.sources, 'sources', value => {
      const entry = record(value);
      if (typeof entry.content !== 'string') throw new RootManagementRequestError(400, 'Invalid source content');
      return { ref: dependencyRef(entry.ref), content: entry.content, dependencies: array(entry.dependencies, 'dependencies', dependencyRef) };
    });
    const executions = array(body.executions, 'executions', value => {
      const entry = record(value);
      return { trustId: text(entry.trustId, 'trustId'), profileDigest: text(entry.profileDigest, 'profileDigest'),
        provider: dependencyRef(entry.provider), checkpointPolicy: dependencyRef(entry.checkpointPolicy), inputPolicy: dependencyRef(entry.inputPolicy) };
    });
    const use: AuthorityUse = { action: 'root.agent-configuration.approve', use: 'write', actualTarget: { type: 'agent', id: agentId } };
    if (!root.resolveCurrent(proof, use).effectiveRoot) throw new SecurityAbort('root_required');
    const plan = root.planAgentGrant(proof, agentId, trustIds(executions.map(entry => entry.trustId)));
    return c.json(store.withAuthorizedMutation(proof, use, plan, (tx, actor) =>
      root.approveAgentConfiguration(tx, actor, agentId, expectedEpoch, { sources, executions })));
  });

  app.post(ROOT_API_PATHS.grants, async c => {
    const proof = requireRootProof(c);
    const body = await jsonBody(c);
    const subject = record(body.subject);
    if (subject.type !== 'user' && subject.type !== 'agent') throw new RootManagementRequestError(400, 'Invalid subject.type');
    if (subject.type === 'user' && (body.runtime_trust_ids !== undefined || body.accepted_dependency_digest != null)) {
      throw new RootManagementRequestError(400, 'Human grants do not accept execution dependencies');
    }
    const input: CreateRootGrantRequest = {
      ...common(body), subject: { type: subject.type, id: text(subject.id, 'subject.id') }, expires_at: optionalText(body.expires_at, 'expires_at'),
      ...(subject.type === 'agent' && { runtime_trust_ids: trustIds(body.runtime_trust_ids),
        accepted_dependency_digest: text(body.accepted_dependency_digest, 'accepted_dependency_digest') }),
    };
    if (input.subject.type === 'agent') {
      const use: AuthorityUse = { action: 'root.grant.create', use: 'management', actualTarget: input.subject };
      if (!root.resolveCurrent(proof, use).effectiveRoot) throw new SecurityAbort('root_required');
      const plan = root.planAgentGrant(proof, input.subject.id, input.runtime_trust_ids ?? []);
      return c.json(store.withAuthorizedMutation(proof, use, plan, (tx, actor) => root.grant(tx, actor, input)));
    }
    return mutate(c, store, proof, 'root.grant.create', 'user', input.subject.id, (tx, actor) => root.grant(tx, actor, input));
  });

  app.post('/api/root/grants/:id/revoke', async c => {
    const proof = requireRootProof(c);
    const id = c.req.param('id');
    const input = revocation(await jsonBody(c));
    return mutate(c, store, proof, 'root.grant.revoke', 'grant', id, (tx, actor) => root.revokeGrant(tx, actor, id, input));
  });

  app.post(ROOT_API_PATHS.agentPatCreate, async c => {
    const proof = requireRootProof(c);
    const body = await jsonBody(c);
    const auth = currentAuth(c);
    if (auth.accessToken?.type !== 'task' || !auth.accessToken.agentId) throw new SecurityAbort('root_required');
    const beneficiary = { type: 'agent' as const, id: auth.accessToken.agentId };
    const expiresAtMs = Date.parse(text(body.expires_at, 'expires_at'));
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= Date.now()) throw new RootManagementRequestError(400, 'Invalid expires_at');
    const use: DelegationUse = { action: 'credential.pat.create', use: 'write', actualTarget: beneficiary,
      idempotencyKey: text(body.idempotency_key, 'idempotency_key'), expiresAtMs,
      requestDigest: createHash('sha256').update(JSON.stringify([beneficiary.id, expiresAtMs])).digest('hex') };
    const candidate = PreparedAgentPat.prepare();
    const plan = root.plan(proof, use);
    const result = store.withAuthorizedMutation(proof, use, {
      ...plan, domainTargets: [...plan.domainTargets, `credential:${candidate.credentialId}`].sort(),
    }, (tx, actor) => {
      const origin = root.resolveDurableDelegation(tx, actor, use, beneficiary);
      const issued = root.issue(tx, { kind: 'delegated-pat', actor, use, beneficiary, candidate });
      return { id: issued.credential.id, family_id: issued.familyId, origin_id: origin.nodeId,
        token_prefix: candidate.tokenPrefix, expires_at: new Date(issued.expiresAtMs).toISOString() };
    });
    const token = candidate.takeCommittedToken();
    if (!token) throw new SecurityAbort('security_state_unavailable');
    return c.json({ ...result, token }, 201);
  });

  app.post('/api/root/delegations/:nodeId/revoke', async c => {
    const proof = requireRootProof(c);
    const id = c.req.param('nodeId');
    const input = revocation(await jsonBody(c));
    if (!input.reason_code) throw new RootManagementRequestError(400, 'Missing reason_code');
    return mutate(c, store, proof, 'root.delegation.revoke', 'durable_delegation', id, (tx, actor) =>
      ({ security_revision: root.revokeDurableDelegation(tx, actor, id, input) }));
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
