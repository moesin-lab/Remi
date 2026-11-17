"use client";

import { DEFAULT_CO_AUTHORED_BY, formatCoAuthoredByTrailer, validateCoAuthoredByName, validateCoAuthoredByEmail } from "@multiremi/contracts/co-authored-by";
import { Input } from "@multiremi/ui/components/ui/input";
import { workspaceOperatorUser } from "@multiremi/core/workspace/operator";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  ExternalLink,
  GitCommitHorizontal,
  Link2,
  PanelRight,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@multiremi/ui/components/ui/button";
import { Card, CardContent } from "@multiremi/ui/components/ui/card";
import { Label } from "@multiremi/ui/components/ui/label";
import { Switch } from "@multiremi/ui/components/ui/switch";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useCurrentWorkspace, useWorkspacePaths } from "@multiremi/core/paths";
import { deriveScmSettings } from "@multiremi/core/scm";
import { memberListOptions, workspaceKeys } from "@multiremi/core/workspace/queries";
import { api } from "@multiremi/core/api";
import type { Workspace } from "@multiremi/core/types";
import { useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { ScmConnectionsSection } from "./scm-connections-section";

type SettingsKey =
  | "scm_change_sidebar_enabled"
  | "scm_auto_link_enabled"
  | "scm_complete_issue_on_merge_enabled"
  | "co_authored_by_enabled";

export function SourceControlTab() {
  const { t } = useT("settings");
  const workspace = useCurrentWorkspace();
  const wsId = useWorkspaceId();
  const queryClient = useQueryClient();
  const navigation = useNavigation();
  const workspacePaths = useWorkspacePaths();
  const user = workspaceOperatorUser;
  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const currentMember = members.find((member) => member.user_id === user?.id) ?? null;
  const canManage = currentMember?.role === "owner" || currentMember?.role === "admin";
  const settings = deriveScmSettings(workspace);
  const [savingKey, setSavingKey] = useState<SettingsKey | null>(null);

  async function persistSetting(key: SettingsKey, next: boolean) {
    if (!workspace || savingKey) return;
    setSavingKey(key);
    try {
      const merged = {
        ...((workspace.settings as Record<string, unknown>) ?? {}),
        [key]: next,
      };
      const updated = await api.updateWorkspace(workspace.id, { settings: merged });
      queryClient.setQueryData(workspaceKeys.list(), (old: Workspace[] | undefined) =>
        old?.map((candidate) => (candidate.id === updated.id ? updated : candidate)),
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t(($) => $.source_control.toast_failed));
    } finally {
      setSavingKey(null);
    }
  }

  if (!workspace) return null;

  return (
    <div className="space-y-8">
      <p className="text-sm text-muted-foreground">
        {t(($) => $.source_control.page_description)}
      </p>

      <ScmConnectionsSection workspaceId={wsId} canManage={canManage} />

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold">{t(($) => $.source_control.section_collaboration)}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t(($) => $.source_control.section_collaboration_description)}
          </p>
        </div>
        <Card>
          <CardContent className="space-y-4">
            <FeatureRow
              id="scm-change-sidebar"
              icon={<PanelRight className="size-4" />}
              label={t(($) => $.source_control.feature_change_sidebar_label)}
              description={t(($) => $.source_control.feature_change_sidebar_description)}
              checked={settings.changeSidebar}
              disabled={!canManage || savingKey === "scm_change_sidebar_enabled"}
              onCheckedChange={(value) => persistSetting("scm_change_sidebar_enabled", value)}
            />
            <FeatureRow
              id="scm-auto-link"
              icon={<Link2 className="size-4" />}
              label={t(($) => $.source_control.feature_auto_link_label)}
              description={t(($) => $.source_control.feature_auto_link_description)}
              checked={settings.autoLink}
              disabled={!canManage || savingKey === "scm_auto_link_enabled"}
              onCheckedChange={(value) => persistSetting("scm_auto_link_enabled", value)}
            />
            <FeatureRow
              id="scm-complete-on-merge"
              icon={<CheckCircle2 className="size-4" />}
              label={t(($) => $.source_control.feature_complete_on_merge_label)}
              description={t(($) => $.source_control.feature_complete_on_merge_description)}
              checked={settings.completeIssueOnMerge}
              disabled={!canManage || savingKey === "scm_complete_issue_on_merge_enabled"}
              onCheckedChange={(value) =>
                persistSetting("scm_complete_issue_on_merge_enabled", value)
              }
            />
          </CardContent>
        </Card>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold">{t(($) => $.source_control.section_commits)}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t(($) => $.source_control.section_commits_description)}
          </p>
        </div>
        <Card>
          <CardContent>
            <FeatureRow
              id="scm-coauthor"
              icon={<GitCommitHorizontal className="size-4" />}
              label={t(($) => $.source_control.feature_co_author_label)}
              description={t(($) => $.source_control.co_author_description)}
              checked={settings.coAuthor}
              disabled={!canManage || savingKey === "co_authored_by_enabled"}
              onCheckedChange={(value) => persistSetting("co_authored_by_enabled", value)}
            />
            <CoAuthorForm key={workspace.id} workspace={workspace} canManage={canManage} enabled={settings.coAuthor} />
          </CardContent>
        </Card>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">{t(($) => $.source_control.section_repositories)}</h2>
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-medium">
              {t(($) => $.source_control.repositories_shortcut_label)}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigation.push(workspacePaths.repositories())}
            >
              <ExternalLink className="size-3.5" />
              {t(($) => $.source_control.repositories_shortcut_link)}
            </Button>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function FeatureRow({
  id,
  icon,
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  icon: React.ReactNode;
  label: string;
  description: React.ReactNode;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex min-w-0 items-start gap-3">
        <div className="rounded-md border bg-muted/50 p-2 text-muted-foreground">{icon}</div>
        <div className="min-w-0 space-y-1">
          <Label htmlFor={id} className="text-sm font-medium">
            {label}
          </Label>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}

function CoAuthorForm({ workspace, canManage, enabled }: { workspace: Workspace; canManage: boolean; enabled: boolean }) {
  const { t } = useT("settings");
  const queryClient = useQueryClient();
  const identity = deriveScmSettings(workspace);
  const [draft, setDraft] = useState<{ name: string; email: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const name = draft?.name ?? identity.coAuthorName;
  const email = draft?.email ?? identity.coAuthorEmail;
  const validName = validateCoAuthoredByName(name);
  const validEmail = validateCoAuthoredByEmail(email);
  const dirty = name !== identity.coAuthorName || email !== identity.coAuthorEmail;
  async function save(reset: boolean) {
    if (!canManage || saving || (!reset && (!validName.ok || !validEmail.ok))) return;
    setSaving(true);
    try {
      const updated = await api.updateWorkspace(workspace.id, { settings: {
        ...workspace.settings,
        co_authored_by_name: reset ? null : validName.ok ? validName.value : name,
        co_authored_by_email: reset ? null : validEmail.ok ? validEmail.value : email,
      } });
      queryClient.setQueryData(workspaceKeys.list(), (old: Workspace[] | undefined) => old?.map((item) => item.id === updated.id ? updated : item));
      setDraft(reset ? { ...DEFAULT_CO_AUTHORED_BY } : null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t(($) => $.source_control.toast_failed));
    } finally { setSaving(false); }
  }
  return <div className="mt-4 space-y-3">
    <Label htmlFor="coauthor-name">{t(($) => $.source_control.co_author_name)}</Label>
    <Input id="coauthor-name" value={name} readOnly={!canManage} disabled={saving} aria-invalid={!validName.ok} onChange={(event) => setDraft({ name: event.target.value, email })} />
    {!validName.ok && <p role="alert" className="text-sm text-destructive">{t(($) => $.source_control.co_author_invalid_name)}</p>}
    <Label htmlFor="coauthor-email">{t(($) => $.source_control.co_author_email)}</Label>
    <Input id="coauthor-email" value={email} readOnly={!canManage} disabled={saving} aria-invalid={!validEmail.ok} onChange={(event) => setDraft({ name, email: event.target.value })} />
    {!validEmail.ok && <p role="alert" className="text-sm text-destructive">{t(($) => $.source_control.co_author_invalid_email)}</p>}
    <code className={`block break-all text-xs ${enabled ? "" : "text-muted-foreground opacity-50"}`}>{formatCoAuthoredByTrailer({ name: validName.ok ? validName.value : name, email: validEmail.ok ? validEmail.value : email })}</code>
    {!enabled && <p className="text-xs text-muted-foreground">{t(($) => $.source_control.co_author_disabled)}</p>}
    <div className="flex gap-2">
      <Button disabled={!canManage || saving || !dirty || !validName.ok || !validEmail.ok} onClick={() => save(false)}>{t(($) => $.source_control.co_author_save)}</Button>
      <Button variant="outline" disabled={!canManage || saving} onClick={() => save(true)}>{t(($) => $.source_control.co_author_reset)}</Button>
    </div>
  </div>;
}
