/** Named, additive daemon features. No feature is inferred from a build/CLI version.
 * `introduced` records the source release version when the name was added; null contract means no removal planned.
 * Keep aliases until an explicit contract release removes the old spelling.
 */
export const DAEMON_CAPABILITY_REGISTRY = {
  offer: { aliases: [], introduced: "0.2.82", contract: null },
  "turn.restart": { aliases: [], introduced: "0.2.96", contract: null },
  "turn.message": { aliases: [], introduced: "0.2.90", contract: null },
  "input.unread": { aliases: ["input_unread"], introduced: "0.2.95", contract: null },
  "trace.read": { aliases: [], introduced: "0.2.82", contract: null },
  "trace.subscribe": { aliases: [], introduced: "0.2.82", contract: null },
  "wiki.fetch": { aliases: [], introduced: "0.2.85", contract: null },
  "lane.background": { aliases: [], introduced: "0.2.90", contract: null },
  "prompt.policy.v1": { aliases: [], introduced: "0.2.95", contract: null },
  "prompt.policy.adopt.v1": { aliases: [], introduced: "0.2.95", contract: null },
} as const;

export type DaemonCapabilityName = keyof typeof DAEMON_CAPABILITY_REGISTRY;

export function daemonCapabilityName(value: string): DaemonCapabilityName | null {
  for (const [name, entry] of Object.entries(DAEMON_CAPABILITY_REGISTRY)) {
    if (value === name || (entry.aliases as readonly string[]).includes(value)) return name as DaemonCapabilityName;
  }
  return null;
}

export function hasDaemonCapability(caps: readonly string[], name: string): boolean {
  const canonical = daemonCapabilityName(name);
  return canonical !== null && caps.some(cap => daemonCapabilityName(cap) === canonical);
}

/** First hello has no peer capabilities yet: use the oldest supported spelling. */
export function daemonCapabilityWireName(name: string): string {
  const canonical = daemonCapabilityName(name);
  if (!canonical) return name;
  return DAEMON_CAPABILITY_REGISTRY[canonical].aliases[0] ?? canonical;
}

/** Only this reviewed contract ledger may advance the admission floor. */
export const DAEMON_CONTRACT_RELEASES = [
  { version: "0.2.90", minCliVersion: "0.2.90", reason: "turn + items trace (ADR 0019)" },
] as const;
