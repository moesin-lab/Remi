"use client";

import { use } from "react";
import { ProjectActivityPage } from "@multiremi/views/projects/components";

export default function Page({ params }: { params: Promise<{ workspaceSlug: string; id: string }> }) {
  const { workspaceSlug, id } = use(params);
  return <ProjectActivityPage key={JSON.stringify([workspaceSlug, id])} projectId={id} />;
}
