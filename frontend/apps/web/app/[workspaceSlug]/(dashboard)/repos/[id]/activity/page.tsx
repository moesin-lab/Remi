"use client";

import { use } from "react";
import { RepositoryActivityPage } from "@multiremi/views/repositories";

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <RepositoryActivityPage key={id} repositoryId={id} />;
}
