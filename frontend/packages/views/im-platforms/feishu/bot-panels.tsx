"use client";

import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { feishuBotCandidatesOptions } from "@multiremi/core/feishu-bot/queries";
import { useT } from "../../i18n";
import { useImWorkspaceAccess } from "../workspace-access";
import { ImLoadError } from "../load-error";
import { FeishuBotSection } from "./feishu-bot-section";
import { BotMenuSection } from "./bot-menu-section";
import { LarkTab } from "./lark-tab";
import { FeishuSenderAllowlistSection } from "./feishu-sender-allowlist-section";
import { FeishuBotRoutes } from "./feishu-bot-routes";
import { IssueTopicSection } from "./issue-topic-section";

export function FeishuBotPanel() {
  return <div className="space-y-8"><FeishuBotSection /><BotMenuSection /><LarkTab /></div>;
}

export function FeishuAccessPanel() {
  const { t } = useT("im-platforms");
  const access = useImWorkspaceAccess(useWorkspaceId());
  if (access.isPending) return <p role="status">{t($ => $.page.loading)}</p>;
  if (access.isError) return <ImLoadError retry={() => void access.refetch()} />;
  if (!access.canManage) return <p className="text-sm text-muted-foreground">{t($ => $.page.readOnly)}</p>;
  return <FeishuSenderAllowlistSection />;
}

export function FeishuConversationsPanel() {
  const { t } = useT("im-platforms");
  const wsId = useWorkspaceId();
  const access = useImWorkspaceAccess(wsId);
  const candidates = useQuery(feishuBotCandidatesOptions(wsId, access.canManage));
  if (access.isPending) return <p role="status">{t($ => $.page.loading)}</p>;
  if (access.isError) return <ImLoadError retry={() => void access.refetch()} />;
  return <div className="space-y-8">
    {access.canManage ? candidates.isError
      ? <ImLoadError retry={() => void candidates.refetch()} />
      : <FeishuBotRoutes workspaceId={wsId} candidates={candidates.data ?? null} candidatesPending={candidates.isPending} />
      : <p className="text-sm text-muted-foreground">{t($ => $.page.readOnly)}</p>}
    <IssueTopicSection />
  </div>;
}
