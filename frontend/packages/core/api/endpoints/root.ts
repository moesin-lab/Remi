import {
  ROOT_API_PATHS,
  type CreateRootGrantRequest,
  type CreateRootGrantResponse,
  type GetRootRuntimeTrustResponse,
  type GrantRootRuntimeTrustRequest,
  type GrantRootRuntimeTrustResponse,
  type ListRootAuditResponse,
  type ListRootGrantsResponse,
  type ListRootRuntimeTrustResponse,
  type RevokeCredentialFamilyRequest,
  type RevokeCredentialFamilyResponse,
  type RevokeRootGrantRequest,
  type RevokeRootGrantResponse,
  type RevokeRootRuntimeTrustRequest,
  type RevokeRootRuntimeTrustResponse,
  type RootContextResponse,
} from "@multiremi/contracts/root-authority";
import type { HttpClient } from "../http";
import { parseStrictResponse, parseWithFallback } from "../schema";
import {
  CreateRootGrantResponseSchema,
  EMPTY_ROOT_AUDIT_RESPONSE,
  EMPTY_ROOT_CONTEXT,
  EMPTY_ROOT_GRANTS_RESPONSE,
  EMPTY_ROOT_RUNTIME_TRUST_DETAIL,
  EMPTY_ROOT_RUNTIME_TRUST_LIST,
  GetRootRuntimeTrustResponseSchema,
  GrantRootRuntimeTrustResponseSchema,
  ListRootAuditResponseSchema,
  ListRootGrantsResponseSchema,
  ListRootRuntimeTrustResponseSchema,
  RevokeCredentialFamilyResponseSchema,
  RevokeRootGrantResponseSchema,
  RevokeRootRuntimeTrustResponseSchema,
  RootContextResponseSchema,
} from "../schemas/root";

export class RootEndpoints {
  constructor(readonly http: HttpClient) {}

  async getRootContext(): Promise<RootContextResponse> {
    const raw = await this.http.fetch<unknown>(ROOT_API_PATHS.context);
    return parseWithFallback(raw, RootContextResponseSchema, EMPTY_ROOT_CONTEXT, {
      endpoint: `GET ${ROOT_API_PATHS.context}`,
    });
  }

  async listRootGrants(params?: {
    subject_type?: "user" | "agent";
    subject_id?: string;
    status?: string;
    limit?: number;
    cursor?: string;
  }): Promise<ListRootGrantsResponse> {
    const search = new URLSearchParams();
    if (params?.subject_type) search.set("subject_type", params.subject_type);
    if (params?.subject_id) search.set("subject_id", params.subject_id);
    if (params?.status) search.set("status", params.status);
    if (params?.limit !== undefined) search.set("limit", String(params.limit));
    if (params?.cursor) search.set("cursor", params.cursor);
    const qs = search.toString();
    const raw = await this.http.fetch<unknown>(qs ? `${ROOT_API_PATHS.grants}?${qs}` : ROOT_API_PATHS.grants);
    return parseWithFallback(raw, ListRootGrantsResponseSchema, EMPTY_ROOT_GRANTS_RESPONSE, {
      endpoint: `GET ${ROOT_API_PATHS.grants}`,
    });
  }

  async createRootGrant(data: CreateRootGrantRequest): Promise<CreateRootGrantResponse> {
    const raw = await this.http.fetch<unknown>(ROOT_API_PATHS.grants, {
      method: "POST",
      extraHeaders: { "Idempotency-Key": data.idempotency_key },
      body: JSON.stringify(data),
    });
    return parseStrictResponse(raw, CreateRootGrantResponseSchema, {
      endpoint: `POST ${ROOT_API_PATHS.grants}`,
    });
  }

  async revokeRootGrant(grantId: string, data: RevokeRootGrantRequest): Promise<RevokeRootGrantResponse> {
    const path = ROOT_API_PATHS.grantRevoke(grantId);
    const raw = await this.http.fetch<unknown>(path, {
      method: "POST",
      extraHeaders: { "Idempotency-Key": data.idempotency_key },
      body: JSON.stringify(data),
    });
    return parseStrictResponse(raw, RevokeRootGrantResponseSchema, {
      endpoint: "POST /api/root/grants/:id/revoke",
    });
  }

