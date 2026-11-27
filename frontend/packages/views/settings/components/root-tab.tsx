"use client";

import { useState } from "react";
import {
  AlertTriangle,
  KeyRound,
  RefreshCw,
  Server,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ROOT_SECURITY_REVOKE_REASONS,
  type RootExposedSecretNotice,
  type RootGrantRecord,
  type RootRuntimeTrustRecord,
  type RootSecurityRevokeReasonCode,
  type RootSubjectType,
} from "@multiremi/contracts/root-authority";
import {
  extractRootApiError,
  isAuthorityRevisionConflict,
  rootAuditOptions,
  rootContextOptions,
  rootGrantsOptions,
  rootKeys,
  rootRuntimeTrustListOptions,
  useCreateRootGrant,
  useGrantRootRuntimeTrust,
  useRevokeCredentialFamily,
  useRevokeRootGrant,
  useRevokeRootRuntimeTrust,
} from "@multiremi/core/root";
import { Button } from "@multiremi/ui/components/ui/button";
import { Card, CardContent } from "@multiremi/ui/components/ui/card";
import { Input } from "@multiremi/ui/components/ui/input";
import { Label } from "@multiremi/ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multiremi/ui/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@multiremi/ui/components/ui/alert-dialog";
import { toast } from "sonner";
import { useT } from "../../i18n";

