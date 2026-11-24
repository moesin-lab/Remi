"use client";

import { useEffect } from "react";
import { useWorkspacePaths } from "@multiremi/core/paths";
import { useNavigation } from "../../navigation";

export function MyIssuesPage() {
  const { replace } = useNavigation();
  const paths = useWorkspacePaths();
  useEffect(() => { replace(paths.issues()); }, [replace, paths]);
  return null;
}
