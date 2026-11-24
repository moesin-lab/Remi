import type { MultiremiStore } from "@multiremi/store/store.js";
import type { MultiremiScmRepositoryBinding, MultiremiScmSyncCursor } from "@multiremi/contracts/types.js";
import { CodebaseScmProviderAdapter, CodebaseScmProviderError } from "./codebase.js";
import { GitHubScmOperations, ScmOperationError, type ScmOperationContext } from "./operations.js";
import { ScmHttpError } from "./http.js";
import { matchScmRepositoryBindings } from "./repository-reference.js";
import type { ScmEntityObservation } from "./types.js";

export class ScmBindingError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 403 | 404 | 409 | 502 | 503 | 504) {
    super(message);
  }
}

export type ChangeRequestReference = { url: string } | { repository: string; number: number };

export function parseChangeRequestReference(value: unknown): ChangeRequestReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidReference();
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !["url", "repository", "number"].includes(key))) throw invalidReference();
  if (typeof body.url === "string" && body.repository === undefined && body.number === undefined) {
    parseChangeRequestUrl(body.url);
    return { url: body.url };
  }
  if (body.url === undefined && typeof body.repository === "string" && body.repository
    && Number.isSafeInteger(body.number) && Number(body.number) > 0) {
    return { repository: body.repository, number: Number(body.number) };
  }
  throw invalidReference();
}

