"use client";

import { useQuery } from "@tanstack/react-query";
import { feishuEndpointsOptions, feishuSourcesOptions } from "@multiremi/core/feishu";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useT } from "../../i18n";
import { useImWorkspaceAccess } from "../workspace-access";
import { ImLoadError } from "../load-error";
import { EndpointPanel } from "./ingestion/endpoint-panel";
import { MessageSection } from "./ingestion/message-section";
import { SourceSection } from "./ingestion/source-section";

/** Connection and source configuration are administrator-only. Message reads
 * have a separate member-visible contract and mount on their own route. */
export function FeishuIngestionPanel() {
  const workspaceId = useWorkspaceId();
  const access = useImWorkspaceAccess(workspaceId);
  const endpoints = useQuery(feishuEndpointsOptions(workspaceId, access.canManage));
  const sources = useQuery(feishuSourcesOptions(workspaceId, access.canManage));
  if (access.isError) return <ImLoadError retry={() => void access.refetch()} />;
  const connections = endpoints.data?.endpoints ?? [];
  return <div className="space-y-8">
    {(connections.length ? connections : [null]).map((endpoint, index) => <EndpointPanel
      key={endpoint?.name ?? "empty"}
      permitted={access.canManage}
      configured={endpoints.data?.configured === true}
      endpoint={endpoint}
      loading={access.isPending || (access.canManage && endpoints.isPending)}
      refreshFailed={endpoints.isError}
      workspaceId={workspaceId}
      showCreateConnection={index === 0}
    />)}
    {sources.isError ? <ImLoadError retry={() => void sources.refetch()} /> : <SourceSection
      permitted={access.canManage}
      workspaceId={workspaceId}
      sources={sources.data?.sources ?? []}
      endpoints={connections}
      loading={access.isPending || (access.canManage && sources.isPending)}
    />}
  </div>;
}

export function FeishuMessagesPanel() {
  const { t } = useT("im-platforms");
  const workspaceId = useWorkspaceId();
  const access = useImWorkspaceAccess(workspaceId);
  const sources = useQuery(feishuSourcesOptions(workspaceId, access.canManage));
  if (access.isPending) return <p role="status">{t($ => $.page.loading)}</p>;
  if (access.isError) return <ImLoadError retry={() => void access.refetch()} />;
  return <div className="space-y-4">
    {sources.isError && <ImLoadError retry={() => void sources.refetch()} />}
    <MessageSection workspaceId={workspaceId} sources={sources.data?.sources ?? []} />
  </div>;
}
