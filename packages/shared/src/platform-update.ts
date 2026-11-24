/** Update sources are administrator-controlled HTTPS feeds, never shell commands. */
export function validateReleaseFeedUrl(value: unknown): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 2048) throw new Error("releaseFeedUrl must be an HTTPS URL or null");
  const url = new URL(value.trim());
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("releaseFeedUrl must use HTTPS without credentials or a fragment");
  }
  return url.href;
}
