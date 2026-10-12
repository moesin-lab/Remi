"use client";

import type { Project, UpdateProjectRequest } from "@multiremi/core/types";
import { useActorName } from "@multiremi/core/workspace/hooks";

/** Existing project contacts are attribution only; new projects need no person. */
export function ProjectLeadPicker({ project }: {
  project: Project;
  handleUpdate: (data: UpdateProjectRequest) => void;
  renderTrigger: (leadName: string | null) => React.ReactElement;
  align?: "start" | "end" | "center";
}) {
  const { getActorName } = useActorName();
  if (!project.lead_type || !project.lead_id) return null;
  return <span className="truncate text-xs text-muted-foreground">{getActorName(project.lead_type, project.lead_id)}</span>;
}
