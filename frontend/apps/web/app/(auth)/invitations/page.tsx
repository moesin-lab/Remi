"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Workspace invitations no longer apply; login and workspace selection live at the root. */
export default function Page() {
  const router = useRouter();
  useEffect(() => { router.replace("/"); }, [router]);
  return null;
}
