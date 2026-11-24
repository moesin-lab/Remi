import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  parsePublicErrorEnvelope,
  type CreateRootGrantRequest,
  type GrantRootRuntimeTrustRequest,
  type PublicErrorDetail,
  type RevokeCredentialFamilyRequest,
  type RevokeRootGrantRequest,
  type RevokeRootRuntimeTrustRequest,
} from "@multiremi/contracts/root-authority";
import { api, ApiError } from "../api";
import { rootKeys } from "./queries";

export function extractRootApiError(error: unknown): PublicErrorDetail | null {
  if (!(error instanceof ApiError)) return null;
  return parsePublicErrorEnvelope(error.body)?.error ?? null;
}

export function isAuthorityRevisionConflict(error: unknown): boolean {
  const detail = extractRootApiError(error);
  return detail?.code === "authority_revision_conflict"
    || (error instanceof ApiError && error.status === 409 && detail?.retryable === true);
}

export function useCreateRootGrant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateRootGrantRequest) => api.createRootGrant(data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: rootKeys.all });
    },
    onError: (error) => {
      if (isAuthorityRevisionConflict(error)) {
        void qc.invalidateQueries({ queryKey: rootKeys.all });
      }
    },
  });
}

export function useRevokeRootGrant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ grantId, data }: { grantId: string; data: RevokeRootGrantRequest }) =>
      api.revokeRootGrant(grantId, data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: rootKeys.all });
    },
    onError: (error) => {
      if (isAuthorityRevisionConflict(error)) {
        void qc.invalidateQueries({ queryKey: rootKeys.all });
      }
    },
  });
}

export function useGrantRootRuntimeTrust() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: GrantRootRuntimeTrustRequest) => api.grantRootRuntimeTrust(data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: rootKeys.all });
    },
    onError: (error) => {
      if (isAuthorityRevisionConflict(error)) {
        void qc.invalidateQueries({ queryKey: rootKeys.all });
      }
    },
  });
}

export function useRevokeRootRuntimeTrust() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ trustId, data }: { trustId: string; data: RevokeRootRuntimeTrustRequest }) =>
      api.revokeRootRuntimeTrust(trustId, data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: rootKeys.all });
    },
    onError: (error) => {
      if (isAuthorityRevisionConflict(error)) {
        void qc.invalidateQueries({ queryKey: rootKeys.all });
      }
    },
  });
}

export function useRevokeCredentialFamily() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ familyId, data }: { familyId: string; data: RevokeCredentialFamilyRequest }) =>
      api.revokeCredentialFamily(familyId, data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: rootKeys.all });
    },
    onError: (error) => {
      if (isAuthorityRevisionConflict(error)) {
        void qc.invalidateQueries({ queryKey: rootKeys.all });
      }
    },
  });
}
