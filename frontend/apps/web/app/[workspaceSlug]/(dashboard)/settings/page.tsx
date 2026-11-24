import { SettingsPage } from "@multiremi/views/settings";
import { redirect } from "next/navigation";
import { legacyImDestination } from "@multiremi/core/im-platforms";
import { paths } from "@multiremi/core/paths";

export default async function Page({ params, searchParams }: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [route, search] = await Promise.all([params, searchParams]);
  const tab = Array.isArray(search.tab) ? search.tab[0] : search.tab;
  const destination = legacyImDestination(tab ?? null);
  if (destination) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(search)) {
      if (key === "tab" || value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) query.append(key, item);
    }
    const href = paths.workspace(route.workspaceSlug).imPlatform(destination.platform, destination.section);
    redirect(query.size ? `${href}?${query}` : href);
  }
  return <SettingsPage />;
}
