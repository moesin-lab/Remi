/** Product navigation capabilities, distinct from transport/provider capabilities.
 * A platform owns its pages; connections, routing and message ingestion keep
 * their existing domain contracts and workspace-scoped query caches.
 */
export const IM_SECTIONS = ["overview", "bot", "access", "conversations", "ingestion", "messages"] as const;
export type ImSection = (typeof IM_SECTIONS)[number];

export const IM_PLATFORMS = [
  { id: "feishu", sections: IM_SECTIONS },
] as const;
export type ImPlatformId = (typeof IM_PLATFORMS)[number]["id"];
export type ImPlatform = (typeof IM_PLATFORMS)[number];

export function getImPlatform(id: string): ImPlatform | undefined {
  return IM_PLATFORMS.find(platform => platform.id === id);
}

export function resolveImSection(platform: ImPlatform, segments: readonly string[] = []): ImSection | undefined {
  if (segments.length === 0) return "overview";
  if (segments.length !== 1) return undefined;
  return platform.sections.find(section => section === segments[0]);
}

/** Compatibility for bookmarks. Only these retired Settings tabs move. */
export function legacyImDestination(tab: string | null): { platform: ImPlatformId; section: ImSection } | undefined {
  switch (tab) {
    case "integrations":
    case "lark": return { platform: "feishu", section: "bot" };
    case "feishu-messages": return { platform: "feishu", section: "messages" };
    default: return undefined;
  }
}