  async listRootRuntimeTrusts(params?: {
    runtime_id?: string;
    status?: string;
    limit?: number;
    cursor?: string;
  }): Promise<ListRootRuntimeTrustResponse> {
    const search = new URLSearchParams();
    if (params?.runtime_id) search.set("runtime_id", params.runtime_id);
    if (params?.status) search.set("status", params.status);
    if (params?.limit !== undefined) search.set("limit", String(params.limit));
    if (params?.cursor) search.set("cursor", params.cursor);
    const qs = search.toString();
    const raw = await this.http.fetch<unknown>(
      qs ? `${ROOT_API_PATHS.runtimeTrustList}?${qs}` : ROOT_API_PATHS.runtimeTrustList,
    );
    return parseWithFallback(raw, ListRootRuntimeTrustResponseSchema, EMPTY_ROOT_RUNTIME_TRUST_LIST, {
      endpoint: `GET ${ROOT_API_PATHS.runtimeTrustList}`,
    });
  }

  async getRootRuntimeTrust(runtimeId: string): Promise<GetRootRuntimeTrustResponse> {
    const path = ROOT_API_PATHS.runtimeTrustGet(runtimeId);
    const raw = await this.http.fetch<unknown>(path);
    return parseWithFallback(
      raw,
      GetRootRuntimeTrustResponseSchema,
      { ...EMPTY_ROOT_RUNTIME_TRUST_DETAIL, runtime_id: runtimeId },
      { endpoint: "GET /api/root/runtime-trust/:runtimeId" },
    );
  }

  async grantRootRuntimeTrust(data: GrantRootRuntimeTrustRequest): Promise<GrantRootRuntimeTrustResponse> {
    const raw = await this.http.fetch<unknown>(ROOT_API_PATHS.runtimeTrustGrant, {
      method: "POST",
      extraHeaders: { "Idempotency-Key": data.idempotency_key },
      body: JSON.stringify(data),
    });
    return parseStrictResponse(raw, GrantRootRuntimeTrustResponseSchema, {
      endpoint: `POST ${ROOT_API_PATHS.runtimeTrustGrant}`,
    });
  }

  async revokeRootRuntimeTrust(
    trustId: string,
    data: RevokeRootRuntimeTrustRequest,
  ): Promise<RevokeRootRuntimeTrustResponse> {
    const path = ROOT_API_PATHS.runtimeTrustRevoke(trustId);
    const raw = await this.http.fetch<unknown>(path, {
      method: "POST",
      extraHeaders: { "Idempotency-Key": data.idempotency_key },
      body: JSON.stringify(data),
    });
    return parseStrictResponse(raw, RevokeRootRuntimeTrustResponseSchema, {
      endpoint: "POST /api/root/runtime-trust/:id/revoke",
    });
  }

  async revokeCredentialFamily(
    familyId: string,
    data: RevokeCredentialFamilyRequest,
  ): Promise<RevokeCredentialFamilyResponse> {
    const path = ROOT_API_PATHS.credentialFamilyRevoke(familyId);
    const raw = await this.http.fetch<unknown>(path, {
      method: "POST",
      extraHeaders: { "Idempotency-Key": data.idempotency_key },
      body: JSON.stringify(data),
    });
    return parseStrictResponse(raw, RevokeCredentialFamilyResponseSchema, {
      endpoint: "POST /api/root/credential-families/:familyId/revoke",
    });
  }

  async listRootAudit(params?: {
    action?: string;
    target_type?: string;
    target_id?: string;
    actor_id?: string;
    limit?: number;
    cursor?: string;
  }): Promise<ListRootAuditResponse> {
    const search = new URLSearchParams();
    if (params?.action) search.set("action", params.action);
    if (params?.target_type) search.set("target_type", params.target_type);
    if (params?.target_id) search.set("target_id", params.target_id);
    if (params?.actor_id) search.set("actor_id", params.actor_id);
    if (params?.limit !== undefined) search.set("limit", String(params.limit));
    if (params?.cursor) search.set("cursor", params.cursor);
    const qs = search.toString();
    const raw = await this.http.fetch<unknown>(qs ? `${ROOT_API_PATHS.audit}?${qs}` : ROOT_API_PATHS.audit);
    return parseWithFallback(raw, ListRootAuditResponseSchema, EMPTY_ROOT_AUDIT_RESPONSE, {
      endpoint: `GET ${ROOT_API_PATHS.audit}`,
    });
  }
}
