"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useWorkspacePaths } from "@multiremi/core/paths";

/** The shared workspace has one issue collection. Preserve old bookmarks. */
export default function Page() {
  const router = useRouter();
  const paths = useWorkspacePaths();
  useEffect(() => { router.replace(paths.issues()); }, [router, paths]);
  return null;
}