function newIdempotencyKey(prefix: string): string {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${random}`;
}

function formatSubject(subject: { type: string; id: string } | null | undefined): string {
  if (!subject) return "-";
  return `${subject.type}:${subject.id}`;
}

export function RootTab() {
  const { t } = useT("settings");
  const qc = useQueryClient();

  const contextQuery = useQuery(rootContextOptions());
  const ctx = contextQuery.data;
  const canManageRoot = ctx?.capabilities.can_manage_root === true;
  const canManageTrust = ctx?.capabilities.can_manage_runtime_trust === true;
  const canRevokeFamily = ctx?.capabilities.can_revoke_credential_family === true;
  const canReadAudit = ctx?.capabilities.can_read_root_audit === true;

  const grantsQuery = useQuery({
    ...rootGrantsOptions(),
    enabled: canManageRoot,
  });
  const trustsQuery = useQuery({
    ...rootRuntimeTrustListOptions(),
    enabled: canManageTrust,
  });
  const auditQuery = useQuery({
    ...rootAuditOptions(),
    enabled: canReadAudit,
  });

  const createGrant = useCreateRootGrant();
  const revokeGrant = useRevokeRootGrant();
  const grantTrust = useGrantRootRuntimeTrust();
  const revokeTrust = useRevokeRootRuntimeTrust();
  const revokeFamily = useRevokeCredentialFamily();

  const [conflictRevision, setConflictRevision] = useState<number | null>(null);
  const [exposedSecrets, setExposedSecrets] = useState<readonly RootExposedSecretNotice[]>([]);
  const [lastRootWarning, setLastRootWarning] = useState(false);

  // Grant form state
  const [subjectType, setSubjectType] = useState<RootSubjectType>("agent");
  const [subjectId, setSubjectId] = useState("");
  const [grantReason, setGrantReason] = useState("");
  const [grantExpiresAt, setGrantExpiresAt] = useState("");
  const [grantTrustIds, setGrantTrustIds] = useState("");

  // Revoke grant dialog state
  const [revokeGrantTarget, setRevokeGrantTarget] = useState<RootGrantRecord | null>(null);
  const [revokeGrantReason, setRevokeGrantReason] = useState("");

  // Runtime trust form state
  const [trustRuntimeId, setTrustRuntimeId] = useState("");
  const [trustDaemonId, setTrustDaemonId] = useState("");
  const [trustIncarnation, setTrustIncarnation] = useState("");
  const [trustKeyId, setTrustKeyId] = useState("");
  const [trustKeyFingerprint, setTrustKeyFingerprint] = useState("");
  const [trustIsolationNote, setTrustIsolationNote] = useState("");
  const [trustReason, setTrustReason] = useState("");
  const [revokeTrustTarget, setRevokeTrustTarget] = useState<RootRuntimeTrustRecord | null>(null);
  const [revokeTrustReason, setRevokeTrustReason] = useState("");

  // Credential family revoke state
  const [familyId, setFamilyId] = useState("");
  const [familyReasonCode, setFamilyReasonCode] = useState<RootSecurityRevokeReasonCode>("operator_security_revoke");
  const [familyReason, setFamilyReason] = useState("");

  const currentRevision =
    grantsQuery.data?.security_revision
    ?? trustsQuery.data?.security_revision
    ?? ctx?.security_revision
    ?? 0;

  const refreshAll = async () => {
    setConflictRevision(null);
    await qc.invalidateQueries({ queryKey: rootKeys.all });
  };

  const handleMutationError = (error: unknown, fallback: string) => {
    if (isAuthorityRevisionConflict(error)) {
      const detail = extractRootApiError(error);
      setConflictRevision(detail?.currentRevision ?? null);
      toast.error(t(($) => $.root.conflict_toast));
      return;
    }
    const detail = extractRootApiError(error);
    toast.error(detail ? `${detail.code}: ${detail.message}` : error instanceof Error ? error.message : fallback);
  };

  const handleCreateGrant = async () => {
    if (!subjectId.trim() || !grantReason.trim()) return;
    try {
      const trustIds = grantTrustIds
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
      const res = await createGrant.mutateAsync({
        subject: { type: subjectType, id: subjectId.trim() },
        reason: grantReason.trim(),
        expected_revision: currentRevision,
        idempotency_key: newIdempotencyKey("ui_grant"),
        ...(grantExpiresAt.trim() ? { expires_at: grantExpiresAt.trim() } : {}),
        ...(trustIds.length > 0 ? { runtime_trust_ids: trustIds } : {}),
      });
      setConflictRevision(null);
      setSubjectId("");
      setGrantReason("");
      setGrantExpiresAt("");
      setGrantTrustIds("");
      if (res.replayed && !res.grant.effective) {
        toast.info(t(($) => $.root.grant_replayed_ineffective, { reason: res.grant.effective_reason_code }));
      } else {
        toast.success(t(($) => $.root.toast_grant_created));
      }
    } catch (error) {
      handleMutationError(error, t(($) => $.root.toast_grant_failed));
    }
  };

  const handleRevokeGrant = async () => {
    if (!revokeGrantTarget || !revokeGrantReason.trim()) return;
    try {
      const res = await revokeGrant.mutateAsync({
        grantId: revokeGrantTarget.id,
        data: {
          reason: revokeGrantReason.trim(),
          reason_code: "grant_revoked",
          expected_revision: currentRevision,
          idempotency_key: newIdempotencyKey("ui_revoke_grant"),
        },
      });
      setConflictRevision(null);
      setRevokeGrantTarget(null);
      setRevokeGrantReason("");
      setLastRootWarning(res.last_root_revoked === true);
      if (res.exposed_external_secrets_requiring_rotation?.length) {
        setExposedSecrets(res.exposed_external_secrets_requiring_rotation);
      }
      toast.success(
        t(($) => $.root.toast_grant_revoked, {
          count: res.affected_authority_count,
        }),
      );
    } catch (error) {
      handleMutationError(error, t(($) => $.root.toast_revoke_failed));
    }
  };

  const handleGrantTrust = async () => {
    if (
      !trustRuntimeId.trim()
      || !trustDaemonId.trim()
      || !trustIncarnation.trim()
      || !trustKeyId.trim()
      || !trustKeyFingerprint.trim()
      || !trustReason.trim()
    ) {
      return;
    }
    try {
      await grantTrust.mutateAsync({
        runtime_id: trustRuntimeId.trim(),
        daemon_id: trustDaemonId.trim(),
        incarnation: trustIncarnation.trim(),
        recipient_key_id: trustKeyId.trim(),
        recipient_key_fingerprint: trustKeyFingerprint.trim(),
        isolation_note: trustIsolationNote.trim() || null,
        reason: trustReason.trim(),
        expected_revision: currentRevision,
        idempotency_key: newIdempotencyKey("ui_grant_trust"),
      });
      setConflictRevision(null);
      setTrustRuntimeId("");
      setTrustDaemonId("");
      setTrustIncarnation("");
      setTrustKeyId("");
      setTrustKeyFingerprint("");
      setTrustIsolationNote("");
      setTrustReason("");
      toast.success(t(($) => $.root.toast_trust_granted));
    } catch (error) {
      handleMutationError(error, t(($) => $.root.toast_trust_failed));
    }
  };

  const handleRevokeTrust = async () => {
    if (!revokeTrustTarget || !revokeTrustReason.trim()) return;
    try {
      await revokeTrust.mutateAsync({
        trustId: revokeTrustTarget.id,
        data: {
          reason: revokeTrustReason.trim(),
          reason_code: "trust_revoked",
          expected_revision: currentRevision,
          idempotency_key: newIdempotencyKey("ui_revoke_trust"),
        },
      });
      setConflictRevision(null);
      setRevokeTrustTarget(null);
      setRevokeTrustReason("");
      toast.success(t(($) => $.root.toast_trust_revoked));
    } catch (error) {
      handleMutationError(error, t(($) => $.root.toast_trust_revoke_failed));
    }
  };

  const handleRevokeFamily = async () => {
    if (!familyId.trim() || !familyReason.trim()) return;
    try {
      const res = await revokeFamily.mutateAsync({
        familyId: familyId.trim(),
        data: {
          reason_code: familyReasonCode,
          reason: familyReason.trim(),
          expected_revision: currentRevision,
          idempotency_key: newIdempotencyKey("ui_revoke_family"),
        },
      });
      setConflictRevision(null);
      setFamilyId("");
      setFamilyReason("");
      if (res.exposed_external_secrets_requiring_rotation?.length) {
        setExposedSecrets(res.exposed_external_secrets_requiring_rotation);
      }
      toast.success(
        t(($) => $.root.toast_family_revoked, {
          count: res.affected_authority_count,
        }),
      );
    } catch (error) {
      handleMutationError(error, t(($) => $.root.toast_family_failed));
    }
  };

  const grants = grantsQuery.data?.grants ?? [];
  const trusts = trustsQuery.data?.trusts ?? [];
  const auditEntries = auditQuery.data?.entries ?? [];

  return (
    <div className="space-y-8" data-testid="root-authority-tab">
      {/* Authority Context Summary */}
      <section className="space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">{t(($) => $.root.title)}</h2>
          </div>
          <Button variant="outline" size="sm" onClick={() => void refreshAll()}>
            <RefreshCw className="h-3.5 w-3.5" />
            {t(($) => $.root.refresh)}
          </Button>
        </div>

        {conflictRevision !== null && (
          <div
            role="alert"
            data-testid="root-revision-conflict-banner"
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200"
          >
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>
                {t(($) => $.root.conflict_banner, { revision: conflictRevision })}
              </span>
            </div>
            <Button size="sm" variant="outline" onClick={() => void refreshAll()}>
              {t(($) => $.root.conflict_reload)}
            </Button>
          </div>
        )}

        {lastRootWarning && (
          <div
            role="status"
            data-testid="root-last-revoked-warning"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {t(($) => $.root.last_root_warning)}
          </div>
        )}

        {exposedSecrets.length > 0 && (
          <div
            role="status"
            data-testid="root-exposed-secrets-notice"
            className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200"
          >
            <p className="font-medium">{t(($) => $.root.exposed_secrets_title)}</p>
            <p>{t(($) => $.root.exposed_secrets_hint)}</p>
            <ul className="list-disc pl-4 space-y-0.5">
              {exposedSecrets.map((item, idx) => (
                <li key={`${item.target_type}:${item.target_id}:${idx}`}>
                  <code>{item.target_type}:{item.target_id}</code>
                  {item.secret_version ? ` (${item.secret_version})` : ""}
                  {item.note ? ` — ${item.note}` : ""}
                </li>
              ))}
            </ul>
          </div>
        )}

        <Card>
          <CardContent className="space-y-3 text-xs">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <div className="text-muted-foreground">{t(($) => $.root.label_subject)}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 font-mono">
                  <span data-testid="root-authenticated-subject">{formatSubject(ctx?.authenticated_subject)}</span>
                  {ctx?.is_agent_origin && (
                    <span
                      data-testid="root-agent-origin-badge"
                      className="rounded bg-amber-500/15 px-1.5 py-0.5 font-sans text-[10px] font-medium text-amber-700 dark:text-amber-300"
                    >
                      {t(($) => $.root.agent_origin_badge)}
                    </span>
                  )}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">{t(($) => $.root.label_revision)}</div>
                <div className="mt-0.5 font-mono" data-testid="root-security-revision">
                  rev {currentRevision} · {ctx?.transport_identity ?? "-"}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">{t(($) => $.root.label_granted_vs_effective)}</div>
                <div className="mt-0.5" data-testid="root-granted-vs-effective">
                  {ctx?.effective_root
                    ? t(($) => $.root.status_effective)
                    : ctx?.agent_granted_root && !ctx?.current_attempt_effective_root
                      ? t(($) => $.root.status_granted_not_effective, { reason: ctx.effective_reason_code })
                      : t(($) => $.root.status_not_effective, { reason: ctx?.effective_reason_code ?? "no_grant" })}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">{t(($) => $.root.label_provenance)}</div>
                <div className="mt-0.5 font-mono truncate">
                  {ctx?.family_id ? `family:${ctx.family_id}` : "-"}
                  {ctx?.origin_attempt_id ? ` · attempt:${ctx.origin_attempt_id}` : ""}
                </div>
              </div>
            </div>
            <p className="text-muted-foreground">{t(($) => $.root.server_reverify_note)}</p>
          </CardContent>
        </Card>
      </section>

      {/* Grants Management */}
      {canManageRoot && (
        <section className="space-y-4">
          <h3 className="text-sm font-semibold">{t(($) => $.root.grants_title)}</h3>

          <Card>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">{t(($) => $.root.grants_description)}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label className="text-xs text-muted-foreground">{t(($) => $.root.subject_type_label)}</Label>
                  <Select value={subjectType} onValueChange={(v) => { if (v === "user" || v === "agent") setSubjectType(v); }}>
                    <SelectTrigger size="sm" className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="agent">{t(($) => $.root.subject_type_agent)}</SelectItem>
                      <SelectItem value="user">{t(($) => $.root.subject_type_user)}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">{t(($) => $.root.subject_id_label)}</Label>
                  <Input
                    className="mt-1"
                    value={subjectId}
                    onChange={(e) => setSubjectId(e.target.value)}
                    placeholder={subjectType === "agent" ? "agt_..." : "usr_..."}
                  />
                </div>
                <div className="sm:col-span-2">
                  <Label className="text-xs text-muted-foreground">{t(($) => $.root.reason_label)}</Label>
                  <Input
                    className="mt-1"
                    value={grantReason}
                    onChange={(e) => setGrantReason(e.target.value)}
                    placeholder={t(($) => $.root.grant_reason_placeholder)}
                  />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">{t(($) => $.root.expires_at_label)}</Label>
                  <Input
                    className="mt-1"
                    value={grantExpiresAt}
                    onChange={(e) => setGrantExpiresAt(e.target.value)}
                    placeholder="2027-01-01T00:00:00Z"
                  />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">{t(($) => $.root.runtime_trust_ids_label)}</Label>
                  <Input
                    className="mt-1"
                    value={grantTrustIds}
                    onChange={(e) => setGrantTrustIds(e.target.value)}
                    placeholder="rtr_..."
                  />
                </div>
              </div>
              <div className="flex justify-end">
                <Button
                  size="sm"
                  onClick={() => void handleCreateGrant()}
                  disabled={createGrant.isPending || !subjectId.trim() || !grantReason.trim()}
                >
                  {createGrant.isPending ? t(($) => $.root.granting) : t(($) => $.root.grant_submit)}
                </Button>
              </div>
            </CardContent>
          </Card>

          <div className="space-y-2">
            {grants.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t(($) => $.root.grants_empty)}</p>
            ) : (
              grants.map((grant) => (
                <Card key={grant.id}>
                  <CardContent className="flex flex-wrap items-center justify-between gap-3 text-xs">
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-2 font-medium">
                        <span className="font-mono">{formatSubject(grant.subject)}</span>
                        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                          gen {grant.generation} · {grant.status}
                        </span>
                        <span
                          className={
                            grant.effective
                              ? "rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-300"
                              : "rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                          }
                        >
                          {grant.effective
                            ? t(($) => $.root.badge_effective)
                            : t(($) => $.root.badge_ineffective, { reason: grant.effective_reason_code })}
                        </span>
                      </div>
                      <div className="text-muted-foreground truncate">
                        {grant.reason} · issuer {formatSubject(grant.issuer)}
                        {grant.expires_at ? ` · expires ${grant.expires_at}` : ""}
                      </div>
                    </div>
                    {grant.status === "active" && (
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => {
                          setRevokeGrantTarget(grant);
                          setRevokeGrantReason("");
                        }}
                      >
                        <ShieldOff className="h-3.5 w-3.5" />
                        {t(($) => $.root.revoke_action)}
                      </Button>
                    )}
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </section>
      )}

      {/* Runtime Trust Management */}
      {canManageTrust && (
        <section className="space-y-4">
          <div className="flex items-center gap-2">
            <Server className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">{t(($) => $.root.trust_title)}</h3>
          </div>

          <Card>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">{t(($) => $.root.trust_description)}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label className="text-xs text-muted-foreground">{t(($) => $.root.trust_runtime_id)}</Label>
                  <Input className="mt-1" value={trustRuntimeId} onChange={(e) => setTrustRuntimeId(e.target.value)} placeholder="rt_..." />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">{t(($) => $.root.trust_daemon_id)}</Label>
                  <Input className="mt-1" value={trustDaemonId} onChange={(e) => setTrustDaemonId(e.target.value)} placeholder="dmn_..." />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">{t(($) => $.root.trust_incarnation)}</Label>
                  <Input className="mt-1" value={trustIncarnation} onChange={(e) => setTrustIncarnation(e.target.value)} placeholder="inc_..." />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">{t(($) => $.root.trust_key_id)}</Label>
                  <Input className="mt-1" value={trustKeyId} onChange={(e) => setTrustKeyId(e.target.value)} placeholder="rkey_..." />
                </div>
                <div className="sm:col-span-2">
                  <Label className="text-xs text-muted-foreground">{t(($) => $.root.trust_key_fingerprint)}</Label>
                  <Input className="mt-1" value={trustKeyFingerprint} onChange={(e) => setTrustKeyFingerprint(e.target.value)} placeholder="sha256:..." />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">{t(($) => $.root.trust_isolation_note)}</Label>
                  <Input className="mt-1" value={trustIsolationNote} onChange={(e) => setTrustIsolationNote(e.target.value)} />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">{t(($) => $.root.reason_label)}</Label>
                  <Input className="mt-1" value={trustReason} onChange={(e) => setTrustReason(e.target.value)} />
                </div>
              </div>
              <div className="flex justify-end">
                <Button
                  size="sm"
                  onClick={() => void handleGrantTrust()}
                  disabled={
                    grantTrust.isPending
                    || !trustRuntimeId.trim()
                    || !trustDaemonId.trim()
                    || !trustIncarnation.trim()
                    || !trustKeyId.trim()
                    || !trustKeyFingerprint.trim()
                    || !trustReason.trim()
                  }
                >
                  {grantTrust.isPending ? t(($) => $.root.granting) : t(($) => $.root.trust_grant_submit)}
                </Button>
              </div>
            </CardContent>
          </Card>

          <div className="space-y-2">
            {trusts.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t(($) => $.root.trust_empty)}</p>
            ) : (
              trusts.map((trust) => (
                <Card key={trust.id}>
                  <CardContent className="flex flex-wrap items-center justify-between gap-3 text-xs">
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-2 font-medium">
                        <span className="font-mono">{trust.runtime_id}</span>
                        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                          gen {trust.generation} · {trust.status}
                        </span>
                        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                          {trust.incarnation}
                        </span>
                      </div>
                      <div className="text-muted-foreground truncate">
                        daemon {trust.daemon_id} · key {trust.recipient_key_id}
                        {trust.immutable_env_carrier_verified ? " · immutable_run_env" : ""}
                      </div>
                    </div>
                    {trust.status === "active" && (
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => {
                          setRevokeTrustTarget(trust);
                          setRevokeTrustReason("");
                        }}
                      >
                        {t(($) => $.root.revoke_action)}
                      </Button>
                    )}
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </section>
      )}

      {/* Credential Family Security Revocation */}
      {canRevokeFamily && (
        <section className="space-y-4">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">{t(($) => $.root.family_title)}</h3>
          </div>

          <Card>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">{t(($) => $.root.family_description)}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label className="text-xs text-muted-foreground">{t(($) => $.root.family_id_label)}</Label>
                  <Input
                    className="mt-1"
                    value={familyId}
                    onChange={(e) => setFamilyId(e.target.value)}
                    placeholder="fam_..."
                  />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">{t(($) => $.root.family_reason_code_label)}</Label>
                  <Select
                    value={familyReasonCode}
                    onValueChange={(v) => {
                      if ((ROOT_SECURITY_REVOKE_REASONS as readonly string[]).includes(v ?? "")) {
                        setFamilyReasonCode(v as RootSecurityRevokeReasonCode);
                      }
                    }}
                  >
                    <SelectTrigger size="sm" className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {ROOT_SECURITY_REVOKE_REASONS.map((code) => (
                        <SelectItem key={code} value={code}>{code}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="sm:col-span-2">
                  <Label className="text-xs text-muted-foreground">{t(($) => $.root.reason_label)}</Label>
                  <Input
                    className="mt-1"
                    value={familyReason}
                    onChange={(e) => setFamilyReason(e.target.value)}
                    placeholder={t(($) => $.root.family_reason_placeholder)}
                  />
                </div>
              </div>
              <div className="flex justify-end">
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => void handleRevokeFamily()}
                  disabled={revokeFamily.isPending || !familyId.trim() || !familyReason.trim()}
                >
                  {revokeFamily.isPending ? t(($) => $.root.revoking) : t(($) => $.root.family_revoke_submit)}
                </Button>
              </div>
            </CardContent>
          </Card>
        </section>
      )}

      {/* Audit Log */}
      {canReadAudit && (
        <section className="space-y-4">
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">{t(($) => $.root.audit_title)}</h3>
          </div>
          {auditEntries.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t(($) => $.root.audit_empty)}</p>
          ) : (
            <div className="space-y-2">
              {auditEntries.map((entry) => (
                <Card key={entry.id}>
                  <CardContent className="space-y-1 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono font-medium">{entry.action}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                        {entry.outcome}
                      </span>
                    </div>
                    <div className="text-muted-foreground">
                      actor <span className="font-mono">{formatSubject(entry.actor)}</span> · target{" "}
                      <span className="font-mono">{entry.target_type}:{entry.target_id}</span>
                      {entry.after_revision !== null ? ` · rev ${entry.after_revision}` : ""}
                    </div>
                    {entry.reason && <div className="text-muted-foreground truncate">{entry.reason}</div>}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Revoke Grant Confirmation */}
      <AlertDialog
        open={revokeGrantTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRevokeGrantTarget(null);
            setRevokeGrantReason("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(($) => $.root.revoke_grant_dialog_title)}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(($) => $.root.revoke_grant_dialog_description, {
                subject: formatSubject(revokeGrantTarget?.subject),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">{t(($) => $.root.reason_label)}</Label>
            <Input
              value={revokeGrantReason}
              onChange={(e) => setRevokeGrantReason(e.target.value)}
              placeholder={t(($) => $.root.revoke_reason_placeholder)}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(($) => $.root.cancel)}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!revokeGrantReason.trim() || revokeGrant.isPending}
              onClick={() => void handleRevokeGrant()}
            >
              {t(($) => $.root.revoke_action)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Revoke Runtime Trust Confirmation */}
      <AlertDialog
        open={revokeTrustTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRevokeTrustTarget(null);
            setRevokeTrustReason("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(($) => $.root.revoke_trust_dialog_title)}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(($) => $.root.revoke_trust_dialog_description, {
                runtime: revokeTrustTarget?.runtime_id ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">{t(($) => $.root.reason_label)}</Label>
            <Input
              value={revokeTrustReason}
              onChange={(e) => setRevokeTrustReason(e.target.value)}
              placeholder={t(($) => $.root.revoke_reason_placeholder)}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(($) => $.root.cancel)}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!revokeTrustReason.trim() || revokeTrust.isPending}
              onClick={() => void handleRevokeTrust()}
            >
              {t(($) => $.root.revoke_action)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
