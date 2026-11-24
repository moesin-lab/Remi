"use client";
import { workspaceOperatorUser } from "@multiremi/core/workspace/operator";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Activity, Save, Sparkles } from "lucide-react";
import { Button } from "@multiremi/ui/components/ui/button";
import { Card, CardContent } from "@multiremi/ui/components/ui/card";
import { Label } from "@multiremi/ui/components/ui/label";
import { Switch } from "@multiremi/ui/components/ui/switch";
import { SystemModelInput } from "./system-model-input";
import { titleGatewayProtocol } from "./relay-fragment-format";
import { NativeSelect, NativeSelectOption } from "@multiremi/ui/components/ui/native-select";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@multiremi/ui/components/ui/select";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useCurrentWorkspace, useWorkspacePaths } from "@multiremi/core/paths";
import { executionEndpointListOptions, type ExecutionEndpoint, type SystemProtocol } from "@multiremi/core/runtimes";
import { memberListOptions, workspaceKeys } from "@multiremi/core/workspace/queries";
import { api } from "@multiremi/core/api";
import type { Workspace } from "@multiremi/core/types";
import { useT } from "../../i18n";
import { AppLink } from "../../navigation";

type ProgressSummaryTransport = "auto" | "api" | "cli" | "openai";

interface ProgressSummarySettings {
  transport: ProgressSummaryTransport;
  model: string;
  openAiModel: string;
}

interface IssueAutoTitleSettings {
  enabled: boolean;
  model: string;
}


/** Legacy settings URL retained; endpoint editing now lives alongside execution groups. */
export function ModelGatewayTab() {
  const { t } = useT("settings");
  const wsId = useWorkspaceId();
  const workspace = useCurrentWorkspace();
  const paths = useWorkspacePaths();
  const qc = useQueryClient();
  const members = useQuery(memberListOptions(wsId));
  const canManage = members.data?.some(member => member.user_id === workspaceOperatorUser?.id && ["owner", "admin"].includes(member.role)) ?? false;
  const endpoints = useQuery({ ...executionEndpointListOptions(wsId), enabled: !!wsId && canManage });
  const defaults = useQuery({ queryKey: ["system-model-endpoints", wsId], queryFn: () => api.getSystemModelEndpoints(wsId), enabled: !!wsId && canManage });
  const bound = (protocol: SystemProtocol) => endpoints.data?.endpoints.find(endpoint => endpoint.id === defaults.data?.defaults[protocol]
    && endpoint.connection.auth_mode === "api_key" && endpoint.connection.protocols.includes(protocol));
  const chat = bound("openai-chat-completions");
  const messages = bound("anthropic-messages");
  const relay = useQuery({ queryKey: ["system-model-relay", wsId, chat?.id, chat?.revision, messages?.id, messages?.revision],
    queryFn: () => api.getRelayConfig(wsId), enabled: !!wsId && canManage && !!(chat || messages) });
  const titleProtocol = titleGatewayProtocol(relay.data);
  const titleRoute = titleProtocol && bound(titleProtocol);
  const titleEndpoint = !relay.isError && !relay.isFetching && titleRoute?.connection.credential_id ? titleRoute : undefined;
  const pending = endpoints.isPending || defaults.isPending;
  const [saving, setSaving] = useState(false);
  if (members.isPending) return <div data-testid="model-gateway-skeleton" aria-busy="true" />;
  if (!canManage) return <p>{t($ => $.modelGateway.insufficient)}</p>;
  const change = async (protocol: string, value: string) => {
    setSaving(true);
    try {
      const result = await api.saveSystemModelEndpoints(wsId, { [protocol]: value === "none" ? null : value });
      qc.setQueryData(["system-model-endpoints", wsId], result);
    } catch (error) { toast.error(error instanceof Error ? error.message : t($ => $.modelGateway.save_failed)); }
    finally { setSaving(false); }
  };
  return <div className="space-y-8">
    <section className="space-y-3">
      <h2 className="text-sm font-semibold">{t($ => $.modelGateway.system_title)}</h2>
      <p className="text-sm text-muted-foreground">{t($ => $.modelGateway.system_description)}</p>
      <AppLink className="text-sm text-primary underline" href={paths.executionGroups()}>{t($ => $.modelGateway.manage_endpoints)}</AppLink>
      {endpoints.isError || defaults.isError ? <p role="alert">{t($ => $.modelGateway.save_failed)}</p>
        : endpoints.isPending || defaults.isPending ? <div data-testid="model-gateway-skeleton" aria-busy="true" />
          : (["openai-chat-completions", "anthropic-messages"] as const).map(protocol => <label key={protocol} className="block space-y-1 text-sm">
            <span>{protocol}</span>
            <NativeSelect aria-label={protocol} disabled={saving} value={defaults.data.defaults[protocol] ?? "none"} onChange={event => void change(protocol, event.target.value)}>
              <NativeSelectOption value="none">{t($ => $.modelGateway.no_endpoint)}</NativeSelectOption>
              {endpoints.data.endpoints.filter(endpoint => endpoint.connection.auth_mode === "api_key" && endpoint.connection.protocols.includes(protocol))
                .map(endpoint => <NativeSelectOption key={endpoint.id} value={endpoint.id}>{endpoint.name}</NativeSelectOption>)}
            </NativeSelect>
          </label>)}
    </section>
    {workspace?.id === wsId && <ProgressSummarySection key={`summary-${wsId}`} workspace={workspace} chat={chat} messages={messages} pending={pending} />}
    {workspace?.id === wsId && <IssueAutoTitleSection key={`title-${wsId}`} workspace={workspace} endpoint={titleEndpoint} protocol={titleProtocol ?? "openai-chat-completions"} pending={pending || relay.isFetching} />}
  </div>;
}

