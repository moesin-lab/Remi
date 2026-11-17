import { resolveCoAuthoredByIdentity } from "@multiremi/contracts/co-authored-by";
import type { Workspace } from "../types";

export interface ScmSettings {
  changeSidebar: boolean;
  autoLink: boolean;
  completeIssueOnMerge: boolean;
  coAuthor: boolean;
  coAuthorName: string;
  coAuthorEmail: string;
}

export function deriveScmSettings(
  workspace: Pick<Workspace, "settings"> | null | undefined,
): ScmSettings {
  const settings = (workspace?.settings ?? {}) as Record<string, unknown>;
  const identity = resolveCoAuthoredByIdentity(settings);
  return {
    coAuthorName: identity.name,
    coAuthorEmail: identity.email,
    changeSidebar: settings.scm_change_sidebar_enabled !== false,
    autoLink: settings.scm_auto_link_enabled !== false,
    completeIssueOnMerge: settings.scm_complete_issue_on_merge_enabled === true,
    coAuthor: settings.co_authored_by_enabled !== false,
  };
}
