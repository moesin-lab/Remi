/** Local profile login is an explicit UI option; API token validation still applies. */
export function allowsLocalTokenLogin(profile: string | undefined, hostname: string): boolean {
  return (profile === "dev" || profile === "stable")
    && (hostname === "localhost" || hostname === "127.0.0.1");
}
