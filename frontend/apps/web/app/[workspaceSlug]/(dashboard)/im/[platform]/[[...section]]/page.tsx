import { notFound, redirect } from "next/navigation";
import { getImPlatform, resolveImSection } from "@multiremi/core/im-platforms";
import { paths } from "@multiremi/core/paths";
import { ImPlatformPage } from "@multiremi/views/im-platforms";

export default async function Page({ params }: { params: Promise<{ workspaceSlug: string; platform: string; section?: string[] }> }) {
  const route = await params;
  const platform = getImPlatform(route.platform);
  if (!platform) notFound();
  const section = resolveImSection(platform, route.section);
  if (!section) notFound();
  if (route.section?.[0] === "overview") redirect(paths.workspace(route.workspaceSlug).imPlatform(platform.id));
  return <ImPlatformPage platformId={platform.id} section={section} />;
}