function IssueAutoTitleSection({ workspace, endpoint, protocol, pending }: { workspace: Workspace; endpoint?: ExecutionEndpoint; protocol: SystemProtocol; pending: boolean }) {
  const { t } = useT("settings");
  const qc = useQueryClient();
  const resolved = readIssueAutoTitleSettings(workspace.settings);
  const [enabled, setEnabled] = useState(resolved.enabled);
  const [model, setModel] = useState(resolved.model);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const next = readIssueAutoTitleSettings(workspace.settings);
    setEnabled(next.enabled);
    setModel(next.model);
  }, [workspace.settings]);

  async function save() {
    setSaving(true);
    try {
      const updated = await api.updateWorkspace(workspace.id, {
        settings: {
          ...(workspace.settings ?? {}),
          issue_auto_title: {
            enabled,
            model: model.trim() || "gpt-5.6-luna",
          },
        },
      });
      qc.setQueryData(workspaceKeys.list(), (old: Workspace[] | undefined) =>
        old?.map((candidate) => candidate.id === updated.id ? updated : candidate),
      );
      toast.success(t(($) => $.modelGateway.auto_title_saved));
    } catch (error) {
      toast.error(error instanceof Error
        ? error.message
        : t(($) => $.modelGateway.save_failed));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-3">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          {t(($) => $.modelGateway.auto_title_title)}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {t(($) => $.modelGateway.auto_title_description)}
        </p>
      </div>
      <Card>
        <CardContent className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <Label htmlFor="issue-auto-title-enabled">
                {t(($) => $.modelGateway.auto_title_enabled_label)}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t(($) => $.modelGateway.auto_title_enabled_hint)}
              </p>
            </div>
            <Switch
              id="issue-auto-title-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="issue-auto-title-model">
              {t(($) => $.modelGateway.auto_title_model_label)}
            </Label>
            <SystemModelInput workspaceId={workspace.id} endpoint={endpoint} protocol={protocol} pending={pending}
              id="issue-auto-title-model"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder="gpt-5.6-luna"
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              {t(($) => $.modelGateway.auto_title_model_hint)}
            </p>
          </div>
          <div className="flex justify-end pt-1">
            <Button type="button" size="sm" onClick={save} disabled={saving}>
              <Save className="h-3.5 w-3.5" />
              {saving
                ? t(($) => $.modelGateway.saving)
                : t(($) => $.modelGateway.auto_title_save)}
            </Button>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

function ProgressSummarySection({ workspace, chat, messages, pending }: { workspace: Workspace; chat?: ExecutionEndpoint; messages?: ExecutionEndpoint; pending: boolean }) {
  const { t } = useT("settings");
  const qc = useQueryClient();
  const resolved = readProgressSummarySettings(workspace.settings);
  const [transport, setTransport] = useState<ProgressSummaryTransport>(resolved.transport);
  const [model, setModel] = useState(resolved.model);
  const [openAiModel, setOpenAiModel] = useState(resolved.openAiModel);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const next = readProgressSummarySettings(workspace.settings);
    setTransport(next.transport);
    setModel(next.model);
    setOpenAiModel(next.openAiModel);
  }, [workspace.settings]);

  async function save() {
    setSaving(true);
    try {
      const progressSummary: Record<string, string> = { transport };
      const normalizedModel = model.trim();
      const normalizedOpenAiModel = openAiModel.trim();
      if (normalizedModel) progressSummary.model = normalizedModel;
      if (normalizedOpenAiModel) progressSummary.openai_model = normalizedOpenAiModel;
      const updated = await api.updateWorkspace(workspace.id, {
        settings: {
          ...(workspace.settings ?? {}),
          progress_summary: progressSummary,
        },
      });
      qc.setQueryData(workspaceKeys.list(), (old: Workspace[] | undefined) =>
        old?.map((candidate) => candidate.id === updated.id ? updated : candidate),
      );
      toast.success(t(($) => $.modelGateway.progress_saved));
    } catch (error) {
      toast.error(error instanceof Error
        ? error.message
        : t(($) => $.modelGateway.save_failed));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-3">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Activity className="h-4 w-4 text-muted-foreground" />
          {t(($) => $.modelGateway.progress_title)}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {t(($) => $.modelGateway.progress_description)}
        </p>
      </div>
      <Card>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="progress-summary-transport">
              {t(($) => $.modelGateway.progress_transport_label)}
            </Label>
            <Select
              value={transport}
              onValueChange={(value) => setTransport(value as ProgressSummaryTransport)}
            >
              <SelectTrigger id="progress-summary-transport" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t(($) => $.modelGateway.progress_transport_auto)}</SelectItem>
                <SelectItem value="openai">{t(($) => $.modelGateway.progress_transport_openai)}</SelectItem>
                <SelectItem value="api">{t(($) => $.modelGateway.progress_transport_api)}</SelectItem>
                <SelectItem value="cli">{t(($) => $.modelGateway.progress_transport_cli)}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="progress-summary-openai-model">
                {t(($) => $.modelGateway.progress_openai_model_label)}
              </Label>
              <SystemModelInput workspaceId={workspace.id} endpoint={chat} protocol="openai-chat-completions" pending={pending} inactive={transport !== "auto" && transport !== "openai"}
                id="progress-summary-openai-model"
                value={openAiModel}
                onChange={(event) => setOpenAiModel(event.target.value)}
                placeholder="gpt-5.6-luna"
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                {t(($) => $.modelGateway.progress_openai_model_hint)}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="progress-summary-claude-model">
                {t(($) => $.modelGateway.progress_claude_model_label)}
              </Label>
              <SystemModelInput workspaceId={workspace.id} endpoint={messages} protocol="anthropic-messages" pending={pending} inactive={transport !== "auto" && transport !== "api"}
                id="progress-summary-claude-model"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="claude-haiku-4-5-20251001"
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                {t(($) => $.modelGateway.progress_claude_model_hint)}
              </p>
            </div>
          </div>
          {transport === "cli" && <p className="text-xs text-muted-foreground">{t($ => $.modelGateway.catalog_cli)}</p>}
          <div className="flex justify-end pt-1">
            <Button type="button" size="sm" onClick={save} disabled={saving}>
              <Save className="h-3.5 w-3.5" />
              {saving
                ? t(($) => $.modelGateway.saving)
                : t(($) => $.modelGateway.progress_save)}
            </Button>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

function readProgressSummarySettings(
  settings: Record<string, unknown> | undefined,
): ProgressSummarySettings {
  const raw = settings?.progress_summary ?? settings?.progressSummary;
  const progress = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const transport = typeof progress.transport === "string"
    && ["auto", "api", "cli", "openai"].includes(progress.transport)
    ? progress.transport as ProgressSummaryTransport
    : "auto";
  const openAiModel = progress.openai_model ?? progress.openAiModel;
  return {
    transport,
    model: typeof progress.model === "string" ? progress.model : "",
    openAiModel: typeof openAiModel === "string" ? openAiModel : "",
  };
}

function readIssueAutoTitleSettings(
  settings: Record<string, unknown> | undefined,
): IssueAutoTitleSettings {
  const raw = settings?.issue_auto_title;
  const autoTitle = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  return {
    enabled: typeof autoTitle.enabled === "boolean" ? autoTitle.enabled : true,
    model: typeof autoTitle.model === "string" && autoTitle.model.trim()
      ? autoTitle.model
      : "gpt-5.6-luna",
  };
}