/** Parse coordinates only. Provider requests are always built from persisted configuration. */
export function parseChangeRequestUrl(value: string): { repository: string; number: number; provider: "github" | "codebase" } {
  if (value !== value.trim() || /[\x00-\x20\x7f\\%]/u.test(value)
    || !/^https:\/\/[^/\\?#@\s]+\//iu.test(value)) throw invalidReference();
  let url: URL;
  try { url = new URL(value); } catch { throw invalidReference(); }
  if (url.username || url.password || url.search || url.hash) throw invalidReference();
  // Reject dot-segment normalization, trailing slashes, extra suffixes, and encoded separators.
  const path = value.slice(value.indexOf("/", "https://".length));
  if (path !== url.pathname) throw invalidReference();
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/(pull|merge_requests)\/([1-9]\d*)$/u);
  if (!match || [match[1], match[2]].some(part => part === "." || part === ".." || part?.endsWith(".git"))) throw invalidReference();
  const number = Number(match[4]);
  if (!Number.isSafeInteger(number)) throw invalidReference();
  return { repository: `${url.origin}/${match[1]}/${match[2]}`, number, provider: match[3] === "pull" ? "github" : "codebase" };
}

export async function bindScmChangeRequestReference(input: {
  store: MultiremiStore;
  issueId: string;
  workspaceId: string;
  reference: ChangeRequestReference;
  signal?: AbortSignal;
}) {
  const { store, issueId, workspaceId, reference } = input;
  const issue = store.getIssue(issueId);
  if (!issue) throw new ScmBindingError("scm_issue_not_found", "Issue not found", 404);
  if (issue.workspaceId !== workspaceId) throw new ScmOperationError("scm_binding_conflict", "Issue workspace changed; retry the reference");
  const parsed = "url" in reference ? parseChangeRequestUrl(reference.url) : reference;
  const matches = matchScmRepositoryBindings(
    store.listScmRepositoryBindings({ workspaceId, enabled: true }), parsed.repository,
  );
  if (matches.length !== 1) throw new ScmBindingError(
    matches.length ? "scm_reference_ambiguous" : "scm_binding_not_found",
    matches.length ? "SCM repository reference is ambiguous; use a repository ID or URL" : "Enabled SCM repository binding not found",
    matches.length ? 409 : 404,
  );
  const binding = matches[0]!;
  const prepared = store.prepareScmChangeRequestBinding(workspaceId, issueId, binding.connectionId, binding.repositoryId, parsed.number);
  const { connection } = prepared.target;
  if ("provider" in parsed && connection.provider !== parsed.provider) throw invalidReference();
  let observation: ScmEntityObservation | undefined;
  if (!prepared.changeRequest) {
    if (!prepared.credential?.accessToken?.trim()) {
      throw new ScmBindingError("scm_credentials_unavailable", "SCM connection credentials are required", 503);
    }
    observation = await readChangeRequest({
      connection, binding: prepared.target.binding, credential: prepared.credential, signal: input.signal,
    }, parsed.number);
    if (observation.entityType !== "change_request" || observation.payload.number !== parsed.number || !observation.externalId) {
      throw new ScmBindingError("scm_invalid_response", "SCM provider returned a different or incomplete change request", 502);
    }
    if (connection.provider === "github"
      && observation.payload.base_repository_full_name !== `${binding.owner}/${binding.name}`.toLowerCase()) {
      throw new ScmBindingError("scm_invalid_response", "SCM provider returned a different target repository", 502);
    }
  }
  return store.bindScmChangeRequestByReference({
    issueId, target: prepared.target, number: parsed.number, observation,
  });
}

export async function readChangeRequest(context: ScmOperationContext, number: number): Promise<ScmEntityObservation> {
  const signal = context.signal
    ? AbortSignal.any([context.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
  try {
    if (context.connection.provider === "github") return await new GitHubScmOperations({ ...context, signal }).get(number);
    if (context.connection.provider !== "codebase") {
      throw new ScmOperationError("scm_capability_unavailable", "SCM reference lookup is unavailable for this provider");
    }
    const adapter = new CodebaseScmProviderAdapter();
    let cursor: MultiremiScmSyncCursor | null = null;
    for (let page = 0; page < 20; page++) {
      signal.throwIfAborted();
      const result = await adapter.poll({ ...context, signal, stream: "change_requests", now: new Date(), cursor });
      const matches = result.observations.filter(item => item.payload.number === number);
      if (matches.length > 1) throw new ScmBindingError("scm_reference_ambiguous", "Provider returned multiple change requests for this number", 409);
      if (matches[0]) return matches[0];
      if (result.done) throw new ScmBindingError("scm_change_request_not_found", "SCM change request not found", 404);
      cursor = lookupCursor(context.binding, result.cursor);
    }
    throw new ScmBindingError("scm_pagination_limit", "SCM lookup pagination limit reached; the search is incomplete", 502);
  } catch (error) {
    if (error instanceof ScmBindingError) throw error;
    if (error instanceof ScmOperationError) {
      if (error.code === "scm_invalid_response") throw new ScmBindingError(error.code, "SCM provider returned an incomplete change request", 502);
      throw error;
    }
    if (error instanceof CodebaseScmProviderError) {
      if (/rate|throttl|quota|limit/iu.test(error.code)) {
        throw new ScmBindingError("scm_rate_limited", "SCM provider rate limit exceeded; retry later", 502);
      }
      if (/auth|forbidden|denied|permission|token/iu.test(error.code)) {
        throw new ScmBindingError("scm_provider_forbidden", "SCM connection cannot read this change request", 403);
      }
      if (/not.?found/iu.test(error.code)) {
        throw new ScmBindingError("scm_change_request_not_found", "SCM change request not found or not visible to the connection", 404);
      }
      throw new ScmBindingError("scm_provider_error", "SCM provider lookup failed", 502);
    }
    if (error instanceof ScmHttpError) {
      if (error.rateLimited) throw error;
      if ([401, 403].includes(error.status)) throw new ScmBindingError("scm_provider_forbidden", "SCM connection cannot read this change request", 403);
      if (error.status === 404) throw new ScmBindingError("scm_change_request_not_found", "SCM change request not found or not visible to the connection", 404);
      throw error;
    }
    if (signal.aborted || (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name))) {
      throw new ScmBindingError("scm_lookup_timeout", "SCM lookup interrupted; retry the same reference", 504);
    }
    // Do not expose provider envelope messages, request URLs, or fetch error details.
    throw new ScmBindingError("scm_provider_error", "SCM provider lookup failed", 502);
  }
}

function lookupCursor(binding: MultiremiScmRepositoryBinding, cursor: Record<string, unknown> | null): MultiremiScmSyncCursor {
  return {
    connectionId: binding.connectionId, repositoryId: binding.repositoryId, stream: "change_requests",
    cursor, watermark: null, baselineCompletedAt: null, lastStartedAt: null, lastCompletedAt: null,
    lastError: null, consecutiveFailures: 0, suspendedUntil: null, leaseOwner: null, leaseUntil: null,
    leaseToken: null, updatedAt: new Date().toISOString(),
  };
}

function invalidReference(): ScmBindingError {
  return new ScmBindingError("scm_reference_invalid", "Provide a PR/MR HTTPS URL or repository and positive integer number, exclusively", 400);
}
