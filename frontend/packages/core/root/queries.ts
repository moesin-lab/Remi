import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

export const rootKeys = {
  all: ["root"] as const,
  context: () => ["root", "context"] as const,
  grants: (filters?: { subject_type?: "user" | "agent"; subject_id?: string; status?: string }) =>
    ["root", "grants", filters ?? {}] as const,
  runtimeTrusts: (filters?: { runtime_id?: string; status?: string }) =>
    ["root", "runtime-trust", filters ?? {}] as const,
  runtimeTrust: (runtimeId: string) => ["root", "runtime-trust", runtimeId] as const,
  audit: (filters?: { action?: string; target_type?: string; target_id?: string; actor_id?: string }) =>
    ["root", "audit", filters ?? {}] as const,
};

export function rootContextOptions() {
  return queryOptions({
    queryKey: rootKeys.context(),
    queryFn: () => api.getRootContext(),
    retry: false,
    staleTime: 15_000,
  });
}

export function rootGrantsOptions(filters?: {
  subject_type?: "user" | "agent";
  subject_id?: string;
  status?: string;
}) {
  return queryOptions({
    queryKey: rootKeys.grants(filters),
    queryFn: () => api.listRootGrants(filters),
    retry: false,
  });
}

export function rootRuntimeTrustListOptions(filters?: {
  runtime_id?: string;
  status?: string;
}) {
  return queryOptions({
    queryKey: rootKeys.runtimeTrusts(filters),
    queryFn: () => api.listRootRuntimeTrusts(filters),
    retry: false,
  });
}

export function rootAuditOptions(filters?: {
  action?: string;
  target_type?: string;
  target_id?: string;
  actor_id?: string;
}) {
  return queryOptions({
    queryKey: rootKeys.audit(filters),
    queryFn: () => api.listRootAudit(filters),
    retry: false,
  });
}
