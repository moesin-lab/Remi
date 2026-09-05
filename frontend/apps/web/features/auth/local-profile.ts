/** Local profile login is an explicit UI option; API token validation still applies. */
export function allowsLocalTokenLogin(profile: string | undefined, hostname: string): boolean {
  return (profile === "dev" || profile === "stable")
    && (hostname === "localhost" || hostname === "127.0.0.1");
}

/** Password UI uses the same local boundary; the API independently gates login. */
export function allowsPasswordLogin(profile: string | undefined, hostname: string): boolean {
  return allowsLocalTokenLogin(profile, hostname);
}
